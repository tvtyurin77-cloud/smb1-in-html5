import * as JSNES_PKG from "jsnes";

const DEFAULT_CONTROL_BINDINGS = {
  UP: ["KeyW"], DOWN: ["KeyS"], LEFT: ["KeyA"], RIGHT: ["KeyD"],
  A: ["KeyZ", "KeyJ", "Space"], B: ["KeyK", "ShiftLeft"],
  START: ["Enter"], SELECT: ["KeyX", "ShiftRight"],
};
const CONTROL_CODES = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 };

export class Emulator {
  constructor(opts) {
    this.canvas = opts.canvas;
    this.onStatus = opts.onStatus || (() => {});
    this.onButtonDown = opts.onButtonDown || (() => {});
    this.onButtonChange = opts.onButtonChange || (() => {});
    this.onLogicalFrame = opts.onLogicalFrame || (() => {});
    this.controlBindings = this.loadControlBindings();
    this.isCapturingControl = false;
    this.audioCtx = null;
    this.scriptNode = null;
    this.audioBufferL = [];
    this.audioBufferR = [];
    this.isMuted = false;
    this.isMusicSilenced = false;
    this.volume = 0.6;
    this.corruptionCount = 0;
    this.corruptionLimit = 15;
    this.romData = null;
    this.currentRomUrl = "";
    this.marioLivesSet = false;
    this.pendingSMBTime = null;
    this.smbWorldTableOffset = -1;
    this.questionBlockOneUpChance = 25;
    this.questionBlockReward = "default";
    this.questionBlockPowerUpActive = false;
    this.questionBlockLives = 1;
    this.playerAbilities = { fly: false, noclip: false, immortal: false };
    this.movementMode = "default";
    this.koopaWakeTicks = 16;
    this.previousLives = null;
    this.koopaSleepState = new Uint8Array(6);
    this.spriteColor = "default";
    this.spriteTexture = "normal";
    this.retroMode = false;
    this.theme = "classic";
    this.jumpHeight = 1;
    this.warpAllPipes = false;
    this.warpTargetWorld = 1;
    this.spritePaletteOriginal = null;
    this.spriteChrOriginal = null;
    this.themePaletteOriginal = null;
    this.themePaletteApplied = null;
    this.backgroundMusic = null;
    this.isRunning = false;
    this.onFPSUpdate = opts.onFPSUpdate || (() => {});

    // Timing & speed control
    this.speed = 1; // 0.5 = slow, 1 = normal, 2 = fast, etc.
    this.lastFrameTime = null;
    this.frameAccumulator = 0;

    // Rewind buffer (store periodic save states)
    // Optimized: reduced frequency and count to save memory on lower-end devices
    this.rewindBuffer = [];
    this.rewindInterval = 20;     // save every 20 frames (~3 times per sec)
    this.rewindMaxStates = 30;    // keep last 10 seconds worth
    this.frameCount = 0;
    this.isRewinding = false;

    this.ctx = this.canvas.getContext("2d", { alpha: false });
    this.imageData = null;
    this.animationFrame = null;

    // FPS Tracking
    this.fpsCounter = 0;
    this.cpsCounter = 0;
    this.spsFrameCounter = 0;
    this.fpsLastTime = 0;

    // Bind frame loop once
    this.frameLoop = (timestamp) => {
      if (!this.isRunning || !this.nes) return;

      if (this.lastFrameTime == null) {
        this.lastFrameTime = timestamp;
        this.fpsLastTime = timestamp;
      }
      const dt = timestamp - this.lastFrameTime;
      this.lastFrameTime = timestamp;

      // FPS Calculation
      this.fpsCounter++;
      if (timestamp - this.fpsLastTime >= 1000) {
        const elapsedSeconds = (timestamp - this.fpsLastTime) / 1000;
        const sps = this.spsFrameCounter / 60 / elapsedSeconds;
        this.onFPSUpdate(this.fpsCounter, this.cpsCounter, sps);
        this.fpsCounter = 0;
        this.cpsCounter = 0;
        this.spsFrameCounter = 0;
        this.fpsLastTime = timestamp;
      }

      // Scale delta by speed factor
      this.frameAccumulator += dt * this.speed;

      const frameDuration = 1000 / 60; // ~16.67ms per frame
      let framesToRun = 0;
      while (this.frameAccumulator >= frameDuration) {
        this.frameAccumulator -= frameDuration;
        framesToRun++;
        // Cap catch-up work at the selected speed to prevent runaway frame loops.
        const maxFramesPerTick = Math.max(3, Math.ceil(this.speed));
        if (framesToRun > maxFramesPerTick) {
          this.frameAccumulator = 0;
          break;
        }
        this.stepFrame();
      }

      this.animationFrame = requestAnimationFrame(this.frameLoop);
    };

    // Detect NES constructor more robustly
    this.NES_C = JSNES_PKG.NES || (JSNES_PKG.default && JSNES_PKG.default.NES) || (typeof JSNES_PKG === 'function' ? JSNES_PKG : null);

    this.initAudio();
    this.reset();
    this.bindKeys();
  }

  initAudio() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        console.warn("WebAudio API not supported.");
        return;
      }
      this.audioCtx = new AudioContext();
      this.scriptNode = this.audioCtx.createScriptProcessor(2048, 0, 2);
      this.scriptNode.onaudioprocess = (e) => {
        const outL = e.outputBuffer.getChannelData(0);
        const outR = e.outputBuffer.getChannelData(1);
        const count = Math.min(this.audioBufferL.length, outL.length);
        for (let i = 0; i < count; i++) {
          const l = this.isMuted || this.isMusicSilenced ? 0 : this.audioBufferL.shift() * this.volume;
          const r = this.isMuted || this.isMusicSilenced ? 0 : this.audioBufferR.shift() * this.volume;
          outL[i] = l || 0;
          outR[i] = r || 0;
        }
        for (let i = count; i < outL.length; i++) {
          outL[i] = 0;
          outR[i] = 0;
        }
      };
      this.scriptNode.connect(this.audioCtx.destination);
    } catch (e) {
      console.error("Audio initialization error:", e);
    }
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
  }

  setMute(flag) {
    this.isMuted = !!flag;
  }

  onAudioSample(l, r) {
    // Memory safety: prevent buffer bloat if audio isn't being consumed fast enough
    if (this.audioBufferL.length > 8192) {
      this.audioBufferL.length = 0;
      this.audioBufferR.length = 0;
    }
    this.audioBufferL.push(l);
    this.audioBufferR.push(r);
  }

  drawNESFrame(frameBuffer) {
    if (!this.imageData || this.imageData.width !== 256) {
      this.imageData = this.ctx.createImageData(256, 240);
      // Pre-create a 32-bit view for faster pixel writing
      this.buf32 = new Uint32Array(this.imageData.data.buffer);
    }
    
    // Use 32-bit writes to avoid 4 individual channel assignments per pixel
    const buf32 = this.buf32;
    for (let i = 0; i < 61440; i++) { // 256 * 240
      const pixel = frameBuffer[i];
      if (this.retroMode) {
        const luminance = (((pixel & 0xFF) * 3) + (((pixel >> 8) & 0xFF) * 6) + ((pixel >> 16) & 0xFF)) / 10;
        const green = luminance < 48 ? 0 : luminance < 112 ? 42 : luminance < 184 ? 92 : 148;
        buf32[i] = 0xFF000000 | (green << 8);
      } else {
        buf32[i] = 0xFF000000 | pixel;
      }
    }
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  async loadROM(url) {
    this.currentRomUrl = url;
    this.marioLivesSet = false;
    this.pendingSMBTime = null;
    this.smbWorldTableOffset = -1;
    this.questionBlockPowerUpActive = false;
    this.spritePaletteOriginal = null;
    this.spriteChrOriginal = null;
    this.spriteColor = "default";
    this.spriteTexture = "normal";
    this.onStatus("Loading ROM...");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ROM: ${res.status}`);
    const ab = await res.arrayBuffer();
    this.loadROMData(ab);
  }

  setMarioLives() {
    if (this.marioLivesSet || !/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return;
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    if (!mem) return;
    mem[0x075A] = 98;
    this.previousLives = 98;
    this.marioLivesSet = true;
  }

  setSMBTime(seconds) {
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return null;
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    const input = Number(seconds);
    if (!mem || !Number.isFinite(input)) return null;
    const time = Math.max(0, Math.min(999, Math.floor(input)));
    mem[0x07F8] = Math.floor(time / 100);
    mem[0x07F9] = Math.floor(time / 10) % 10;
    mem[0x07FA] = time % 10;
    this.pendingSMBTime = time;
    return time;
  }

  applyPendingSMBTime() {
    if (this.pendingSMBTime === null) return;
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    if (!mem || mem[0x0770] !== 1 || mem[0x0772] < 3) return;
    const time = this.pendingSMBTime;
    mem[0x07F8] = Math.floor(time / 100);
    mem[0x07F9] = Math.floor(time / 10) % 10;
    mem[0x07FA] = time % 10;
    this.pendingSMBTime = null;
  }

  findSMBWorldTableOffset() {
    if (this.smbWorldTableOffset >= 0) return this.smbWorldTableOffset;
    const rom = new Uint8Array(this.romData || 0);
    const signature = [0, 5, 10, 14, 19, 23, 27, 32, 0x25, 0x29, 0xC0, 0x26, 0x60];
    for (let i = 0; i <= rom.length - signature.length; i++) {
      if (signature.every((value, index) => rom[i + index] === value)) {
        this.smbWorldTableOffset = i;
        return i;
      }
    }
    return -1;
  }

  corruptSMBWorldLayout() {
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    const prgRom = this.nes && this.nes.rom && this.nes.rom.rom;
    const tableOffset = this.findSMBWorldTableOffset();
    if (!mem || !prgRom || tableOffset < 0 || !this.romData) {
      this.onStatus("Load the original Super Mario Bros. ROM to corrupt its world tables.");
      return false;
    }

    const romBytes = new Uint8Array(this.romData);
    const prgStart = 16 + ((romBytes[6] & 0x04) ? 512 : 0);
    const prgOffset = tableOffset - prgStart;
    const prgBank = Math.floor(prgOffset / 0x4000);
    if (prgOffset < 0 || prgBank >= prgRom.length || 0x8000 + prgOffset > 0xFFFF) {
      this.onStatus("Could not locate the live SMB world tables.");
      return false;
    }

    const writeRomByte = (offset, value) => {
      const bank = Math.floor((offset - prgStart) / 0x4000);
      const inBank = (offset - prgStart) % 0x4000;
      const cpuAddress = 0x8000 + offset - prgStart;
      romBytes[offset] = value;
      prgRom[bank][inBank] = value;
      mem[cpuAddress] = value;
    };

    const worldStarts = [0, 5, 10, 14, 19, 23, 27, 32];
    const areaCounts = [5, 5, 4, 5, 4, 4, 5, 4];
    const worldIndex = mem[0x075F] % worldStarts.length;
    const areaCount = areaCounts[worldIndex];
    const rawWorldStart = romBytes[tableOffset + worldIndex];
    const worldStart = worldStarts.includes(rawWorldStart) ? rawWorldStart : worldStarts[worldIndex];
    const levelIndex = mem[0x075C] % areaCount;
    const areaTableOffset = tableOffset + 8;
    const firstArea = areaTableOffset + worldStart + levelIndex;
    const otherLevel = (levelIndex + 1 + ((Math.random() * (areaCount - 1)) | 0)) % areaCount;
    const otherArea = areaTableOffset + worldStart + otherLevel;
    const firstPointer = romBytes[firstArea];
    const otherPointer = romBytes[otherArea];
    writeRomByte(firstArea, otherPointer);
    writeRomByte(otherArea, firstPointer);

    const targetWorld = (Math.random() * worldStarts.length) | 0;
    const currentStart = romBytes[tableOffset + targetWorld];
    const alternatives = worldStarts.filter(start => start !== currentStart);
    const replacement = alternatives[(Math.random() * alternatives.length) | 0];
    writeRomByte(tableOffset + targetWorld, replacement);

    this.doCorrupt(64, "blockscramble");
    this.onStatus("World tables and current level block placement corrupted; Mario is untouched.");
    return true;
  }

  setSMBForm(form) {
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return null;
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    if (!mem) return null;
    const forms = {
      small: { size: 0, status: 0, star: false },
      big: { size: 1, status: 1, star: false },
      "small-fire": { size: 0, status: 2, star: false },
      "big-fire": { size: 1, status: 2, star: false },
      "star-small": { size: 0, status: 0, star: true },
      "star-big": { size: 1, status: 1, star: true },
      "star-small-fire": { size: 0, status: 2, star: true },
      "star-big-fire": { size: 1, status: 2, star: true },
    };
    const formName = forms[form] ? form : "small";
    const selected = forms[formName];
    mem[0x0754] = selected.size;
    mem[0x0756] = selected.status;
    mem[0x079F] = selected.star ? 0x23 : 0;
    return { name: formName, ...selected };
  }

  setSMBWorldLevel(world, level, form) {
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return null;
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    const worldInput = Number(world);
    const levelInput = Number(level);
    if (!mem || !Number.isFinite(worldInput) || !Number.isFinite(levelInput)) return null;
    const selectedWorld = Math.max(1, Math.min(256, Math.floor(worldInput)));
    const selectedLevel = Math.max(1, Math.min(256, Math.floor(levelInput)));
    const tableOffset = this.findSMBWorldTableOffset();
    if (tableOffset < 0) return null;

    const rom = new Uint8Array(this.romData);
    const worldIndex = (selectedWorld - 1) & 0xFF;
    const levelIndex = (selectedLevel - 1) & 0xFF;
    const areaTableOffset = tableOffset + 8;
    const worldAreaOffset = rom[tableOffset + worldIndex];
    const areaTableIndex = (worldAreaOffset + levelIndex) & 0xFF;
    const areaPointer = rom[areaTableOffset + areaTableIndex];
    const entryForm = this.setSMBForm(form);
    if (!entryForm) return null;

    mem[0x075F] = worldIndex;
    mem[0x075C] = levelIndex;
    mem[0x0760] = levelIndex;
    mem[0x0750] = areaPointer;
    mem[0x074E] = (areaPointer & 0x60) >> 5;
    this.setMarioLives();
    mem[0x0770] = 1;
    mem[0x0772] = 0;
    mem[0x000E] = 0;

    for (let i = 0; i < 4; i++) this.nes.frame();
    this.setSMBForm(entryForm.name);
    this.applyPendingSMBTime();
    this.rewindBuffer.length = 0;
    this.frameCount = 0;

    return { world: selectedWorld, level: selectedLevel, form: form || "small" };
  }

  setSMBLives(lives) {
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return null;
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    const input = Number(lives);
    if (!mem || !Number.isFinite(input)) return null;
    const count = Math.max(1, Math.min(99, Math.floor(input)));
    mem[0x075A] = count - 1;
    this.previousLives = mem[0x075A];
    this.marioLivesSet = true;
    return count;
  }

  setQuestionBlockOneUpChance(percent) {
    const input = Number(percent);
    if (!Number.isFinite(input)) return 0;
    this.questionBlockOneUpChance = Math.max(0, Math.min(100, input));
    return this.questionBlockOneUpChance;
  }

  setQuestionBlockReward(reward) {
    if (!["default", "star", "mushroom", "coin", "goomba"].includes(reward)) return null;
    this.questionBlockReward = reward;
    return reward;
  }

  applyQuestionBlockOneUpChance() {
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return;
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    if (!mem) return;
    const active = mem[0x001B] === 0x2E && mem[0x0023] !== 0;
    if (!active) {
      this.questionBlockPowerUpActive = false;
      return;
    }
    if (this.questionBlockPowerUpActive) return;
    this.questionBlockPowerUpActive = true;

    if (this.questionBlockReward !== "default") {
      if (this.questionBlockReward === "star") mem[0x0039] = 2;
      if (this.questionBlockReward === "mushroom") mem[0x0039] = 0;
      if (this.questionBlockReward === "coin") this.spawnItem("coin");
      if (this.questionBlockReward === "goomba") this.spawnEnemy("goomba");
      return;
    }

    if (Math.random() * 100 < this.questionBlockOneUpChance) mem[0x0039] = 3;
  }

  setPlayerAbility(name, enabled) {
    if (!this.playerAbilities.hasOwnProperty(name)) return null;
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return null;
    this.playerAbilities[name] = !!enabled;
    return this.playerAbilities[name];
  }

  setMovementMode(mode) {
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return null;
    if (!["default", "platformer", "swimming"].includes(mode)) return null;
    this.movementMode = mode;
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    if (mem) mem[0x0704] = mode === "default" ? (mem[0x074E] === 0 ? 1 : 0) : (mode === "swimming" ? 1 : 0);
    return mode;
  }

  setKoopaWakeTicks(ticks) {
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return null;
    const input = Number(ticks);
    if (!Number.isFinite(input)) return null;
    this.koopaWakeTicks = Math.max(0, Math.min(255, Math.floor(input)));
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    if (mem) {
      for (let slot = 0; slot < 6; slot++) {
        if (mem[0x0F + slot] && (mem[0x16 + slot] === 0 || mem[0x16 + slot] === 3) && mem[0x1E + slot] === 4) {
          mem[0x0796 + slot] = this.koopaWakeTicks;
        }
      }
    }
    return this.koopaWakeTicks;
  }

  setScore(score) {
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return null;
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    const input = Number(score);
    if (!mem || !Number.isFinite(input)) return null;
    const value = Math.max(0, Math.min(999999, Math.floor(input)));
    const digits = String(value).padStart(6, "0");
    for (let i = 0; i < 6; i++) mem[0x07DD + i] = Number(digits[i]);
    return value;
  }

  setTheme(theme) {
    if (!["classic", "underground", "underwater", "sunset"].includes(theme) || !this.nes?.ppu) return null;
    this.theme = theme;
    this.applyThemePalette();
    return theme;
  }

  applyThemePalette() {
    const ppu = this.nes?.ppu;
    if (!ppu?.vramMem) return;
    if (!this.themePaletteOriginal) this.themePaletteOriginal = new Array(0x20);
    if (!this.themePaletteApplied) this.themePaletteApplied = new Array(0x20);

    for (let i = 0; i < 0x20; i++) {
      const address = 0x3F00 + i;
      const current = ppu.vramMem[address] & 0x3F;
      const wasApplied = this.themePaletteApplied[i] !== undefined && current === this.themePaletteApplied[i];
      if (!wasApplied) this.themePaletteOriginal[i] = current;
      const original = this.themePaletteOriginal[i];
      let themed = original;

      if (this.theme !== "classic" && original >= 0x10) {
        const level = original & 0x30;
        const hue = original & 0x0F;
        if (this.theme === "underground") themed = Math.max(0x10, level - 0x10) | ((hue + 3) & 0x0F);
        if (this.theme === "underwater") themed = level | ((hue + 5) & 0x0F);
        if (this.theme === "sunset") themed = Math.min(0x30, level + 0x10) | ((hue + 2) & 0x0F);
      }

      ppu.writeMem(address, themed);
      this.themePaletteApplied[i] = themed;
    }
  }

  setBackgroundMusic(track) {
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return null;
    const ids = { overworld: 0x00, underground: 0x01, underwater: 0x02, castle: 0x03, silence: 0x00 };
    if (!Object.hasOwn(ids, track) || !this.nes?.cpu?.mem) return null;
    this.backgroundMusic = track;
    this.isMusicSilenced = track === "silence";
    this.applyBackgroundMusic();
    return track;
  }

  applyBackgroundMusic() {
    if (this.backgroundMusic === null || !/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return;
    const mem = this.nes?.cpu?.mem;
    const ids = { overworld: 0x00, underground: 0x01, underwater: 0x02, castle: 0x03, silence: 0x00 };
    if (mem) mem[0x07B0] = ids[this.backgroundMusic];
  }

  setWarpPipes(enabled, world = this.warpTargetWorld) {
    const target = Number(world);
    if (!Number.isFinite(target)) return null;
    this.warpAllPipes = !!enabled;
    this.warpTargetWorld = Math.max(1, Math.min(256, Math.floor(target)));
    return { enabled: this.warpAllPipes, world: this.warpTargetWorld };
  }

  setCoins(coins) {
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return null;
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    const input = Number(coins);
    if (!mem || !Number.isFinite(input)) return null;
    const count = Math.max(0, Math.min(99, Math.floor(input)));
    mem[0x075E] = count;
    mem[0x07ED] = Math.floor(count / 10);
    mem[0x07EE] = count % 10;
    return count;
  }

  setOneUpLives(lives) {
    const input = Number(lives);
    if (!Number.isFinite(input)) return null;
    this.questionBlockLives = Math.max(1, Math.min(9, Math.floor(input)));
    return this.questionBlockLives;
  }

  setRawRAM(address, value) {
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    const addr = Number(address);
    const byte = Number(value);
    if (!mem || !Number.isInteger(addr) || addr < 0 || addr > 0x07FF || !Number.isInteger(byte)) return null;
    mem[addr] = byte & 0xFF;
    if (addr === 0x075A) this.previousLives = mem[addr];
    return { address: addr, value: mem[addr] };
  }

  setSpriteColor(color) {
    const ppu = this.nes && this.nes.ppu;
    if (!ppu) return null;
    const colors = {
      red: [0x06, 0x16, 0x26], orange: [0x07, 0x17, 0x27], yellow: [0x08, 0x18, 0x28],
      green: [0x09, 0x19, 0x29], cyan: [0x0A, 0x1A, 0x2A], blue: [0x01, 0x11, 0x21],
      purple: [0x03, 0x13, 0x23], white: [0x20, 0x30, 0x30]
    };
    if (color !== "default" && !colors[color]) return null;
    if (!this.spritePaletteOriginal) {
      this.spritePaletteOriginal = [];
      for (let palette = 0; palette < 4; palette++) {
        for (let shade = 1; shade < 4; shade++) {
          this.spritePaletteOriginal.push(ppu.vramMem[0x3F10 + palette * 4 + shade] & 0x3F);
        }
      }
    }
    this.spriteColor = color;
    let index = 0;
    for (let palette = 0; palette < 4; palette++) {
      for (let shade = 1; shade < 4; shade++) {
        const value = color === "default" ? this.spritePaletteOriginal[index] : colors[color][shade - 1];
        ppu.writeMem(0x3F10 + palette * 4 + shade, value);
        index++;
      }
    }
    return color;
  }

  setSpriteTexture(mode) {
    const rom = this.nes && this.nes.rom;
    if (!rom || !rom.vrom || !rom.vrom.length) return null;
    if (!["normal", "mirror", "glitch"].includes(mode)) return null;
    const bankIndex = rom.vrom.length > 1 ? 1 : 0;
    const bank = rom.vrom[bankIndex];
    const tiles = rom.vromTile[bankIndex];
    if (!this.spriteChrOriginal || this.spriteChrBank !== bankIndex) {
      this.spriteChrOriginal = bank.slice();
      this.spriteChrBank = bankIndex;
    }
    this.spriteTexture = mode;
    for (let tileIndex = 0; tileIndex < 256; tileIndex++) {
      for (let row = 0; row < 8; row++) {
        const offset = tileIndex * 16 + row;
        let low = this.spriteChrOriginal[offset];
        let high = this.spriteChrOriginal[offset + 8];
        if (mode === "mirror") {
          const reverse = (value) => {
            value = ((value & 0x55) << 1) | ((value >> 1) & 0x55);
            value = ((value & 0x33) << 2) | ((value >> 2) & 0x33);
            return ((value & 0x0F) << 4) | ((value >> 4) & 0x0F);
          };
          low = reverse(low);
          high = reverse(high);
        } else if (mode === "glitch") {
          low ^= (tileIndex + row) % 2 ? 0x55 : 0xAA;
          high ^= (tileIndex + row) % 2 ? 0xAA : 0x55;
        }
        bank[offset] = low;
        bank[offset + 8] = high;
        tiles[tileIndex].setScanline(row, low, high);
      }
    }
    return mode;
  }

  spawnEnemy(kind) {
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return false;
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    const ids = { goomba: 0x04, koopa: 0x00, "green-koopa": 0x00, "red-koopa": 0x02,
      "green-paratroopa": 0x07, "red-paratroopa": 0x08, spiny: 0x0F, "buzzy-beetle": 0x01, "piranha-plant": 0x0A, lakitu: 0x0E,
      "hammer-bro": 0x03, bowser: 0x2D, "bowser-flame": 0x0D, bulletbill: 0x06, "cheep-cheep": 0x0B,
      "green-cheep-cheep": 0x0B, "red-cheep-cheep": 0x0C, podoboo: 0x09, "spiny-egg": 0x10,
      hammer: 0x03, firebar: 0x2D, pipe: 0x00 };
    if (!mem) return false;
    if (["mushroom", "1up", "coin", "star", "fire-flower"].includes(kind)) return this.spawnItem(kind);
    if (ids[kind] === undefined) return false;
    if (kind === "pipe" || kind === "firebar") return this.spawnLevelObject(kind);
    let slot = -1;
    for (let i = 0; i < 6; i++) {
      if (mem[0x0F + i] === 0) { slot = i; break; }
    }
    if (slot < 0) return false;
    const xWorld = mem[0x0086] + 0x60;
    const x = xWorld & 0xFF;
    const page = (mem[0x006D] + (xWorld > 0xFF ? 1 : 0)) & 0xFF;
    mem[0x16 + slot] = ids[kind];
    mem[0x0F + slot] = 1;
    mem[0x1E + slot] = 0;
    mem[0x6E + slot] = page;
    mem[0x87 + slot] = x;
    mem[0xB6 + slot] = mem[0xB5] || 1;
    mem[0xCF + slot] = mem[0xCE];
    mem[0x46 + slot] = 2;
    mem[0x58 + slot] = kind === "bulletbill" ? 0xE8 : 0xF8;
    mem[0xA0 + slot] = 0;
    mem[0x0434 + slot] = 0;
    mem[0x049A + slot] = kind === "koopa" ? 3 : 9;
    mem[0x03D8 + slot] = 0;
    if (kind === "bulletbill" || kind.includes("paratroopa") || kind === "spiny-egg" || kind === "hammer" || kind === "bowser-flame") mem[0x1E + slot] = 1;
    if (kind === "koopa" || kind === "green-koopa" || kind === "red-koopa" || kind === "red-paratroopa") mem[0x049A + slot] = 3;
    return true;
  }

  spawnLevelObject(kind) {
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    if (!mem) return false;
    const column = (Math.floor((mem[0x006D] * 256 + mem[0x0086]) / 16) + 4) % 16;
    const row = Math.max(3, Math.min(20, Math.floor(mem[0x00CE] / 16)));
    const base = 0x0500 + row * 16 + column;
    if (kind === "pipe") {
      mem[base] = 0x10; mem[base + 1] = 0x11;
      mem[base + 16] = 0x12; mem[base + 17] = 0x13;
    } else {
      for (let y = 3; y < 10; y++) mem[0x0500 + y * 16 + column] = 0x24;
    }
    return true;
  }

  spawnItem(kind) {
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    if (!mem) return false;
    const ids = { mushroom: 0x00, coin: 0x01, "fire-flower": 0x02, star: 0x03, "1up": 0x0B };
    const id = ids[kind];
    if (id === undefined) return false;
    for (let slot = 0; slot < 6; slot++) {
      const base = 0x0110 + slot * 5;
      if (mem[base] !== 0 || mem[base + 4] !== 0) continue;
      mem[base] = id;
      mem[base + 1] = mem[0x006D];
      mem[base + 2] = (mem[0x0086] + 0x40) & 0xFF;
      mem[base + 3] = Math.max(0x30, mem[0x00CE] - 0x20);
      mem[base + 4] = 1;
      return true;
    }
    return false;
  }

  corruptTextures(amount = 48) {
    const rom = this.nes && this.nes.rom;
    if (!rom?.vrom?.length || !rom.vromTile?.length) {
      this.onStatus("Texture corruption requires a ROM with CHR graphics.");
      return false;
    }

    const bankIndex = this.spriteChrBank ?? (rom.vrom.length > 1 ? 1 : 0);
    const bank = rom.vrom[bankIndex];
    if (!this.spriteChrOriginal || this.spriteChrBank !== bankIndex) {
      this.spriteChrOriginal = bank.slice();
      this.spriteChrBank = bankIndex;
    }

    const edits = Math.max(8, Math.min(128, Math.floor(Number(amount) || 48)));
    for (let i = 0; i < edits; i++) {
      const tile = (Math.random() * 256) | 0;
      const row = (Math.random() * 8) | 0;
      const plane = Math.random() < 0.5 ? 0 : 8;
      const offset = tile * 16 + row + plane;
      this.spriteChrOriginal[offset] = (Math.random() * 256) | 0;
    }

    this.setSpriteTexture(this.spriteTexture);
    this.onStatus("Corrupted CHR texture tiles.");
    return true;
  }

  corruptPalette(amount = 8) {
    const ppu = this.nes && this.nes.ppu;
    if (!ppu?.vramMem || typeof ppu.writeMem !== "function") {
      this.onStatus("Palette corruption is unavailable for this ROM.");
      return false;
    }

    const edits = Math.max(1, Math.min(24, Math.floor(Number(amount) || 8)));
    for (let i = 0; i < edits; i++) {
      const index = 1 + ((Math.random() * 31) | 0);
      ppu.writeMem(0x3F00 + index, (Math.random() * 0x40) | 0);
    }
    this.onStatus("Corrupted PPU palette colors.");
    return true;
  }

  scrambleTextures(amount = 12) {
    const rom = this.nes?.rom;
    if (!rom?.vrom?.length || !rom.vromTile?.length) {
      this.onStatus("CHR scrambling requires a ROM with CHR graphics.");
      return false;
    }
    const bankIndex = this.spriteChrBank ?? (rom.vrom.length > 1 ? 1 : 0);
    if (!this.spriteChrOriginal || this.spriteChrBank !== bankIndex) {
      this.spriteChrOriginal = rom.vrom[bankIndex].slice();
      this.spriteChrBank = bankIndex;
    }
    const swaps = Math.max(1, Math.min(40, Math.floor(Number(amount) || 12)));
    for (let i = 0; i < swaps; i++) {
      const first = ((Math.random() * 256) | 0) * 16;
      const second = ((Math.random() * 256) | 0) * 16;
      const tile = this.spriteChrOriginal.slice(first, first + 16);
      this.spriteChrOriginal.copyWithin(first, second, second + 16);
      this.spriteChrOriginal.set(tile, second);
    }
    this.setSpriteTexture(this.spriteTexture);
    this.onStatus("Scrambled CHR graphics tiles.");
    return true;
  }

  corruptNametableTiles(amount = 24) {
    const ppu = this.nes?.ppu;
    if (!ppu || typeof ppu.writeMem !== "function") {
      this.onStatus("Tile-map corruption is unavailable for this ROM.");
      return false;
    }
    const edits = Math.max(1, Math.min(120, Math.floor(Number(amount) || 24)));
    for (let i = 0; i < edits; i++) {
      const address = 0x2000 + ((Math.random() * 0x3C0) | 0);
      ppu.writeMem(address, (Math.random() * 256) | 0);
    }
    this.onStatus("Glitched nametable tiles.");
    return true;
  }

  corruptBackgroundPalette(amount = 8) {
    const ppu = this.nes?.ppu;
    const slots = [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15];
    if (!ppu?.vramMem || typeof ppu.writeMem !== "function") {
      this.onStatus("Background palette corruption is unavailable for this ROM.");
      return false;
    }
    const edits = Math.max(1, Math.min(slots.length, Math.floor(Number(amount) || 8)));
    for (let i = 0; i < edits; i++) {
      const slot = slots.splice((Math.random() * slots.length) | 0, 1)[0];
      ppu.writeMem(0x3F00 + slot, (Math.random() * 0x40) | 0);
    }
    this.onStatus("Corrupted background palette colors.");
    return true;
  }

  corruptSpritePalette(amount = 8) {
    const ppu = this.nes?.ppu;
    const slots = [17, 18, 19, 21, 22, 23, 25, 26, 27, 29, 30, 31];
    if (!ppu?.vramMem || typeof ppu.writeMem !== "function") {
      this.onStatus("Sprite palette corruption is unavailable for this ROM.");
      return false;
    }
    const edits = Math.max(1, Math.min(slots.length, Math.floor(Number(amount) || 8)));
    for (let i = 0; i < edits; i++) {
      const slot = slots.splice((Math.random() * slots.length) | 0, 1)[0];
      ppu.writeMem(0x3F00 + slot, (Math.random() * 0x40) | 0);
    }
    this.onStatus("Corrupted sprite palette colors.");
    return true;
  }

  corruptAudio() {
    if (!this.nes || !this.audioBufferL || !this.audioBufferR) {
      this.onStatus("Audio corruption is unavailable right now.");
      return false;
    }

    const burstLength = 4096;
    if (this.audioCtx?.state === "suspended") {
      this.audioCtx.resume().catch(error => console.warn("Audio resume failed", error));
    }
    if (this.audioBufferL.length > 4096) {
      this.audioBufferL.length = 0;
      this.audioBufferR.length = 0;
    }
    for (let i = 0; i < burstLength; i++) {
      const envelope = 1 - i / burstLength;
      const noise = (Math.random() * 2 - 1) * 0.55 * envelope;
      this.audioBufferL.push(noise);
      this.audioBufferR.push(noise * (0.75 + Math.random() * 0.5));
    }
    this.onStatus("Injected a burst of corrupted audio noise.");
    return true;
  }

  applyPlayerMods() {
    if (!/(?:^|\/)smb\.nes(?:$|[?#])/i.test(this.currentRomUrl)) return;
    const mem = this.nes && this.nes.cpu && this.nes.cpu.mem;
    if (!mem || mem[0x0770] !== 1 || mem[0x0772] < 3) return;

    for (let slot = 0; slot < 6; slot++) {
      const isKoopa = mem[0x0F + slot] && (mem[0x16 + slot] === 0 || mem[0x16 + slot] === 3);
      const sleeping = isKoopa && mem[0x1E + slot] === 4;
      if (sleeping && !this.koopaSleepState[slot]) mem[0x0796 + slot] = this.koopaWakeTicks;
      this.koopaSleepState[slot] = sleeping ? 1 : 0;
    }

    const lives = mem[0x075A];
    if (this.previousLives !== null && lives > this.previousLives && this.questionBlockLives > 1) {
      let oneUp = false;
      for (let slot = 0; slot < 6; slot++) if (mem[0x0110 + slot * 5] === 0x0B) oneUp = true;
      if (oneUp) mem[0x075A] = Math.min(98, lives + this.questionBlockLives - 1);
    }
    this.previousLives = mem[0x075A];

    if (this.playerAbilities.noclip) mem[0x0716] = 1;
    if (this.playerAbilities.immortal) mem[0x079F] = 0xFF;
    if (this.movementMode !== "default") mem[0x0704] = this.movementMode === "swimming" ? 1 : 0;
    if (this.jumpHeight !== 1 && (mem[0x000A] & 0x80) && mem[0x009F] >= 0x80) {
      const velocity = mem[0x009F] - 0x100;
      mem[0x009F] = Math.max(-64, Math.min(-1, Math.round(velocity - (this.jumpHeight - 1) * 1.5))) & 0xFF;
    }
    if (this.playerAbilities.fly) {
      mem[0x009F] = 0;
      mem[0x0433] = 0;
      mem[0x0709] = 0;
      const directions = mem[0x000B] & 0x0C;
      if (directions & 0x08) mem[0x00CE] = Math.max(0x20, mem[0x00CE] - 2);
      if (directions & 0x04) mem[0x00CE] = Math.min(0xD0, mem[0x00CE] + 2);
    }
  }

  loadROMData(arrayBuffer) {
    if (!arrayBuffer) return;
    if (this.romData !== arrayBuffer) {
      this.spritePaletteOriginal = null;
      this.spriteChrOriginal = null;
      this.themePaletteOriginal = null;
      this.themePaletteApplied = null;
      this.backgroundMusic = null;
      this.isMusicSilenced = false;
      this.spriteColor = "default";
      this.spriteTexture = "normal";
    }
    this.romData = arrayBuffer;

    try {
      if (this.nes) {
        this.canvas.width = 256;
        this.canvas.height = 240;
        const bytes = new Uint8Array(arrayBuffer);
        let bin = "", chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        this.nes.loadROM(bin);
        if (this.spriteColor !== "default") this.setSpriteColor(this.spriteColor);
        if (this.spriteTexture !== "normal") this.setSpriteTexture(this.spriteTexture);
        this.onStatus("NES ROM loaded");
      } else {
        this.onStatus("NES engine not initialized");
      }
    } catch (e) {
      console.error("ROM Load Error:", e);
      this.onStatus("Failed to load ROM data.");
    }
  }

  // Advance one logical frame, handling rewind & state capture
  stepFrame() {
    if (!this.nes) return;

    if (this.isRewinding) {
      // When rewinding, walk backwards through saved states
      if (this.rewindBuffer.length > 0) {
        const state = this.rewindBuffer.pop();
        try {
          this.nes.fromJSON(state);
        } catch (e) {
          console.warn("Rewind restore failed:", e);
        }
      }
      return;
    }

    // Normal forward frame
    try {
      this.onLogicalFrame(this.frameCount + 1);
      this.nes.frame();
      this.applyPendingSMBTime();
      this.applyQuestionBlockOneUpChance();
      this.applyPlayerMods();
      this.applyThemePalette();
    } catch (e) {
      console.error("NES frame error:", e);
      this.pause();
      this.onStatus("Game crashed, please reset.");
      return;
    }

    // Periodically capture state for rewind
    this.frameCount++;
    this.spsFrameCounter++;
    if (this.frameCount % this.rewindInterval === 0) {
      try {
        const snap = this.nes.toJSON();
        if (this.rewindBuffer.length >= this.rewindMaxStates) {
          this.rewindBuffer.shift();
        }
        this.rewindBuffer.push(snap);
      } catch (e) {
        // Ignore snapshot failures so gameplay continues
        console.warn("State snapshot failed:", e);
      }
    }
  }

  setSpeed(multiplier) {
    this.speed = Math.min(20, Math.max(0.1, Number.isFinite(multiplier) ? multiplier : 1));
  }

  setRewinding(flag) {
    const on = !!flag;
    if (on === this.isRewinding) return;
    this.isRewinding = on;
    this.onStatus(on ? "Rewinding..." : "Running (NES)");
  }

  start() {
    if (this.isRunning) return;
    if (!this.romData) {
      this.onStatus("No ROM loaded. Please upload or wait.");
      return;
    }

    if (!this.nes) {
      this.onStatus("Engine not initialized.");
      return;
    }

    this.isRunning = true;
    this.isRewinding = false;
    this.lastFrameTime = null;
    this.frameAccumulator = 0;
    this.animationFrame = requestAnimationFrame(this.frameLoop);
    this.onStatus("Running (NES)");

    if (this.audioCtx && this.audioCtx.state === "suspended") {
      this.audioCtx.resume().catch(e => console.warn("Audio resume failed", e));
    }
  }

  pause() {
    this.isRunning = false;
    this.isRewinding = false;
    this.spsFrameCounter = 0;
    this.onFPSUpdate(0, 0, 0);
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.onStatus("Paused");
  }

  reset() {
    this.pause();
    this.themePaletteOriginal = null;
    this.themePaletteApplied = null;
    this.audioBufferL.length = 0;
    this.audioBufferR.length = 0;
    this.corruptionCount = 0;
    this.rewindBuffer = [];
    this.frameCount = 0;
    this.frameAccumulator = 0;
    this.lastFrameTime = null;
    this.marioLivesSet = false;
    this.pendingSMBTime = null;
    this.questionBlockPowerUpActive = false;
    this.previousLives = null;
    this.koopaSleepState.fill(0);

    // Clear old instances
    this.nes = null;

    if (this.NES_C) {
      try {
        this.nes = new this.NES_C({
          onFrame: (fb) => this.drawNESFrame(fb),
          onStatusUpdate: (msg) => this.onStatus(msg),
          onAudioSample: (l, r) => this.onAudioSample(l, r),
          sampleRate: this.audioCtx ? this.audioCtx.sampleRate : 44100,
        });
      } catch (e) {
        console.error("NES init fail:", e);
      }
    }

    if (this.romData) {
      this.loadROMData(this.romData);
      this.onStatus("Ready.");
    } else {
      this.onStatus("Ready. Load ROM to start.");
    }
  }

  saveState(slot) {
    try {
      const state = this.nes.toJSON();
      localStorage.setItem(`granddad_save_${slot}`, JSON.stringify(state));
      this.onStatus(`Saved to slot F${slot}`);
    } catch (e) {
      this.onStatus(`Save failed: ${e.message}`);
    }
  }

  loadState(slot) {
    try {
      const json = localStorage.getItem(`granddad_save_${slot}`);
      if (!json) return this.onStatus(`No save in slot F${slot}`);
      this.nes.fromJSON(JSON.parse(json));
      this.onStatus(`Loaded slot F${slot}`);
    } catch (e) {
      this.onStatus(`Load failed: ${e.message}`);
    }
  }

  loadControlBindings() {
    const bindings = Object.fromEntries(Object.entries(DEFAULT_CONTROL_BINDINGS).map(([name, codes]) => [name, [...codes]]));
    try {
      const saved = JSON.parse(localStorage.getItem("webboy-control-bindings") || "null");
      for (const name of Object.keys(bindings)) {
        if (Array.isArray(saved?.[name])) bindings[name] = saved[name].filter(code => typeof code === "string");
      }
    } catch (e) {}
    return bindings;
  }

  getControlBindings() {
    return Object.fromEntries(Object.entries(this.controlBindings).map(([name, codes]) => [name, [...codes]]));
  }

  setControlBinding(name, code) {
    if (!Object.hasOwn(CONTROL_CODES, name) || typeof code !== "string" || !code || code === "Escape" || code === "KeyR" || /^F\d+$/.test(code) || ["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(code)) return null;
    for (const action of Object.keys(this.controlBindings)) this.controlBindings[action] = this.controlBindings[action].filter(existing => existing !== code);
    this.controlBindings[name] = [code];
    try { localStorage.setItem("webboy-control-bindings", JSON.stringify(this.controlBindings)); } catch (e) {}
    return code;
  }

  resetControlBindings() {
    this.controlBindings = Object.fromEntries(Object.entries(DEFAULT_CONTROL_BINDINGS).map(([name, codes]) => [name, [...codes]]));
    try { localStorage.removeItem("webboy-control-bindings"); } catch (e) {}
    return this.getControlBindings();
  }

  bindKeys() {
    const NES_BTN = CONTROL_CODES;

    // Helper to ignore emulator key handling when the user is focused in an editable field
    const isTypingInField = (target) => {
      try {
        if (!target) return false;
        const tag = (target.tagName || "").toUpperCase();
        if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return true;
        if (target.isContentEditable) return true;
      } catch (e) {
        // ignore and fall through
      }
      return false;
    };

    const getBinding = (code) => Object.keys(this.controlBindings).find(name => this.controlBindings[name].includes(code));
    const down = (e) => {
      if (this.isCapturingControl) return;
      // Don't intercept keys while the user is typing in an input/select/textarea or contenteditable element
      if (isTypingInField(e.target)) return;

      const code = e && typeof e.code === "string" ? e.code : "";
      if (this.nes && ["Space", "ArrowUp", "ArrowDown"].includes(code)) e.preventDefault();
      if (e.repeat) return;
      if (code && code.startsWith("F") && code.length === 2) {
        e.preventDefault();
        const slot = parseInt(code.slice(1), 10);
        if (slot >= 1 && slot <= 4) {
          if (e.shiftKey) this.loadState(slot); else this.saveState(slot);
        }
        return;
      }

      const btn = code === "KeyR" ? "RESET" : getBinding(code);
      if (!btn) return;
      e.preventDefault();
      if (btn === "RESET") { this.reset(); return; }

      if (btn === "START") this.setMarioLives();
      const bit = NES_BTN[btn];
      if (bit !== undefined && this.nes) {
        this.nes.buttonDown(1, bit);
        this.cpsCounter++;
        this.onButtonDown(bit);
        this.onButtonChange(bit, true);
      }
    };

    const up = (e) => {
      if (this.isCapturingControl) return;
      // Ignore keyups that originate from typing fields so releasing keys while typing doesn't trigger NES release
      if (isTypingInField(e.target)) return;

      const btn = getBinding(e.code);
      if (!btn || btn === "RESET") return;
      const bit = NES_BTN[btn];
      if (bit !== undefined && this.nes) {
        this.nes.buttonUp(1, bit);
        this.onButtonChange(bit, false);
      }
    };

    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up);
  }

  // Public API for on-screen (mobile) controls.
  buttonPress(name) {
    if (name === "START") this.setMarioLives();
    const bit = CONTROL_CODES[name];
    if (bit !== undefined && this.nes) {
      this.nes.buttonDown(1, bit);
      this.cpsCounter++;
      this.onButtonDown(bit);
      this.onButtonChange(bit, true);
    }
  }

  buttonRelease(name) {
    const bit = CONTROL_CODES[name];
    if (bit !== undefined && this.nes) {
      this.nes.buttonUp(1, bit);
      this.onButtonChange(bit, false);
    }
  }

  doCorrupt(byteCount = 64, type = "random") {
    if (!(this.nes && this.nes.cpu && this.nes.cpu.mem)) {
      this.onStatus("Corruption not available right now.");
      return;
    }

    const mem = this.nes.cpu.mem;

    // sanitize byteCount
    let count = Number.isFinite(byteCount) ? (byteCount | 0) : 64;
    if (count < 1) count = 1;
    if (count > 1024) count = 1024;

    switch (type) {

      // Lightweight random: gentle, low-amplitude random nudges to a few bytes only
      case "light_random":
        {
          const gentleCount = Math.max(1, Math.min(16, (count / 8) | 0));
          for (let i = 0; i < gentleCount; i++) {
            const addr = (Math.random() * 0x0800) | 0;
            // nudge value by a small delta so pointers/flags are unlikely to break
            const delta = ((Math.random() * 11) | 0) - 5; // -5 .. +5
            mem[addr] = (mem[addr] + delta) & 0xFF;
          }
        }
        break;

      // Lightweight bitflip: flip low-significance bits only (LSB/second bit) to reduce risk
      case "light_bitflip":
        for (let i = 0; i < Math.max(1, Math.min(32, (count / 4) | 0)); i++) {
          const addr = (Math.random() * 0x0800) | 0;
          // flip either bit0 or bit1, keeping changes subtle
          const bit = 1 << ((Math.random() < 0.5) ? 0 : 1);
          mem[addr] ^= bit;
        }
        break;

      case "bitflip":
        for (let i = 0; i < count; i++) {
          const addr = (Math.random() * 0x0800) | 0;
          mem[addr] ^= (1 << ((Math.random() * 8) | 0));
        }
        break;

      case "byteswap":
        for (let i = 0; i < count / 2; i++) {
          const addr = (Math.random() * 0x07FE) | 0;
          const tmp = mem[addr];
          mem[addr] = mem[addr + 1];
          mem[addr + 1] = tmp;
        }
        break;

      case "checkerboard":
        const start = (Math.random() * (0x0800 - count)) | 0;
        for (let i = 0; i < count; i++) {
          if (i % 2 === 0) {
            mem[(start + i) % 0x0800] = (Math.random() * 0x100) | 0;
          }
        }
        break;

      case "everybyte":
        for (let i = 0; i < 0x0800; i++) {
          mem[i] = (Math.random() * 0x100) | 0;
        }
        break;

      case "texturevomit":
        const numChunks = Math.max(4, count);
        const chunkSize = Math.floor(0x0800 / numChunks);
        for (let i = 0; i < numChunks; i++) {
          const blockStart = i * chunkSize;
          const randomVal = (Math.random() * 0x100) | 0;
          const randomPos = (Math.random() * chunkSize) | 0;
          const targetAddr = blockStart + randomPos;
          if (targetAddr < 0x0800) {
            mem[targetAddr] = randomVal;
          }
        }
        break;

      case "worldlevel":
        const worldTypeChance = Math.random();
        if (worldTypeChance < 0.3) {
          mem[0x075F] = 10;
          mem[0x075C] = (Math.random() * 4) | 0;
          mem[0x0773] = 0x01;
          this.onStatus("Plus World detected! Sky turned dark blue.");
        } else if (worldTypeChance < 0.4) {
          mem[0x075F] = 0;
          mem[0x075C] = 4;
          this.onStatus("Warped to Level 1-5: The Treasure Ground.");
        } else if (worldTypeChance < 0.6) {
          mem[0x075F] = 255;
          this.onStatus("Minus World entry detected!");
        } else {
          mem[0x075F] = (Math.random() * 8) | 0;
          mem[0x075C] = (Math.random() * 4) | 0;
        }

        mem[0x07B1] = (Math.random() * 0x10) | 0;

        const mapStart = 0x0500;
        const mapSize = 0x01A0;
        for (let x = 0; x < 32; x++) {
          const floorAddr = mapStart + 160 + x;
          if (floorAddr < mapStart + mapSize) {
            mem[floorAddr] = 0x54;
          }
          if (mem[0x075C] === 4) {
            const coinRow = mapStart + 144 + x;
            if (coinRow < mapStart + mapSize) mem[coinRow] = 0x34;
          }
        }

        const blockTypes = [0x51, 0x4B, 0x40];
        for (let i = 0; i < 30; i++) {
          const randPos = (Math.random() * mapSize) | 0;
          mem[mapStart + randPos] = blockTypes[(Math.random() * blockTypes.length) | 0];
        }

        for (let i = 0; i < 6; i++) {
          const px = (Math.random() * 14) | 0;
          const py = (Math.random() * 10) | 0;
          const pBase = mapStart + (py * 16) + px;
          if (pBase + 17 < mapStart + mapSize) {
            mem[pBase] = 0x10; mem[pBase + 1] = 0x11;
            mem[pBase + 16] = 0x12; mem[pBase + 17] = 0x13;
          }
        }

        if (Math.random() < 0.25) {
          const fx = (Math.random() * 30) | 0;
          for (let fy = 3; fy < 10; fy++) {
            const fAddr = mapStart + (fy * 16) + fx;
            if (fAddr < mapStart + mapSize) mem[fAddr] = 0x24;
          }
        }

        const lootTable = [0x2E, 0x2F, 0x35, 0x01, 0x02, 0x03, 0x06];
        for (let addr = 0x0016; addr <= 0x001F; addr++) {
          if (Math.random() < 0.7) {
            mem[addr] = lootTable[(Math.random() * lootTable.length) | 0];
          }
        }

        mem[0x07F8] = 9;
        mem[0x0750] = (Math.random() * 256) | 0;

        this.onStatus("World Changer: Environment & Plus World data injected.");
        break;

      case "music":
        for (let i = 0; i < count; i++) {
          const addr = 0x07B0 + ((Math.random() * 16) | 0);
          mem[addr] = (Math.random() * 0x100) | 0;
        }
        for (let i = 0; i < Math.min(8, Math.max(1, (count / 16) | 0)); i++) {
          const addr2 = 0x0700 + ((Math.random() * 0x80) | 0);
          mem[addr2] ^= (1 << ((Math.random() * 8) | 0));
        }

        if (this.audioBufferL && this.audioBufferR) {
          const burstLen = Math.min(2048, Math.max(128, (count * 8) | 0));
          for (let i = 0; i < burstLen; i++) {
            const sample = ((Math.random() * 2 - 1) * 0.6) * (1 - i / burstLen);
            this.audioBufferL.push(sample);
            this.audioBufferR.push(sample * (Math.random() * 0.9 + 0.8));
          }
          if (this.audioBufferL.length > 8192) this.audioBufferL.length = 8192;
          if (this.audioBufferR.length > 8192) this.audioBufferR.length = 8192;
        }

        this.onStatus(`Music Corruptor: tampered ${count} music bytes and injected audio noise.`);
        break;

      case "musicswap":
        for (let s = 0; s < Math.max(1, (count / 16) | 0); s++) {
          const a = 0x07B0 + ((Math.random() * 16) | 0);
          const b = 0x07B0 + ((Math.random() * 16) | 0);
          const tmp = mem[a];
          mem[a] = mem[b];
          mem[b] = tmp;
        }
        this.onStatus(`Music Swapper: swapped music IDs around.`);
        break;

      case "swapper":
        const ASSETS = {
          musicIDs: { start: 0x07B0, len: 0x10 },
          musicControl: { start: 0x0700, len: 0x40 },
          mapBuffer: { start: 0x0500, len: 0x01A0 },
          spriteTable: { start: 0x0000, len: 0x0100 },
          paletteLike: { start: 0x06E0, len: 0x20 }
        };

        const keys = Object.keys(ASSETS);
        const pickAsset = () => keys[(Math.random() * keys.length) | 0];
        let aKey = pickAsset();
        let bKey = pickAsset();
        if (aKey === bKey) {
          bKey = keys[(keys.indexOf(aKey) + 1 + ((Math.random() * (keys.length - 1)) | 0)) % keys.length];
        }
        const A = ASSETS[aKey];
        const B = ASSETS[bKey];

        const maxLen = Math.min(A.len, B.len, Math.max(8, Math.min(256, count)));
        const offA = (Math.random() * (A.len - maxLen)) | 0;
        const offB = (Math.random() * (B.len - maxLen)) | 0;

        for (let i = 0; i < maxLen; i++) {
          const addrA = A.start + offA + i;
          const addrB = B.start + offB + i;
          const aAddr = addrA % 0x0800;
          const bAddr = addrB % 0x0800;
          const tmp = mem[aAddr];
          mem[aAddr] = mem[bAddr];
          mem[bAddr] = tmp;
        }

        this.onStatus(`Swapper: swapped ${maxLen} bytes between ${aKey} (0x${(A.start+offA).toString(16)}) and ${bKey} (0x${(B.start+offB).toString(16)}).`);
        break;

      case "numberscramble":
        // Number Scramble: targets time, score and pointer bytes and scrambles digits/nibbles to produce odd scores/timers
        // Target common timer/score/pointer areas heuristically
        const numTargets = [0x07F8, 0x07F9, 0x07FA, 0x07FB, 0x0750, 0x0751, 0x075C, 0x075F, 0x07B1];
        for (let i = 0; i < count; i++) {
          const t = numTargets[(Math.random() * numTargets.length) | 0] | 0;
          // rotate nibble pairs or add/sub small deltas
          if (Math.random() < 0.5) {
            // swap high/low nibble
            mem[t] = (((mem[t] & 0xF) << 4) | ((mem[t] & 0xF0) >> 4)) & 0xFF;
          } else {
            // add small offset, wrap
            mem[t] = (mem[t] + ((Math.random() * 31) | 0) - 15) & 0xFF;
          }
        }
        this.onStatus(`Number Scramble: garbled counters and pointers (${count} ops).`);
        break;

      case "assetscramble":
        // Asset Scramble: perform many small cross-swaps among asset-like regions to create chaotic cross-pollination
        const REGIONS = [
          { s: 0x0500, l: 0x60 }, // portion of map
          { s: 0x0560, l: 0x60 }, // another map chunk
          { s: 0x06E0, l: 0x40 }, // palette-ish
          { s: 0x0000, l: 0x80 }, // sprite table slice
          { s: 0x07B0, l: 0x10 }  // musicIDs
        ];
        for (let i = 0; i < Math.max(4, (count / 8) | 0); i++) {
          const aIdx = (Math.random() * REGIONS.length) | 0;
          let bIdx = (Math.random() * REGIONS.length) | 0;
          if (aIdx === bIdx) bIdx = (aIdx + 1) % REGIONS.length;
          const Areg = REGIONS[aIdx];
          const Breg = REGIONS[bIdx];
          const len = Math.max(2, Math.min(Areg.l, Breg.l, (Math.random() * 32) | 0));
          const offA2 = (Math.random() * (Areg.l - len)) | 0;
          const offB2 = (Math.random() * (Breg.l - len)) | 0;
          for (let k = 0; k < len; k++) {
            const aAddr = (Areg.s + offA2 + k) % 0x0800;
            const bAddr = (Breg.s + offB2 + k) % 0x0800;
            const tmp = mem[aAddr];
            mem[aAddr] = mem[bAddr];
            mem[bAddr] = tmp;
          }
        }
        this.onStatus(`Asset Scramble: cross-swapped multiple small asset slices.`);
        break;

      case "blockscramble":
        // Block Scrambler: shuffle map block data inside the map buffer region to jumble level geometry
        // Map region heuristics (map buffer start/length used elsewhere)
        {
          const mapStart = 0x0500;
          const mapLen = 0x01A0;
          // pick a block size (1-8 rows of 16 tiles)
          const rowSize = 16;
          const maxRows = Math.max(1, Math.min(8, (count / 8) | 0));
          const rows = (Math.random() * maxRows) | 0 + 1;
          for (let r = 0; r < rows; r++) {
            const srcRow = (Math.random() * (mapLen / rowSize)) | 0;
            const dstRow = (Math.random() * (mapLen / rowSize)) | 0;
            for (let c = 0; c < rowSize; c++) {
              const a = mapStart + (srcRow * rowSize) + c;
              const b = mapStart + (dstRow * rowSize) + c;
              const tmp = mem[a % 0x0800];
              mem[a % 0x0800] = mem[b % 0x0800];
              mem[b % 0x0800] = tmp;
            }
          }
          // small random tile value nudges
          for (let i = 0; i < Math.min(24, count); i++) {
            const addr = mapStart + ((Math.random() * mapLen) | 0);
            mem[addr % 0x0800] = (mem[addr % 0x0800] ^ ((Math.random() * 0xFF) | 0)) & 0xFF;
          }
        }
        this.onStatus(`Block Scrambler: shuffled ${count} map ops.`);
        break;

      case "levelscrambler":
        // Level Scrambler: more aggressive, but still memory-conscious reorganization of level tile layout.
        // Operates on the map buffer region: shuffles rows, rotates columns, swaps tile ranges and mutates a selection of tiles.
        {
          const mapStart = 0x0500;
          const mapLen = 0x01A0; // 416 bytes
          const rowSize = 16;
          const rowsCount = Math.floor(mapLen / rowSize);

          // 1) Shuffle rows order
          const rowOrder = [];
          for (let r = 0; r < rowsCount; r++) rowOrder.push(r);
          // Fisher-Yates shuffle influenced by count
          for (let i = rowOrder.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = rowOrder[i]; rowOrder[i] = rowOrder[j]; rowOrder[j] = tmp;
          }
          // Create a temporary copy of the map slice
          const temp = new Uint8Array(mapLen);
          for (let r = 0; r < rowsCount; r++) {
            const srcRow = rowOrder[r];
            for (let c = 0; c < rowSize; c++) {
              temp[r * rowSize + c] = mem[(mapStart + srcRow * rowSize + c) % 0x0800];
            }
          }
          // Write back shuffled rows
          for (let i = 0; i < mapLen; i++) {
            mem[(mapStart + i) % 0x0800] = temp[i];
          }

          // 2) Rotate a few columns up or down
          const rotateOps = Math.max(1, Math.min(6, (count / 32) | 0));
          for (let op = 0; op < rotateOps; op++) {
            const col = Math.floor(Math.random() * rowSize);
            const shift = (Math.random() < 0.5 ? -1 : 1) * (1 + (Math.random() * 3) | 0);
            const colVals = [];
            for (let r = 0; r < rowsCount; r++) colVals.push(mem[(mapStart + r * rowSize + col) % 0x0800]);
            // rotate
            const s = ((shift % rowsCount) + rowsCount) % rowsCount;
            for (let r = 0; r < rowsCount; r++) {
              mem[(mapStart + r * rowSize + col) % 0x0800] = colVals[(r + s) % rowsCount];
            }
          }

          // 3) Swap contiguous tile ranges between random positions to create mismatched segments
          const swapOps = Math.max(1, Math.min(12, (count / 16) | 0));
          for (let s = 0; s < swapOps; s++) {
            const len = 1 + (Math.random() * 16) | 0;
            const aOff = (Math.random() * (mapLen - len)) | 0;
            const bOff = (Math.random() * (mapLen - len)) | 0;
            for (let k = 0; k < len; k++) {
              const aa = (mapStart + aOff + k) % 0x0800;
              const bb = (mapStart + bOff + k) % 0x0800;
              const tmp = mem[aa];
              mem[aa] = mem[bb];
              mem[bb] = tmp;
            }
          }

          // 4) Mutate a handful of tiles to random tile values but keep some heuristics for coin/powerup tiles
          const mutateCount = Math.max(4, Math.min(48, count));
          const coinLike = [0x34, 0x2E, 0x2F, 0x35];
          for (let m = 0; m < mutateCount; m++) {
            const addr = (mapStart + ((Math.random() * mapLen) | 0)) % 0x0800;
            if (Math.random() < 0.12) {
              mem[addr] = coinLike[(Math.random() * coinLike.length) | 0];
            } else if (Math.random() < 0.35) {
              // preserve plausible tile range by masking into small set
              mem[addr] = (mem[addr] & 0xF0) | ((Math.random() * 0x0F) | 0);
            } else {
              mem[addr] = (Math.random() * 0xFF) | 0;
            }
          }

          // 5) Slightly perturb enemy/object table offsets near map area to keep things chaotic
          for (let i = 0; i < Math.min(6, (count / 24) | 0); i++) {
            const p = 0x0020 + ((Math.random() * 0x30) | 0);
            mem[p % 0x0800] ^= (1 << ((Math.random() * 8) | 0));
          }
        }
        this.onStatus(`Level Scrambler: aggressively reorganized map rows/columns and mutated ${count} tiles.`);
        break;

      case "powerupscramble":
        // Power-up Scrambler: randomize power-up/pickup related bytes and toggle spawn flags
        {
          const powerAddrs = [0x0750, 0x0751, 0x0752, 0x075C, 0x075F, 0x07F8, 0x07F9];
          for (let i = 0; i < count; i++) {
            const a = powerAddrs[(Math.random() * powerAddrs.length) | 0] % 0x0800;
            // either nudge, zero, set to common pickup values or flip low bits
            const r = Math.random();
            if (r < 0.25) mem[a] = (mem[a] + ((Math.random() * 31) | 0) - 15) & 0xFF;
            else if (r < 0.5) mem[a] = 0;
            else if (r < 0.8) mem[a] = [0x00, 0x01, 0x02, 0x03, 0x06][(Math.random() * 5) | 0];
            else mem[a] ^= (1 << ((Math.random() * 8) | 0));
          }
          // also sprinkle some coin/powerup tiles into the map region occasionally
          const mapStart = 0x0500;
          const mapLen = 0x01A0;
          for (let i = 0; i < Math.max(2, (count / 16) | 0); i++) {
            const pos = mapStart + ((Math.random() * mapLen) | 0);
            mem[pos % 0x0800] = 0x34; // coin-like tile id heuristic
          }
        }
        this.onStatus(`Power-up Scrambler: randomized pickup & power-up bytes (${count}).`);
        break;

      case "enemyscramble":
        // Enemy Scrambler: permute enemy/object table entries to swap enemy types and positions
        {
          const objStart = 0x0020;
          const objLen = 0x40;
          const ops = Math.max(4, Math.min(32, count));
          for (let i = 0; i < ops; i++) {
            const idx1 = (Math.random() * objLen) | 0;
            const idx2 = (Math.random() * objLen) | 0;
            const a1 = (objStart + idx1) % 0x0800;
            const a2 = (objStart + idx2) % 0x0800;
            const tmp = mem[a1];
            mem[a1] = mem[a2];
            mem[a2] = tmp;
            // also tweak type/behavior bytes nearby
            const off = ((Math.random() * 4) | 0);
            mem[(a1 + off) % 0x0800] ^= (1 << ((Math.random() * 8) | 0));
            mem[(a2 + off) % 0x0800] ^= (1 << ((Math.random() * 8) | 0));
          }
        }
        this.onStatus(`Enemy Scrambler: permuted enemy table entries (${count} ops).`);
        break;

      case "logicscramble":
        // Logic Scramble: flip/patch flags, pointers and AI/enemy behavior tables to alter game logic
        // 1) randomly coerce some flag bytes into boolean (0/1) states to create stricter on/off behavior
        const flagAddrs = [0x0010, 0x0011, 0x0012, 0x0016, 0x0017, 0x0018];
        // For a portion of ops, force a boolean state; for the rest, flip random bits as before.
        const boolOps = Math.max(1, Math.min(8, (count / 4) | 0));
        for (let i = 0; i < boolOps; i++) {
          const a = flagAddrs[(Math.random() * flagAddrs.length) | 0];
          // Set to either 0 or 1 (random) to convert flags into explicit booleans
          mem[a] = Math.random() < 0.5 ? 0 : 1;
        }
        // Continue to flip some bits for more subtle effects
        for (let i = 0; i < Math.min(20, count); i++) {
          const a = flagAddrs[(Math.random() * flagAddrs.length) | 0];
          mem[a] ^= (1 << ((Math.random() * 8) | 0));
        }

        // 2) permute small enemy/object table slices
        const objStart = 0x0020;
        const objLen = 0x40;
        for (let i = 0; i < Math.min(8, (count / 8) | 0); i++) {
          const idx1 = (Math.random() * objLen) | 0;
          const idx2 = (Math.random() * objLen) | 0;
          const a1 = (objStart + idx1) % 0x0800;
          const a2 = (objStart + idx2) % 0x0800;
          const tmp = mem[a1];
          mem[a1] = mem[a2];
          mem[a2] = tmp;
        }

        // 3) nudge logic pointers to random nearby addresses
        for (let i = 0; i < Math.min(6, (count / 16) | 0); i++) {
          const p = 0x0700 + ((Math.random() * 0x30) | 0);
          mem[p] = (mem[p] + ((Math.random() * 31) | 0) - 15) & 0xFF;
        }

        // 4) Occasionally apply additional bitwise-style ops (NOT, AND, OR, XOR, bitflip) to logic bytes
        // This creates effects like turning boolean flags into inverted or masked states.
        const extraOps = ["not", "and", "or", "xor", "bitflip"];
        const extraCount = Math.min(20, Math.max(2, (count / 4) | 0));
        for (let i = 0; i < extraCount; i++) {
          const addr = flagAddrs[(Math.random() * flagAddrs.length) | 0];
          const op = extraOps[(Math.random() * extraOps.length) | 0];
          switch (op) {
            case "not":
              mem[addr] = (~mem[addr]) & 0xFF;
              break;
            case "and": {
              const mask = (Math.random() * 0xFF) | 0;
              mem[addr] = mem[addr] & mask;
              break;
            }
            case "or": {
              const mask = (Math.random() * 0xFF) | 0;
              mem[addr] = mem[addr] | mask;
              break;
            }
            case "xor": {
              const mask = (Math.random() * 0xFF) | 0;
              mem[addr] = mem[addr] ^ mask;
              break;
            }
            case "bitflip": {
              const bit = 1 << ((Math.random() * 8) | 0);
              mem[addr] ^= bit;
              break;
            }
          }
        }

        this.onStatus(`Logic Scramble: coerced flags, permuted tables and applied bitwise tweaks.`);
        break;

      case "xor":
        const xorMask = (Math.random() * 0x100) | 0;
        for (let i = 0; i < count; i++) {
          const addr = (Math.random() * 0x0800) | 0;
          mem[addr] ^= xorMask;
        }
        this.onStatus(`XOR Corruption: mask 0x${xorMask.toString(16).toUpperCase()}`);
        break;

      case "or":
        const orMask = (Math.random() * 0xFF) | 0;
        for (let i = 0; i < count; i++) {
          const addr = (Math.random() * 0x0800) | 0;
          mem[addr] |= orMask;
        }
        this.onStatus(`OR Corruption: mask 0x${orMask.toString(16).toUpperCase()}`);
        break;

      case "and":
        const andMask = (Math.random() * 0xFF) | 0;
        for (let i = 0; i < count; i++) {
          const addr = (Math.random() * 0x0800) | 0;
          mem[addr] &= andMask;
        }
        this.onStatus(`AND Corruption: mask 0x${andMask.toString(16).toUpperCase()}`);
        break;

      case "nand":
        const nandMask = (Math.random() * 0xFF) | 0;
        for (let i = 0; i < count; i++) {
          const addr = (Math.random() * 0x0800) | 0;
          mem[addr] = (~(mem[addr] & nandMask)) & 0xFF;
        }
        this.onStatus(`NAND Corruption: mask 0x${nandMask.toString(16).toUpperCase()}`);
        break;

      case "not":
        for (let i = 0; i < count; i++) {
          const addr = (Math.random() * 0x0800) | 0;
          mem[addr] = (~mem[addr]) & 0xFF;
        }
        this.onStatus(`NOT Corruption applied to ${count} bytes`);
        break;

      case "binaryswap":
        // Flip a single randomly chosen bit within random bytes, count times.
        // This performs many 1↔0 toggles at the bit level, producing binary-style glitches.
        for (let i = 0; i < count; i++) {
          const addr = (Math.random() * 0x0800) | 0;
          const bit = 1 << ((Math.random() * 8) | 0);
          mem[addr] ^= bit;
        }
        this.onStatus(`Binary Swap: flipped ${count} random bits.`);
        break;

      case "completebinaryswap":
        // Invert every byte in the RAM range (bitwise NOT) — a complete binary inversion.
        for (let i = 0; i < 0x0800; i++) {
          mem[i] = (~mem[i]) & 0xFF;
        }

        // Additionally treat some known logic/flag addresses as booleans and flip them (0 <-> 1)
        const booleanAddrs = [0x0010, 0x0011, 0x0012, 0x0016, 0x0017, 0x0018, 0x075C, 0x075F];
        for (let i = 0; i < booleanAddrs.length; i++) {
          const a = booleanAddrs[i] % 0x0800;
          // If byte looks like a boolean (0 or 1), flip it; otherwise coerce into flipped boolean by testing LSB
          if (mem[a] === 0) mem[a] = 1;
          else if (mem[a] === 1) mem[a] = 0;
          else mem[a] = (mem[a] & 1) ? 0 : 1;
        }

        // Occasionally apply extra logical ops to a small set of logic-related addresses to create varied effects
        const logicAddrs = [0x0700, 0x0701, 0x0702, 0x07B0, 0x07B1, 0x07F8];
        const extraOps2 = ["not", "and", "or", "xor"];
        const opsCount = Math.min(12, Math.max(4, (this.corruptionCount % 10) + 4));
        for (let i = 0; i < opsCount; i++) {
          const addr = logicAddrs[(Math.random() * logicAddrs.length) | 0] % 0x0800;
          const op = extraOps2[(Math.random() * extraOps2.length) | 0];
          switch (op) {
            case "not":
              mem[addr] = (~mem[addr]) & 0xFF;
              break;
            case "and": {
              const mask = (Math.random() * 0xFF) | 0;
              mem[addr] = mem[addr] & mask;
              break;
            }
            case "or": {
              const mask = (Math.random() * 0xFF) | 0;
              mem[addr] = mem[addr] | mask;
              break;
            }
            case "xor": {
              const mask = (Math.random() * 0xFF) | 0;
              mem[addr] = mem[addr] ^ mask;
              break;
            }
          }
        }

        this.onStatus(`Complete Binary Swap: inverted all ${0x0800} bytes and toggled boolean/logic flags.`);
        break;

      case "scramble":
        for (let i = 0; i < count; i++) {
          const addr1 = (Math.random() * 0x0800) | 0;
          const addr2 = (Math.random() * 0x0800) | 0;
          const tmp = mem[addr1];
          mem[addr1] = mem[addr2];
          mem[addr2] = tmp;
        }
        this.onStatus(`Scramble: Swapped ${count} pairs`);
        break;

      case "clusterbytes":
        const clusterCenter = (Math.random() * 0x0800) | 0;
        const clusterSpread = Math.max(16, count / 2);
        for (let i = 0; i < count; i++) {
          const offset = Math.floor((Math.random() - 0.5) * clusterSpread);
          const addr = (clusterCenter + offset + 0x0800) % 0x0800;
          mem[addr] = (Math.random() * 0x100) | 0;
        }
        this.onStatus(`ClusterBytes Corruption at 0x${clusterCenter.toString(16)}`);
        break;

      default:
        for (let i = 0; i < count; i++) {
          const addr = (Math.random() * 0x0800) | 0;
          mem[addr] = (Math.random() * 0x100) | 0;
        }
        break;
    }

    this.corruptionCount++;
    this.onStatus(`Corruption applied (${this.corruptionCount}).`);
  }
}