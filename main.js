import { Emulator } from "./emulator.js";

// MASTER game list (authoritative names/paths). Some entries may not exist on the server.
const GAME_LIST = [
  { name: "Super Mario Bros.", path: "/smb.nes" },
  { name: "7 Grand Dad (Unl)", path: "/Grand Dad 7 (Unl).nes" },
  { name: "Tetris", path: "/Tetris.nes" },
  { name: "Donkey Kong Jr.", path: "/Donkey_kong_jr.nes" },
  { name: "Contra", path: "/contra.nes" },
  { name: "Famidash v1.2.8", path: "/Famidash.v1.2.8.nes" },
  { name: "Pinball (Japan, USA)", path: "/Pinball (Japan, USA).nes" },
  { name: "Excitebike", path: "/Excite_bike.nes" },
  { name: "Dr. Mario", path: "/dr mario.nes" },
  { name: "Friday the 13th", path: "/friday_the_13th.nes" },
  { name: "Super Mario Bros. 3", path: "/Super_mario_brothers3.nes" },
  { name: "Bomber Man", path: "/Bomber_man.nes" },
  { name: "Somari", path: "/Somari.nes" },
  { name: "Mario Bros. (World)", path: "/Mario Bros. (World).nes" },
  { name: "Donkey Kong (Original Edition, VC)", path: "/Donkey Kong - Original Edition (Europe) (Pre-install Only, NES) (Virtual Console).nes" },
  { name: "Super Mario Bros. 2 (USA)", path: "/Super Mario Bros. 2 (USA) (Rev 1).nes" },
  { name: "Wrecking Crew (World)", path: "/Wrecking Crew (World).nes" },
  { name: "8 Eyes (USA)", path: "/8 Eyes (USA).nes" },
  { name: "Tennis (Japan, USA)", path: "/Tennis (Japan, USA) (En).nes" },

  // Entries that are often inside large archives/torrents but may not be hosted individually.
  { name: "Castlevania", path: "/Castlevania.nes" },
  { name: "Metroid", path: "/Metroid.nes" },
  { name: "Mega Man 2", path: "/Mega Man 2 (USA).nes" },
  { name: "Zelda II: The Adventure of Link", path: "/Zelda II - The Adventure of Link (USA).nes" },
  { name: "The Legend of Zelda", path: "/Zelda.nes" },
  { name: "Batman (1989)", path: "/Batman (1989).nes" },

  // extra friendly aliases
  { name: "Super Mario Bros. (alt label)", path: "/smb.nes" },
  { name: "Grand Dad - Bootleg", path: "/Grand Dad 7 (Unl).nes" }
];

// Helper: check whether a file exists on the server using HEAD (falls back to GET on servers that block HEAD)
async function fileExists(path) {
  try {
    const res = await fetch(path, { method: "HEAD" });
    if (res && res.ok) return true;
    // Some servers disallow HEAD; try a range GET for small bytes
    const res2 = await fetch(path, { method: "GET", headers: { Range: "bytes=0-0" } });
    return res2 && (res2.ok || res2.status === 206);
  } catch (e) {
    return false;
  }
}

function parseSRT(text) {
  const toSec = (h,m,s,ms)=>(+h)*3600+(+m)*60+(+s)+(+ms||0)/1000;
  return text.trim().split(/\n\s*\n/).map(b=>{
    const lines=b.split("\n");
    const time=lines[1].match(/(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)/);
    const start=toSec(time[1],time[2],time[3],time[4]);
    const end=toSec(time[5],time[6],time[7],time[8]);
    const content=lines.slice(2).join(" ").replace(/\s+/g," ").trim();
    return {start,end,text:content};
  });
}

async function setup() {
  const canvas = document.getElementById("screen");
  const statusEl = document.getElementById("status");
  const fpsEl = document.getElementById("fps-counter");
  const cpsEl = document.getElementById("cps-counter");
  const spsEl = document.getElementById("sps-counter");
  const btnStart = document.getElementById("btn-start");
  const btnPause = document.getElementById("btn-pause");
  const pauseOverlay = document.getElementById("pause-overlay");
  const btnReset = document.getElementById("btn-reset");
  const btnResetGame = document.getElementById("btn-reset-game");
  const btnLoadRom = document.getElementById("btn-load-rom");
  const romUpload = document.getElementById("rom-upload");
  const btnFs = document.getElementById("btn-fullscreen");
  const btnDownloadRom = document.getElementById("btn-download-rom");
  const volume = document.getElementById("volume");
  const btnMute = document.getElementById("btn-mute");
  const btnCrt = document.getElementById("btn-crt");
  const corruptionType = document.getElementById("corruption-type");
  const corruptionAmount = document.getElementById("corruption-amount");
  const btnCorrupt = document.getElementById("btn-corrupt");
  const btnCorruptTwice = document.getElementById("btn-corrupt-twice");
  const btnCorruptLevelLayout = document.getElementById("btn-corrupt-level-layout");
  const btnCorruptTextures = document.getElementById("btn-corrupt-textures");
  const btnCorruptPalette = document.getElementById("btn-corrupt-palette");
  const btnCorruptAudio = document.getElementById("btn-corrupt-audio");
  const btnScrambleChr = document.getElementById("btn-scramble-chr");
  const btnGlitchTileMap = document.getElementById("btn-glitch-tile-map");
  const btnCorruptBackgroundPalette = document.getElementById("btn-corrupt-bg-palette");
  const btnCorruptSpritePalette = document.getElementById("btn-corrupt-sprite-palette");
  const btnAutoCorrupt = document.getElementById("btn-auto-corrupt");
  const autoCorruptIntervalInput = document.getElementById("auto-corrupt-interval");
  const btnGameCycle = document.getElementById("btn-game-cycle");
  const btnUpdates = document.getElementById("btn-updates");
  const btnToggleBottomControls = document.getElementById("btn-toggle-bottom-controls");
  const btnCorruptPress = document.getElementById("btn-corrupt-press");
  const updatesOverlay = document.getElementById("updates-overlay");
  const btnCloseUpdates = document.getElementById("btn-close-updates");
  const tutorialOverlay = document.getElementById("tutorial-overlay");
  const btnCloseTutorial = document.getElementById("btn-close-tutorial");
  
  // Torrent UI elements
  const btnLoadTorrent = document.getElementById("btn-load-torrent");
  const btnListTorrent = document.getElementById("btn-list-torrent");
  const torrentOverlay = document.getElementById("torrent-overlay");
  const torrentListEl = document.getElementById("torrent-list");
  const btnCloseTorrent = document.getElementById("btn-close-torrent");

  const corruptionInfo = document.getElementById("corruption-info");
  const btnToggleEditor = document.getElementById("btn-toggle-editor");
  const memEditorPanel = document.getElementById("mem-editor-panel");
  const memHexView = document.getElementById("mem-hex-view");

  // ... (corruptionMetadata, custom corruption code and other UI logic remain unchanged) ...
  // For brevity we keep the rest of the implementation identical to the original, but
  // we will rely on AVAILABLE_GAMES (below) instead of using GAME_LIST directly when populating.

  const corruptionMetadata = {
    random: { desc: "Scatters random values across memory.", severity: "Medium", category: "Safe / Gentle" },
    light_random: { desc: "Very gentle random nudges to a few bytes; designed to be non-crashing.", severity: "Low", category: "Safe / Gentle" },
    bitflip: { desc: "Flips individual bits. Subtle logic glitches.", severity: "Medium", category: "Safe / Gentle" },
    light_bitflip: { desc: "Flips low-significance bits only (LSB/bit1) for safe, subtle glitches.", severity: "Low", category: "Safe / Gentle" },

    byteswap: { desc: "Swaps adjacent bytes. High instability.", severity: "Extreme", category: "Graphics / Assets" },
    checkerboard: { desc: "Corrupts every other byte in a block.", severity: "Medium", category: "Graphics / Assets" },
    texturevomit: { desc: "Destroys graphics tile pointers.", severity: "High", category: "Graphics / Assets" },
    assetscramble: { desc: "Performs many small cross-swaps between map, sprite, palette and music slices.", severity: "High", category: "Graphics / Assets" },
    clusterbytes: { desc: "Concentrated corruption in one area.", severity: "High", category: "Graphics / Assets" },

    worldlevel: { desc: "Grand Dad specific environmental hacks.", severity: "Variable", category: "World / Level" },
    blockscramble: { desc: "Shuffles level block data inside map regions to jumble platforms and tiles.", severity: "High", category: "World / Level" },
    levelscrambler: { desc: "Aggressively reorders map rows/columns, swaps tile ranges and mutates tiles to scramble level geometry.", severity: "Extreme", category: "World / Level" },
    powerupscramble: { desc: "Randomizes power-up/pickup bytes and toggles power-up flags for unpredictable pickups.", severity: "High", category: "World / Level" },
    enemyscramble: { desc: "Permutes enemy/object table entries to swap enemy types/positions.", severity: "High", category: "World / Level" },

    music: { desc: "Messes with music IDs and sound control bytes for stutters/pitch-shifts; also injects audio noise for immediate sonic corruption.", severity: "High", category: "Audio / Music" },
    musicswap: { desc: "Swaps music IDs/control bytes between random slots to make tracks jump or play other level themes.", severity: "High", category: "Audio / Music" },

    swapper: { desc: "Swaps larger memory regions or blocks, potentially exchanging level or music tables for unexpected results.", severity: "High", category: "Logic / Behavior" },
    numberscramble: { desc: "Scrambles counters/pointers and rotates digit nibbles to create odd scores/timers.", severity: "High", category: "Logic / Behavior" },
    logicscramble: { desc: "Flips logic/flag bytes and permutes object tables to alter game behavior.", severity: "High", category: "Logic / Behavior" },

    xor: { desc: "Patterned math corruption via XOR.", severity: "Medium", category: "Bitwise / Math" },
    scramble: { desc: "Shuffles memory locations around.", severity: "High", category: "Bitwise / Math" },
    or: { desc: "Forces bits ON. Stuck sprites/colors.", severity: "Medium", category: "Bitwise / Math" },
    and: { desc: "Forces bits OFF. Missing objects.", severity: "Medium", category: "Bitwise / Math" },
    nand: { desc: "Inverted logic corruption. Very chaotic.", severity: "High", category: "Bitwise / Math" },
    not: { desc: "Inverts all bits. Psycho visuals.", severity: "High", category: "Bitwise / Math" },
    binaryswap: { desc: "Flip individual bits at random addresses (1↔0 swaps on bit level).", severity: "Medium", category: "Bitwise / Math" },
    completebinaryswap: { desc: "Invert every byte in RAM (bitwise NOT applied to the shown range). This is extremely disruptive and will flip booleans, pointers and most game logic.", severity: "Extreme", category: "Bitwise / Math" },

    everybyte: { desc: "Total memory wipe with random noise.", severity: "Fatal", category: "Bitwise / Math" }
  };

  // Load saved custom corruptions from localStorage ("cloud")
  const CUSTOM_KEY = "custom_corruptions_v1";
  const loadCustomCorruptions = () => {
    try {
      const raw = localStorage.getItem(CUSTOM_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.warn("Failed to load custom corruptions:", e);
      return [];
    }
  };

  const saveCustomCorruptions = (arr) => {
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(arr));
    } catch (e) {
      console.warn("Failed to save custom corruptions:", e);
    }
  };

  const customList = loadCustomCorruptions();

  // Add custom entries to corruptionMetadata so they show up in the info panel once loaded
  customList.forEach(c => {
    if (c && c.id && !corruptionMetadata[c.id]) {
      corruptionMetadata[c.id] = { desc: c.desc || "(custom)", severity: "User", category: "Custom" };
    }
  });

  const updateCorruptionBlerp = () => {
    const val = corruptionType.value;
    const meta = corruptionMetadata[val];
    if (meta) {
      corruptionInfo.innerHTML = `<strong>${meta.severity} severity:</strong> ${meta.desc}`;
    } else {
      // custom unknown placeholder
      const custom = (customList.find(c=>c.id===val) || {});
      corruptionInfo.innerHTML = `<strong>${custom.name || "Custom"}:</strong> ${custom.desc || "User-defined corruption."}`;
    }
  };

  corruptionType.addEventListener("change", updateCorruptionBlerp);
  updateCorruptionBlerp();

  // Populate custom corruptions into the select (after built-ins)
  const populateCustomOptions = () => {
    // remove any existing custom options first
    Array.from(corruptionType.querySelectorAll('option[data-custom="1"]')).forEach(o => o.remove());
    customList.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.name} (custom)`;
      opt.setAttribute("data-custom", "1");
      corruptionType.appendChild(opt);
      // register metadata placeholder if missing
      if (!corruptionMetadata[c.id]) corruptionMetadata[c.id] = { desc: c.desc || "(custom)", severity: "User", category: "Custom" };
    });
    updateCorruptionBlerp();
  };
  populateCustomOptions();

  let editorOpen = false;
  // Track when the user is actively editing the RAM textarea to avoid overwriting their edits.
  // Use an inactivity timeout so brief interactions don't permanently lock updates.
  let memEditing = false;
  let memEditingTimer = null;
  // Debounce timer for auto-applying memory edits
  let memApplyTimer = null;
  const startMemEditing = () => {
    memEditing = true;
    if (memEditingTimer) clearTimeout(memEditingTimer);
    // clear the flag after 2s of inactivity
    memEditingTimer = setTimeout(() => { memEditing = false; memEditingTimer = null; }, 2000);
  };
  const stopMemEditing = () => {
    memEditing = false;
    if (memEditingTimer) { clearTimeout(memEditingTimer); memEditingTimer = null; }
  };

  if (memHexView) {
    memHexView.addEventListener("focus", startMemEditing);
    memHexView.addEventListener("blur", stopMemEditing);
    // Also mark editing when user clicks into the textarea using pointer events
    memHexView.addEventListener("pointerdown", startMemEditing);
    // Consider typing and other input as editing; reset inactivity timeout on every input/keydown
    memHexView.addEventListener("input", startMemEditing);
    memHexView.addEventListener("keydown", startMemEditing);
    // For safety, if the user explicitly applies changes, clear the editing lock so the view can be refreshed
    // (btnApplyMem handler below already applies memory; ensure it also clears the editing flag)
  }

  btnToggleEditor.addEventListener("click", () => {
    editorOpen = !editorOpen;
    memEditorPanel.classList.toggle("show", editorOpen);
    btnToggleEditor.textContent = editorOpen ? "Close RAM Editor" : "Live RAM Editor";
    // When opening, focus the editor so the user can start typing; when closing, ensure editing flag clears
    if (editorOpen && memHexView) {
      memHexView.focus();
    } else {
      memEditing = false;
      if (memHexView) memHexView.blur();
    }
  });

  const updateMemView = () => {
    // Only update when the editor is open and the emulator is ready
    if (!editorOpen || !emu || !emu.nes || !emu.nes.cpu) return;
    // Avoid overwriting while the user is actively editing (focus/blur + pointerdown set memEditing)
    if (typeof memEditing !== "undefined" && memEditing) return;

    const mem = emu.nes.cpu.mem;
    let hex = "";
    // Only show the first 512 bytes for performance/usability
    for (let i = 0; i < 512; i++) {
      hex += mem[i].toString(16).padStart(2, '0') + ( (i+1)%16 === 0 ? "\n" : " " );
    }
    // Only write back to the textarea if it exists and the user is not editing
    if (memHexView) memHexView.value = hex.trim();
  };

  setInterval(updateMemView, 1000);

  // Auto-apply memory edits with a short debounce so typing doesn't flood writes.
  if (memHexView) {
    memHexView.addEventListener("input", () => {
      // mark as editing while typing to avoid live-view clobber
      startMemEditing();
      if (memApplyTimer) clearTimeout(memApplyTimer);
      memApplyTimer = setTimeout(() => {
        if (!emu || !emu.nes || !emu.nes.cpu) return;
        const parts = memHexView.value.trim().split(/\s+/);
        const mem = emu.nes.cpu.mem;
        parts.forEach((h, i) => {
          if (i < 0x0800) {
            const val = parseInt(h, 16);
            if (!isNaN(val)) mem[i] = val & 0xFF;
          }
        });
        // After auto-applying, release the editing lock so live view can refresh.
        stopMemEditing();
        statusEl.textContent = "Memory auto-applied";
      }, 300); // 300ms debounce
    });
  }

  // Make canvas focusable
  canvas.tabIndex = 0;
  canvas.addEventListener("pointerdown", () => canvas.focus());

  let corruptWhenPressActive = false;
  let autoCorruptTimer = null;

  // Create emulator
  let emu = null;
  let macroRecording = null;
  let macroPlayback = null;
  try {
    emu = new Emulator({
      canvas,
      onStatus: (msg) => { if(statusEl) statusEl.textContent = msg; },
      onButtonChange: (bit, down) => {
        if (!macroRecording) return;
        if (macroRecording.events.length >= 10000) { finishMacroRecording("Recording reached its input limit."); return; }
        const frame = Math.max(1, emu.frameCount - macroRecording.startFrame + 1);
        macroRecording.events.push([frame, bit, down]);
      },
      onLogicalFrame: (frame) => processMacroFrame(frame),
      onFPSUpdate: (fps, cps, sps) => {
        if (fpsEl) fpsEl.textContent = "FPS: " + fps;
        if (cpsEl) cpsEl.textContent = "CPS: " + cps;
        if (spsEl) spsEl.textContent = "SPS: " + Number(sps || 0).toFixed(2);
      },
      onButtonDown: (bit) => {
        if (corruptWhenPressActive) triggerCorruptFromUI();
        if (bit === 5 && emu?.warpAllPipes) {
          const mem = emu.nes?.cpu?.mem;
          if (mem) {
            const x = mem[0x006D] * 256 + mem[0x0086];
            const y = mem[0x00CE];
            const column = (Math.floor(x / 16) + 4) % 16;
            const tile = 0x0500 + (Math.floor(y / 16) * 16) + column;
            if ([mem[tile], mem[tile - 16], mem[tile + 16]].some(value => value >= 0x10 && value <= 0x13)) {
              const target = emu.setSMBWorldLevel(emu.warpTargetWorld, 1, document.getElementById("entry-form").value);
              if (target) modStatus("Warp pipe: World " + target.world + "-" + target.level + ".");
            }
          }
        }
      }
    });
  } catch (err) {
    console.error("Emulator init failed:", err);
    statusEl.textContent = "Error initializing emulator engine.";
  }

  const warpStatus = document.getElementById("warp-status");
  document.getElementById("btn-set-time")?.addEventListener("click", () => {
    const time = emu?.setSMBTime(document.getElementById("time-value").value) ?? null;
    if (warpStatus) warpStatus.textContent = time === null ? "Load Super Mario Bros. first." : "Time set to " + time + ".";
  });
  document.getElementById("btn-set-world-level")?.addEventListener("click", () => {
    const result = emu?.setSMBWorldLevel(
      document.getElementById("world-value").value,
      document.getElementById("level-value").value,
      document.getElementById("entry-form").value
    ) ?? null;
    if (warpStatus) warpStatus.textContent = result === null
      ? "Could not load SMB area data."
      : "Entered World " + result.world + "-" + result.level + ".";
  });
  document.getElementById("btn-set-lives")?.addEventListener("click", () => {
    const lives = emu?.setSMBLives(document.getElementById("lives-value").value) ?? null;
    if (warpStatus) warpStatus.textContent = lives === null ? "Load Super Mario Bros. first." : "Lives set to " + lives + ".";
  });
  const questionBlockReward = document.getElementById("question-block-reward");
  questionBlockReward.addEventListener("change", (event) => {
    const reward = emu?.setQuestionBlockReward(event.target.value) ?? null;
    updateOneUpChance();
    modStatus(reward ? "Question blocks now give: " + reward + "." : "Choose a valid question-block reward.");
  });
  const oneUpEnabled = document.getElementById("oneup-enabled");
  const oneUpChance = document.getElementById("oneup-chance");
  const oneUpChanceLabel = document.getElementById("oneup-chance-label");
  const updateOneUpChance = () => {
    const overridden = questionBlockReward.value !== "default";
    const chance = !overridden && oneUpEnabled.checked ? Number(oneUpChance.value) : 0;
    emu?.setQuestionBlockOneUpChance(chance);
    oneUpEnabled.disabled = overridden;
    oneUpChance.disabled = overridden;
    oneUpChanceLabel.textContent = overridden ? "Overridden" : oneUpEnabled.checked ? chance + "%" : "Off";
  };
  oneUpEnabled.addEventListener("change", updateOneUpChance);
  oneUpChance.addEventListener("input", updateOneUpChance);
  updateOneUpChance();

  const modStatus = (text) => { if (warpStatus) warpStatus.textContent = text; };
  ["fly", "noclip", "immortal"].forEach((ability) => {
    const checkbox = document.getElementById("ability-" + ability);
    checkbox.addEventListener("change", () => {
      const result = emu?.setPlayerAbility(ability, checkbox.checked) ?? null;
      modStatus(result === null ? "Load Super Mario Bros. to use abilities." : ability + (result ? " enabled." : " disabled."));
    });
  });
  document.getElementById("movement-mode").addEventListener("change", (event) => {
    const mode = emu?.setMovementMode(event.target.value) ?? null;
    modStatus(mode === null ? "Load Super Mario Bros. to change movement." : "Movement set to " + mode + ".");
  });
  document.getElementById("btn-set-koopa-wake").addEventListener("click", () => {
    const ticks = emu?.setKoopaWakeTicks(document.getElementById("koopa-wake").value) ?? null;
    modStatus(ticks === null ? "Load Super Mario Bros. to set koopa timing." : "Koopas wake after " + ticks + " ticks.");
  });
  document.getElementById("btn-set-coins").addEventListener("click", () => {
    const coins = emu?.setCoins(document.getElementById("coins-value").value) ?? null;
    modStatus(coins === null ? "Load Super Mario Bros. to set coins." : "Coins set to " + coins + ".");
  });
  document.getElementById("btn-set-oneup-lives").addEventListener("click", () => {
    const lives = emu?.setOneUpLives(document.getElementById("oneup-lives").value) ?? null;
    modStatus(lives === null ? "Invalid 1-Up life amount." : "Each 1-Up now gives " + lives + " life(s).");
  });
  document.getElementById("mute-game-audio").addEventListener("change", (event) => {
    emu?.setMute(event.target.checked);
    modStatus(event.target.checked ? "Game audio muted." : "Game audio restored.");
  });
  document.getElementById("spawn-enemy").addEventListener("change", (event) => {
    document.getElementById("btn-spawn-enemy").dataset.enemy = event.target.value;
  });
  document.getElementById("btn-spawn-enemy").addEventListener("click", () => {
    const kind = document.getElementById("spawn-enemy").value;
    const spawned = emu?.spawnEnemy(kind) ?? false;
    modStatus(spawned ? "Summoned: " + kind + "." : "Could not spawn it. Load Super Mario Bros. and free an object slot.");
  });
  document.getElementById("btn-set-score").addEventListener("click", () => {
    const score = emu?.setScore(document.getElementById("score-value").value) ?? null;
    modStatus(score === null ? "Load Super Mario Bros. to set score." : "Score set to " + score + ".");
  });
  const timewarpSlider = document.getElementById("timewarp-speed");
  const timewarpLabel = document.getElementById("timewarp-speed-label");
  const applyTimewarpSpeed = (value) => {
    const speed = Math.max(0.1, Math.min(20, Number(value) || 1));
    timewarpSlider.value = String(speed);
    timewarpLabel.value = speed.toFixed(1) + "x";
    document.getElementById("speed-value").value = String(speed);
    emu?.setSpeed(speed);
    return speed;
  };
  timewarpSlider.addEventListener("input", (event) => applyTimewarpSpeed(event.target.value));
  document.getElementById("btn-set-speed").addEventListener("click", () => {
    const speed = applyTimewarpSpeed(document.getElementById("speed-value").value);
    modStatus("Game speed set to " + speed.toFixed(1) + "x.");
  });
  document.getElementById("btn-set-jump").addEventListener("click", () => {
    const height = Math.max(0.5, Math.min(2, Number(document.getElementById("jump-height").value) || 1));
    document.getElementById("jump-height").value = String(height);
    if (emu) emu.jumpHeight = height;
    modStatus("Jump height set to " + height + "x.");
  });
  document.getElementById("game-theme").addEventListener("change", (event) => {
    const theme = emu?.setTheme(event.target.value) ?? null;
    modStatus(theme ? "Theme set to " + theme + "." : "Load a game to change its theme.");
  });
  document.getElementById("retro-mode").addEventListener("change", (event) => {
    if (emu) emu.retroMode = event.target.checked;
    document.body.classList.toggle("retro-mode", event.target.checked);
    modStatus(event.target.checked ? "Retro green-and-black mode on." : "Retro mode off.");
  });
  document.getElementById("bg-music").addEventListener("change", (event) => {
    const track = emu?.setBackgroundMusic(event.target.value) ?? null;
    modStatus(track ? "Background music set to " + track + "." : "Load Super Mario Bros. to change its music.");
  });
  document.getElementById("warp-all-pipes").addEventListener("change", (event) => {
    const result = emu?.setWarpPipes(event.target.checked, document.getElementById("warp-target").value) ?? null;
    modStatus(result ? (result.enabled ? "Warp pipes target World " + result.world + "." : "Warp pipes off.") : "Load Super Mario Bros. first.");
  });
  document.getElementById("warp-target").addEventListener("change", (event) => {
    if (emu?.warpAllPipes) emu.setWarpPipes(true, event.target.value);
  });
  document.getElementById("sprite-color").addEventListener("change", (event) => {
    const color = emu?.setSpriteColor(event.target.value) ?? null;
    modStatus(color === null ? "Sprite color is unavailable for this ROM." : "Sprite color set to " + color + ".");
  });
  document.getElementById("sprite-texture").addEventListener("change", (event) => {
    const texture = emu?.setSpriteTexture(event.target.value) ?? null;
    modStatus(texture === null ? "Sprite texture is unavailable for this ROM." : "Sprite texture set to " + texture + ".");
  });
  document.getElementById("btn-write-ram").addEventListener("click", () => {
    const addressText = document.getElementById("raw-address").value.trim().replace(/^0x/i, "");
    const address = Number.parseInt(addressText, 16);
    const value = Number(document.getElementById("raw-value").value);
    const result = emu?.setRawRAM(address, value) ?? null;
    modStatus(result === null ? "RAM writes are limited to 0x0000-0x07FF." : "Wrote 0x" + result.value.toString(16).padStart(2, "0").toUpperCase() + " to 0x" + result.address.toString(16).padStart(4, "0").toUpperCase() + ".");
  });

  document.getElementById("btn-restart-game")?.addEventListener("click", () => {
    if (!emu?.romData) {
      if (warpStatus) warpStatus.textContent = "No game loaded.";
      return;
    }
    if (macroRecording) finishMacroRecording("Recording stopped after reset.");
    if (macroPlayback) finishMacroPlayback("Playback stopped after reset.");
    emu.reset();
    emu.start();
    pauseOverlay?.classList.remove("show");
    canvas.focus();
  });

  const aiToggle = document.getElementById("btn-ai-toggle");
  const aiChat = document.getElementById("ai-chat");
  const aiMessages = document.getElementById("ai-messages");
  const aiForm = document.getElementById("ai-form");
  const aiInput = document.getElementById("ai-input");
  const aiSend = document.getElementById("ai-send");
  const aiHistory = [];
  const addAIMessage = (role, text) => {
    const message = document.createElement("div");
    message.className = "ai-message " + role;
    message.textContent = text;
    aiMessages.appendChild(message);
    aiMessages.scrollTop = aiMessages.scrollHeight;
  };

  aiToggle?.addEventListener("click", () => {
    const show = aiChat.hidden;
    aiChat.hidden = !show;
    aiToggle.setAttribute("aria-expanded", String(show));
    aiToggle.textContent = show ? "Close AI" : "Ask AI";
    if (show) aiInput.focus();
  });

  aiForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = aiInput.value.trim();
    if (!prompt || aiSend.disabled) return;
    aiInput.value = "";
    aiSend.disabled = true;
    aiInput.disabled = true;
    addAIMessage("user", prompt);
    aiHistory.push({ role: "user", content: prompt });

    try {
      const completion = await window.websim.chat.completions.create({
        messages: [
          {
            role: "system",
            content: "You control a Super Mario Bros. NES emulator through validated settings and bounded RAM byte writes. Supported: world/level, time, lives, score, coins, speed 0.1-20, jump height 0.5-2, retro green/black mode, palette theme, background music, question-block rewards (star, mushroom, coin, or Goomba), warp pipes and destination, player form, abilities, movement, audio, sprite palette/texture, and spawn all SMB enemies: Goomba, Green/Red Koopa Troopa, Green/Red Paratroopa, Buzzy Beetle, Spiny, Spiny Egg, Lakitu, Hammer Bro, Piranha Plant, Bowser, Bowser's Flame, Bullet Bill, Green/Red Cheep-Cheep, or Podoboo. Also summon 1-Up, coin, star, flower, hammer, firebar, mushroom, or pipe. Other game data may be changed using up to 32 raw CPU RAM byte writes at decimal addresses 0-2047. Leave unchanged values null and rawWrites empty. Never generate or execute JavaScript or machine code. Raw writes must be bytes. Do not claim changes that were not applied."
          },
          ...aiHistory.slice(-10)
        ],
        schema: {
          type: "object",
          properties: {
            reply: { type: "string" },
            changes: {
              type: "object",
              properties: {
                world: { type: ["integer", "null"], minimum: 1, maximum: 256 },
                level: { type: ["integer", "null"], minimum: 1, maximum: 256 },
                time: { type: ["integer", "null"], minimum: 0, maximum: 999 },
                lives: { type: ["integer", "null"], minimum: 1, maximum: 99 },
                form: {
                  type: ["string", "null"],
                  enum: [null, "small", "big", "small-fire", "big-fire", "star-small", "star-big", "star-small-fire", "star-big-fire"]
                },
                oneUpChance: { type: ["integer", "null"], minimum: 0, maximum: 100 },
                questionBlockReward: { type: ["string", "null"], enum: [null, "default", "star", "mushroom", "coin", "goomba"] },
                oneUpLives: { type: ["integer", "null"], minimum: 1, maximum: 9 },
                fly: { type: ["boolean", "null"] },
                noclip: { type: ["boolean", "null"] },
                immortal: { type: ["boolean", "null"] },
                movement: { type: ["string", "null"], enum: [null, "default", "platformer", "swimming"] },
                koopaWakeTicks: { type: ["integer", "null"], minimum: 0, maximum: 255 },
                coins: { type: ["integer", "null"], minimum: 0, maximum: 99 },
                muteAudio: { type: ["boolean", "null"] },
                spawnEnemy: { type: ["string", "null"], enum: [null, "goomba", "koopa", "green-koopa", "red-koopa", "green-paratroopa", "red-paratroopa", "spiny", "buzzy-beetle", "piranha-plant", "spiny-egg", "lakitu", "hammer-bro", "bowser", "bowser-flame", "bulletbill", "green-cheep-cheep", "red-cheep-cheep", "cheep-cheep", "podoboo", "mushroom", "1up", "coin", "star", "fire-flower", "hammer", "firebar", "pipe"] },
                score: { type: ["integer", "null"], minimum: 0, maximum: 999999 },
                speed: { type: ["number", "null"], minimum: 0.1, maximum: 20 },
                jumpHeight: { type: ["number", "null"], minimum: 0.5, maximum: 2 },
                retroMode: { type: ["boolean", "null"] },
                theme: { type: ["string", "null"], enum: [null, "classic", "underground", "underwater", "sunset"] },
                music: { type: ["string", "null"], enum: [null, "overworld", "underground", "underwater", "castle", "silence"] },
                warpAllPipes: { type: ["boolean", "null"] },
                warpTargetWorld: { type: ["integer", "null"], minimum: 1, maximum: 256 },
                spriteColor: { type: ["string", "null"], enum: [null, "default", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "white"] },
                spriteTexture: { type: ["string", "null"], enum: [null, "normal", "mirror", "glitch"] },
                rawWrites: {
                  type: "array",
                  maxItems: 32,
                  items: {
                    type: "object",
                    properties: {
                      address: { type: "integer", minimum: 0, maximum: 2047 },
                      value: { type: "integer", minimum: 0, maximum: 255 }
                    },
                    required: ["address", "value"],
                    additionalProperties: false
                  }
                }
              },
              required: ["world", "level", "time", "lives", "form", "oneUpChance", "questionBlockReward", "oneUpLives", "fly", "noclip", "immortal", "movement", "koopaWakeTicks", "coins", "muteAudio", "spawnEnemy", "score", "speed", "jumpHeight", "retroMode", "theme", "music", "warpAllPipes", "warpTargetWorld", "spriteColor", "spriteTexture", "rawWrites"],
              additionalProperties: false
            }
          },
          required: ["reply", "changes"],
          additionalProperties: false
        }
      });
      const result = JSON.parse(completion.content);
      const changes = result.changes;
      const applied = [];
      let unavailable = false;

      if (changes.world !== null || changes.level !== null) {
        const worldInput = document.getElementById("world-value");
        const levelInput = document.getElementById("level-value");
        const formInput = document.getElementById("entry-form");
        if (changes.world !== null) worldInput.value = String(changes.world);
        if (changes.level !== null) levelInput.value = String(changes.level);
        if (changes.form !== null) formInput.value = changes.form;
        const entered = emu?.setSMBWorldLevel(worldInput.value, levelInput.value, formInput.value);
        if (entered) applied.push("entered world " + entered.world + "-" + entered.level);
        else unavailable = true;
      } else if (changes.form !== null) {
        document.getElementById("entry-form").value = changes.form;
        if (emu?.setSMBForm(changes.form)) applied.push("changed Mario's form");
        else unavailable = true;
      }
      if (changes.time !== null) {
        document.getElementById("time-value").value = String(changes.time);
        const appliedTime = emu?.setSMBTime(changes.time) ?? null;
        if (appliedTime !== null) applied.push("set time to " + appliedTime);
        else unavailable = true;
      }
      if (changes.lives !== null) {
        document.getElementById("lives-value").value = String(changes.lives);
        const appliedLives = emu?.setSMBLives(changes.lives) ?? null;
        if (appliedLives !== null) applied.push("set lives to " + appliedLives);
        else unavailable = true;
      }
      if (changes.oneUpChance !== null) {
        oneUpEnabled.checked = true;
        oneUpChance.value = String(changes.oneUpChance);
        updateOneUpChance();
        applied.push("set the 1-Up chance to " + oneUpChance.value + "%");
      }
      if (changes.questionBlockReward !== null) {
        questionBlockReward.value = changes.questionBlockReward;
        updateOneUpChance();
        if (emu?.setQuestionBlockReward(changes.questionBlockReward)) applied.push("question blocks set to " + changes.questionBlockReward);
        else unavailable = true;
      }
      if (changes.oneUpLives !== null) {
        document.getElementById("oneup-lives").value = String(changes.oneUpLives);
        if ((emu?.setOneUpLives(changes.oneUpLives) ?? null) !== null) applied.push(changes.oneUpLives + " life(s) per 1-Up");
      }
      for (const ability of ["fly", "noclip", "immortal"]) {
        if (changes[ability] === null) continue;
        document.getElementById("ability-" + ability).checked = changes[ability];
        if (emu?.setPlayerAbility(ability, changes[ability]) !== null) applied.push(ability + (changes[ability] ? " on" : " off"));
        else unavailable = true;
      }
      if (changes.movement !== null) {
        document.getElementById("movement-mode").value = changes.movement;
        if ((emu?.setMovementMode(changes.movement) ?? null) !== null) applied.push("movement " + changes.movement);
        else unavailable = true;
      }
      if (changes.koopaWakeTicks !== null) {
        document.getElementById("koopa-wake").value = String(changes.koopaWakeTicks);
        const ticks = emu?.setKoopaWakeTicks(changes.koopaWakeTicks) ?? null;
        if (ticks !== null) applied.push("koopa wake-up " + ticks + " ticks");
        else unavailable = true;
      }
      if (changes.coins !== null) {
        document.getElementById("coins-value").value = String(changes.coins);
        const coins = emu?.setCoins(changes.coins) ?? null;
        if (coins !== null) applied.push(coins + " coins");
        else unavailable = true;
      }
      if (changes.muteAudio !== null) {
        document.getElementById("mute-game-audio").checked = changes.muteAudio;
        emu?.setMute(changes.muteAudio);
        applied.push(changes.muteAudio ? "muted game audio" : "restored game audio");
      }
      if (changes.spawnEnemy !== null) {
        document.getElementById("spawn-enemy").value = changes.spawnEnemy;
        if (emu?.spawnEnemy(changes.spawnEnemy)) applied.push("summoned " + changes.spawnEnemy);
        else unavailable = true;
      }
      if (changes.score !== null) {
        document.getElementById("score-value").value = String(changes.score);
        const score = emu?.setScore(changes.score) ?? null;
        if (score !== null) applied.push("score " + score); else unavailable = true;
      }
      if (changes.speed !== null) {
        const speed = applyTimewarpSpeed(changes.speed);
        applied.push("speed " + speed.toFixed(1) + "x");
      }
      if (changes.jumpHeight !== null) {
        document.getElementById("jump-height").value = String(changes.jumpHeight);
        if (emu) emu.jumpHeight = changes.jumpHeight;
        applied.push("jump height " + changes.jumpHeight + "x");
      }
      if (changes.retroMode !== null) {
        document.getElementById("retro-mode").checked = changes.retroMode;
        document.body.classList.toggle("retro-mode", changes.retroMode);
        if (emu) emu.retroMode = changes.retroMode;
        applied.push(changes.retroMode ? "retro mode on" : "retro mode off");
      }
      if (changes.theme !== null) {
        document.getElementById("game-theme").value = changes.theme;
        if (emu?.setTheme(changes.theme)) applied.push("theme " + changes.theme);
        else unavailable = true;
      }
      if (changes.music !== null) {
        document.getElementById("bg-music").value = changes.music;
        if (emu?.setBackgroundMusic(changes.music)) applied.push("music " + changes.music); else unavailable = true;
      }
      if (changes.warpTargetWorld !== null) {
        document.getElementById("warp-target").value = String(changes.warpTargetWorld);
        emu?.setWarpPipes(document.getElementById("warp-all-pipes").checked, changes.warpTargetWorld);
        applied.push("warp destination World " + changes.warpTargetWorld);
      }
      if (changes.warpAllPipes !== null) {
        document.getElementById("warp-all-pipes").checked = changes.warpAllPipes;
        const warp = emu?.setWarpPipes(changes.warpAllPipes, document.getElementById("warp-target").value);
        if (warp) applied.push(changes.warpAllPipes ? "warp pipes to World " + warp.world : "warp pipes off"); else unavailable = true;
      }
      if (changes.spriteColor !== null) {
        document.getElementById("sprite-color").value = changes.spriteColor;
        if ((emu?.setSpriteColor(changes.spriteColor) ?? null) !== null) applied.push("sprite color " + changes.spriteColor);
        else unavailable = true;
      }
      if (changes.spriteTexture !== null) {
        document.getElementById("sprite-texture").value = changes.spriteTexture;
        if ((emu?.setSpriteTexture(changes.spriteTexture) ?? null) !== null) applied.push("sprite texture " + changes.spriteTexture);
        else unavailable = true;
      }
      if (changes.rawWrites.length) {
        let writes = 0;
        for (const write of changes.rawWrites.slice(0, 32)) {
          if (emu?.setRawRAM(write.address, write.value)) writes++;
          else unavailable = true;
        }
        if (writes) applied.push("wrote " + writes + " raw RAM byte(s)");
      }

      aiHistory.push({ role: "assistant", content: completion.content });
      let response = result.reply;
      if (applied.length) response += "\n\nApplied: " + applied.join(", ") + ".";
      if (unavailable) response += "\n\nLoad the built-in Super Mario Bros. ROM to apply those changes.";
      addAIMessage("assistant", response);
    } catch (error) {
      addAIMessage("assistant", "I couldn't apply that request. Try again.");
      console.error("Game AI request failed:", error);
    } finally {
      aiSend.disabled = false;
      aiInput.disabled = false;
      aiInput.focus();
    }
  });

  // Torrent parsing: fetch and parse the bundled torrent file and expose file list
  // Uses parse-torrent from importmap
  import("parse-torrent").then(async ({ default: parseTorrent }) => {
    // ensure Buffer is available in the browser for parse-torrent
    const { Buffer } = await import("buffer");

    const TORRENT_PATH = "/NESMegaPack201808_archive.torrent";
    let lastTorrentMeta = null;

    const showTorrentOverlay = (show) => {
      if (!torrentOverlay) return;
      torrentOverlay.classList.toggle("show", show);
      torrentOverlay.setAttribute("aria-hidden", String(!show));
    };

    const fetchAndParseTorrent = async () => {
      try {
        statusEl.textContent = "Fetching torrent...";
        const res = await fetch(TORRENT_PATH);
        if (!res.ok) throw new Error(`Failed to fetch torrent: ${res.status}`);
        const ab = await res.arrayBuffer();
        const buf = new Uint8Array(ab);
        // parse-torrent accepts Buffer-like; use Buffer.from to construct the expected object
        const meta = parseTorrent(Buffer.from(buf));
        lastTorrentMeta = meta;
        // Build file list UI
        if (torrentListEl) {
          torrentListEl.innerHTML = "";
          if (meta && Array.isArray(meta.files) && meta.files.length) {
            const ul = document.createElement("ul");
            ul.style.padding = "0 12px";
            ul.style.margin = "0";
            ul.style.listStyle = "none";
            meta.files.forEach((f, i) => {
              const li = document.createElement("li");
              li.style.padding = "6px 0";
              li.style.borderBottom = "1px dashed rgba(255,255,255,0.04)";
              li.textContent = `${f.name} (${f.length} bytes)`;
              // attempt quick action: if filename ends with .nes, allow immediate load by clicking
              if (f.name.toLowerCase().endsWith(".nes")) {
                li.style.cursor = "pointer";
                li.title = "Click to try to load this file (requires CORS-enabled server to fetch by name)";
                li.addEventListener("click", async () => {
                  showTorrentOverlay(false);
                  statusEl.textContent = `Attempting to load ${f.name} from server path...`;
                  // Try to fetch by name relative to server root; many hosts won't expose raw files from a torrent,
                  // but if a server has the file at root we attempt it.
                  const tryPath = "/" + encodeURIComponent(f.name);
                  try {
                    await emu.reset();
                    await emu.loadROM(tryPath);
                    statusEl.textContent = `Loaded ${f.name} (from ${tryPath}). Press Start.`;
                  } catch (err) {
                    console.warn("Load attempt failed:", err);
                    statusEl.textContent = `Could not fetch ${f.name} from ${tryPath}.`;
                  }
                });
              }
              ul.appendChild(li);
            });
            torrentListEl.appendChild(ul);
          } else {
            torrentListEl.textContent = "No file list available in torrent or parsing returned no files.";
          }
        }
        statusEl.textContent = `Torrent parsed: ${meta.name || "Unnamed"} (${(meta.files||[]).length} files)`;
        if (btnListTorrent) btnListTorrent.style.display = "inline-flex";
      } catch (e) {
        console.error("Torrent parse/fetch error:", e);
        statusEl.textContent = `Torrent parse failed: ${e.message}`;
        if (torrentListEl) torrentListEl.textContent = `Failed to parse torrent: ${e.message}`;
      }
    };

    if (btnLoadTorrent) {
      btnLoadTorrent.addEventListener("click", () => {
        // Fetch+parse the embedded torrent and show results
        fetchAndParseTorrent();
      });
    }
    if (btnListTorrent) {
      btnListTorrent.addEventListener("click", () => {
        showTorrentOverlay(true);
      });
    }
    if (btnCloseTorrent) {
      btnCloseTorrent.addEventListener("click", () => showTorrentOverlay(false));
    }
  }).catch(err => {
    console.warn("parse-torrent import failed:", err);
    if (btnLoadTorrent) btnLoadTorrent.addEventListener("click", () => {
      statusEl.textContent = "Torrent parsing not available.";
    });
  });

  // Before populating the UI, verify which game files actually exist and build AVAILABLE_GAMES
  let AVAILABLE_GAMES = [];
  try {
    // run existence checks in parallel and preserve order for UI
    const checks = await Promise.all(GAME_LIST.map(g => fileExists(g.path).then(ok => ({ ok, g }))));
    AVAILABLE_GAMES = checks.filter(c => c.ok).map(c => c.g);
    if (AVAILABLE_GAMES.length === 0) {
      // fallback: keep at least the first entry so upload/download paths still work
      AVAILABLE_GAMES = [ GAME_LIST[0] ].filter(Boolean);
      statusEl.textContent = "No listed ROM files found on server; use Upload ROM.";
    } else {
      statusEl.textContent = `Found ${AVAILABLE_GAMES.length} ROM(s) on server.`;
    }
  } catch (e) {
    AVAILABLE_GAMES = [ GAME_LIST[0] ];
    statusEl.textContent = "Game availability check failed; use Upload ROM.";
  }

  // Populate game selector with available games and wire up search filtering
  const gameSearch = document.getElementById("game-search");

  const populateGameOptions = (filter = "") => {
    if (!btnGameCycle) return;
    // clear existing options
    btnGameCycle.innerHTML = "";
    // placeholder option
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select Game";
    placeholder.disabled = true;
    placeholder.selected = true;
    btnGameCycle.appendChild(placeholder);

    const query = String(filter || "").trim().toLowerCase();
    let any = false;
    AVAILABLE_GAMES.forEach((game, index) => {
      const name = game.name || "";
      if (query && !name.toLowerCase().includes(query)) return;
      const opt = document.createElement("option");
      opt.value = String(index);
      opt.textContent = name;
      btnGameCycle.appendChild(opt);
      any = true;
    });

    if (!any && query) {
      const noOpt = document.createElement("option");
      noOpt.value = "";
      noOpt.disabled = true;
      noOpt.selected = true;
      noOpt.textContent = "No matching games";
      btnGameCycle.appendChild(noOpt);
    }
  };

  // initial population (uses AVAILABLE_GAMES)
  populateGameOptions();

  // live filter as user types
  if (gameSearch) {
    gameSearch.addEventListener("input", (e) => {
      populateGameOptions(e.target.value);
      // keep focus on search field for rapid typing
      gameSearch.focus();
    });
  }

  let currentGameIndex = 0;

  const loadGameAtIndex = (index) => {
    if (!emu || !AVAILABLE_GAMES.length) return;
    const safeIndex = ((index % AVAILABLE_GAMES.length) + AVAILABLE_GAMES.length) % AVAILABLE_GAMES.length;
    const game = AVAILABLE_GAMES[safeIndex];
    currentGameIndex = safeIndex;

    if (macroRecording) finishMacroRecording("Recording stopped because the game changed.");
    if (macroPlayback) finishMacroPlayback("Playback stopped because the game changed.");
    emu.reset();
    emu.loadROM(game.path).then(() => {
      statusEl.textContent = `${game.name} ready. Press Start.`;
      if (btnDownloadRom) btnDownloadRom.disabled = false;
      if (btnGameCycle) {
        btnGameCycle.value = String(safeIndex);
      }
    }).catch(err => {
      // If a previously detected file disappears or fails to fetch, remove it from AVAILABLE_GAMES and inform user
      console.warn("ROM load failed", err);
      statusEl.textContent = `ROM Error loading ${game.name}. Removed from list.`;
      AVAILABLE_GAMES.splice(safeIndex, 1);
      populateGameOptions();
    });
  };

  // Change-selected game loads immediately (note: value indexes into AVAILABLE_GAMES here)
  if (btnGameCycle) {
    btnGameCycle.addEventListener("change", (e) => {
      const idx = parseInt(e.target.value, 10);
      if (Number.isFinite(idx)) {
        loadGameAtIndex(idx);
      }
    });
  }

  // Bind top buttons immediately
  btnStart.addEventListener("click", () => { 
    if(emu) emu.start(); 
    if (pauseOverlay) pauseOverlay.classList.remove("show");
    canvas.focus(); 
  });
  btnPause.addEventListener("click", () => { 
    if (!emu) return;
    if (emu.isRunning) {
      emu.pause();
      if (pauseOverlay) pauseOverlay.classList.add("show");
    } else if (emu.romData) {
      emu.start();
      if (pauseOverlay) pauseOverlay.classList.remove("show");
    }
    canvas.focus(); 
  });

  let crtOn = false;
  let gbOn = false;
  const screenFrame = document.querySelector(".screen-frame");
  const btnGb = document.getElementById("btn-gameboy");
  const setGb = (on) => {
    gbOn = on;
    if (on) {
      crtOn = false;
      screenFrame.classList.remove("crt");
      btnCrt.textContent = "CRT: Off";
    }
    screenFrame.classList.toggle("gameboy", on);
    document.body.classList.toggle("gameboy", on);
    btnGb.textContent = on ? "Game Boy: On" : "Game Boy: Off";
  };
  const setCrt = (on) => {
    crtOn = on;
    if (on) {
      gbOn = false;
      screenFrame.classList.remove("gameboy");
      document.body.classList.remove("gameboy");
      btnGb.textContent = "Game Boy: Off";
    }
    screenFrame.classList.toggle("crt", on);
    btnCrt.textContent = on ? "CRT: On" : "CRT: Off";
  };
  if (btnCrt && screenFrame) {
    btnCrt.addEventListener("click", () => setCrt(!crtOn));
  }
  if (btnGb && screenFrame) {
    btnGb.addEventListener("click", () => setGb(!gbOn));
  }
  btnReset.addEventListener("click", () => { 
    if (macroRecording) finishMacroRecording("Recording stopped after reset.");
    if (macroPlayback) finishMacroPlayback("Playback stopped after reset.");
    if(emu) emu.reset(); 
    canvas.focus(); 
  });

  // "Reset Game" reloads the current ROM into a fresh, uncorrupted emulator state
  if (btnResetGame) {
    btnResetGame.addEventListener("click", () => {
      if (!emu) return;
      if (!emu.romData) {
        statusEl.textContent = "No ROM loaded to reset.";
        return;
      }
      try {
        if (macroRecording) finishMacroRecording("Recording stopped after reset.");
        if (macroPlayback) finishMacroPlayback("Playback stopped after reset.");
        // Reset emulator to a clean state without reloading or clearing the ROM bytes
        emu.reset();
        statusEl.textContent = "Game reset to clean start. Press Start.";
        canvas.focus();
      } catch (e) {
        console.error("Reset Game failed:", e);
        statusEl.textContent = "Reset Game failed.";
      }
    });
  }

  btnLoadRom.addEventListener("click", () => {
    romUpload.click();
  });

  romUpload.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const name = file.name.toLowerCase();
    const ext = name.split(".").pop();

    // Only NES ROMs are supported in this build
    if (["sfc", "smc", "snes"].includes(ext)) {
      statusEl.textContent = "SNES/SMC/SFC ROMs are not supported here, please use a .nes file.";
      e.target.value = "";
      return;
    }

    if (!emu) return;

    const loadArrayBuffer = (ab, loadedName) => {
      try {
        if (macroRecording) finishMacroRecording("Recording stopped because the game changed.");
        if (macroPlayback) finishMacroPlayback("Playback stopped because the game changed.");
        emu.reset();
        emu.loadROMData(ab);
        statusEl.textContent = `Loaded: ${loadedName}. Press Start.`;
        if (btnDownloadRom) btnDownloadRom.disabled = false;

        // Rename the select game button to the loaded file name
        if (btnGameCycle) {
          const placeholderOpt = btnGameCycle.querySelector('option[value=""]');
          if (placeholderOpt) {
            placeholderOpt.textContent = loadedName;
            placeholderOpt.disabled = false;
            btnGameCycle.value = "";
          }
        }
      } catch (err) {
        statusEl.textContent = "Error loading ROM.";
        console.error("Load ROM error:", err);
      }
    };

    if (ext === "zip") {
      statusEl.textContent = "Unzipping ROM archive...";
      import("jszip").then(async ({ default: JSZip }) => {
        try {
          const zip = await JSZip.loadAsync(file);
          const nesEntry = Object.values(zip.files).find((f) => !f.dir && /\.nes$/i.test(f.name));
          if (!nesEntry) throw new Error("No .nes file found inside the zip.");
          const ab = await nesEntry.async("arraybuffer");
          loadArrayBuffer(ab, nesEntry.name);
        } catch (err) {
          console.error("Zip load failed:", err);
          statusEl.textContent = `Zip load failed: ${err.message}`;
        }
        e.target.value = "";
      }).catch((err) => {
        console.error("JSZip import failed:", err);
        statusEl.textContent = "JSZip failed to load.";
        e.target.value = "";
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      loadArrayBuffer(event.target.result, file.name);
    };
    reader.onerror = () => {
      statusEl.textContent = "Failed to read file.";
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  });

  // Download current loaded ROM (if present)
  if (btnDownloadRom) {
    btnDownloadRom.addEventListener("click", () => {
      if (!emu || !emu.romData) {
        statusEl.textContent = "No ROM to download.";
        return;
      }
      const blob = new Blob([emu.romData], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // try to preserve name if the last loaded game was from the selection, else fallback
      let suggested = (AVAILABLE_GAMES[currentGameIndex] ? AVAILABLE_GAMES[currentGameIndex].name : "download.nes");
      const placeholderOpt = btnGameCycle.querySelector('option[value=""]');
      if (placeholderOpt && placeholderOpt.textContent && placeholderOpt.textContent !== "Select Game") {
        suggested = placeholderOpt.textContent;
      }
      a.download = suggested;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      statusEl.textContent = `Downloaded: ${a.download}`;
    });
  }

  const updateFullscreenButton = () => {
    btnFs.textContent = document.fullscreenElement === screenFrame ? "Exit Fullscreen" : "Fullscreen";
  };
  btnFs.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await screenFrame.requestFullscreen();
      }
    } catch(e) {}
  });
  document.addEventListener("fullscreenchange", updateFullscreenButton);

  volume.addEventListener("input", (e) => {
    if(emu) emu.setVolume(parseFloat(e.target.value));
  });

  let muted = false;
  btnMute.addEventListener("click", () => {
    muted = !muted;
    if(emu) emu.setMute(muted);
    btnMute.textContent = muted ? "Unmute" : "Mute";
  });

  const controlsPanel = document.getElementById("controls-panel");
  const btnChangeControls = document.getElementById("btn-change-controls");
  const btnCloseControls = document.getElementById("btn-close-controls");
  const btnResetControls = document.getElementById("btn-reset-controls");
  const controlsMessage = document.getElementById("controls-message");
  const bindingButtons = [...document.querySelectorAll(".control-binding")];
  const controlLabels = { UP: "Up", DOWN: "Down", LEFT: "Left", RIGHT: "Right", A: "A", B: "B", START: "Start", SELECT: "Select" };
  const displayKey = (code) => ({
    Space: "Space", Enter: "Enter", ShiftLeft: "Left Shift", ShiftRight: "Right Shift",
    ArrowUp: "Up Arrow", ArrowDown: "Down Arrow", ArrowLeft: "Left Arrow", ArrowRight: "Right Arrow",
  })[code] || code.replace(/^Key/, "").replace(/^Digit/, "");
  let capturingControl = null;
  const renderBindings = () => {
    const bindings = emu?.getControlBindings() || {};
    for (const button of bindingButtons) {
      const action = button.dataset.control;
      const keys = bindings[action] || [];
      button.textContent = controlLabels[action] + ": " + (keys.length ? keys.map(displayKey).join(" / ") : "Unbound");
    }
  };
  const stopControlCapture = () => {
    capturingControl = null;
    if (emu) emu.isCapturingControl = false;
    if (controlsMessage) controlsMessage.textContent = "Select a button, then press a key.";
    renderBindings();
  };
  btnChangeControls.addEventListener("click", () => {
    controlsPanel.hidden = !controlsPanel.hidden;
    btnChangeControls.setAttribute("aria-expanded", String(!controlsPanel.hidden));
    if (!controlsPanel.hidden) renderBindings();
    else stopControlCapture();
  });
  btnCloseControls.addEventListener("click", () => {
    controlsPanel.hidden = true;
    btnChangeControls.setAttribute("aria-expanded", "false");
    stopControlCapture();
  });
  bindingButtons.forEach((button) => button.addEventListener("click", () => {
    capturingControl = button.dataset.control;
    if (emu) emu.isCapturingControl = true;
    button.textContent = controlLabels[capturingControl] + ": Press a key...";
    controlsMessage.textContent = "Press a key, or Escape to cancel.";
  }));
  window.addEventListener("keydown", (event) => {
    if (!capturingControl) return;
    event.preventDefault();
    if (event.code === "Escape") {
      stopControlCapture();
      return;
    }
    const action = capturingControl;
    const assigned = emu?.setControlBinding(action, event.code) ?? null;
    if (!assigned) {
      controlsMessage.textContent = "That key is reserved. Choose another.";
      return;
    }
    capturingControl = null;
    emu.isCapturingControl = false;
    controlsMessage.textContent = controlLabels[action] + " assigned to " + displayKey(assigned) + ".";
    renderBindings();
  });
  btnResetControls.addEventListener("click", () => {
    stopControlCapture();
    emu?.resetControlBindings();
    renderBindings();
    controlsMessage.textContent = "Default controls restored.";
  });
  renderBindings();

  const macroOverlay = document.getElementById("macro-overlay");
  const macroNameInput = document.getElementById("macro-name");
  const macroRecordButton = document.getElementById("btn-record-macro");
  const macroPublishButton = document.getElementById("btn-publish-macro");
  const macroStatus = document.getElementById("macro-status");
  const macroList = document.getElementById("macro-list");
  let macroDraft = null;
  let publishedMacros = [];
  try { macroDraft = JSON.parse(localStorage.getItem("webboy_macro_draft") || "null"); } catch {}

  const setMacroStatus = (message) => { macroStatus.textContent = message; };
  const showMacroOverlay = (show) => {
    macroOverlay.classList.toggle("show", show);
    macroOverlay.setAttribute("aria-hidden", String(!show));
  };
  const releaseMacroButtons = (playback) => {
    if (!emu?.nes) return;
    for (const bit of playback.held) emu.nes.buttonUp(1, bit);
    playback.held.clear();
  };
  const finishMacroPlayback = (message) => {
    if (!macroPlayback) return;
    releaseMacroButtons(macroPlayback);
    macroPlayback = null;
    setMacroStatus(message);
  };
  const finishMacroRecording = (message) => {
    if (!macroRecording) return;
    const take = macroRecording;
    macroRecording = null;
    const lastEvent = take.events.at(-1)?.[0] || 1;
    const duration = Math.max(1, emu.frameCount - take.startFrame, lastEvent);
    macroDraft = { name: take.name, game: take.game, events: take.events, duration };
    try { localStorage.setItem("webboy_macro_draft", JSON.stringify(macroDraft)); } catch {}
    macroRecordButton.textContent = "Record attempt";
    macroPublishButton.disabled = false;
    setMacroStatus(message + " Recording ready to publish.");
    renderMacroList();
  };
  function processMacroFrame(frame) {
    if (macroRecording && frame !== macroRecording.lastFrame + 1) {
      finishMacroRecording("Recording stopped after reset.");
    }
    if (macroRecording) macroRecording.lastFrame = frame;
    if (macroRecording) {
      const elapsed = frame - macroRecording.startFrame;
      const mem = emu.nes?.cpu?.mem;
      if (elapsed >= 30 && macroRecording.game.toLowerCase().endsWith("/smb.nes") && mem && mem[0x0770] === 1 &&
          (mem[0x075F] !== macroRecording.world || mem[0x075C] !== macroRecording.level)) {
        finishMacroRecording("Level finished.");
      } else if (elapsed >= 216000) {
        finishMacroRecording("Recording reached the 60-minute limit.");
      }
    }
    if (!macroPlayback) return;
    const playback = macroPlayback;
    if (frame !== playback.lastFrame + 1) {
      finishMacroPlayback("Playback stopped after reset.");
      return;
    }
    playback.lastFrame = frame;
    const elapsed = frame - playback.startFrame;
    while (playback.cursor < playback.events.length && playback.events[playback.cursor][0] <= elapsed) {
      const [, bit, down] = playback.events[playback.cursor++];
      if (down) {
        if (bit === 3) emu.setMarioLives();
        emu.nes?.buttonDown(1, bit);
        playback.held.add(bit);
      } else {
        emu.nes?.buttonUp(1, bit);
        playback.held.delete(bit);
      }
    }
    if (elapsed > playback.duration) finishMacroPlayback("Macro finished.");
  }
  const addMacroCard = (macro, isLocal) => {
    const card = document.createElement("article");
    card.className = "macro-entry";
    const heading = document.createElement("div");
    heading.className = "macro-entry-title";
    heading.textContent = macro.name;
    card.appendChild(heading);
    if (isLocal) {
      const author = document.createElement("div");
      author.className = "macro-entry-author";
      author.textContent = "Unpublished recording";
      card.appendChild(author);
    } else {
      const profile = document.createElement("a");
      profile.className = "macro-entry-author";
      profile.href = "https://websim.com/@" + encodeURIComponent(macro.username);
      profile.target = "_blank";
      profile.rel = "noopener noreferrer";
      const avatar = document.createElement("img");
      avatar.src = "https://images.websim.com/avatar/" + encodeURIComponent(macro.username);
      avatar.alt = "";
      profile.append(avatar, document.createTextNode("@" + macro.username));
      card.appendChild(profile);
    }
    const actions = document.createElement("div");
    actions.className = "macro-entry-actions";
    const useButton = document.createElement("button");
    useButton.className = "btn";
    useButton.type = "button";
    useButton.textContent = "Use";
    useButton.addEventListener("click", () => {
      if (!emu?.romData || macro.game !== emu.currentRomUrl) {
        setMacroStatus("Load the same game this macro was recorded for.");
        return;
      }
      if (macroRecording) finishMacroRecording("Recording stopped.");
      if (macroPlayback) finishMacroPlayback("Previous playback stopped.");
      macroPlayback = {
        events: macro.events,
        duration: macro.duration,
        startFrame: emu.frameCount,
        lastFrame: emu.frameCount,
        cursor: 0,
        held: new Set(),
      };
      emu.start();
      setMacroStatus("Playing " + macro.name + ".");
      canvas.focus();
    });
    actions.appendChild(useButton);
    if (isLocal) {
      const publishButton = document.createElement("button");
      publishButton.className = "btn";
      publishButton.type = "button";
      publishButton.textContent = "Publish";
      publishButton.addEventListener("click", () => publishMacro(macro));
      actions.appendChild(publishButton);
    }
    card.appendChild(actions);
    macroList.appendChild(card);
  };
  function renderMacroList() {
    macroList.replaceChildren();
    const game = emu?.currentRomUrl || "";
    if (macroDraft?.game === game) addMacroCard(macroDraft, true);
    for (const macro of publishedMacros) {
      if (macro.game === game) addMacroCard(macro, false);
    }
    if (macroDraft?.game !== game && !publishedMacros.some((macro) => macro.game === game)) {
      const empty = document.createElement("div");
      empty.className = "macro-empty";
      empty.textContent = game ? "No published macros for this game yet." : "Load a game to find its macros.";
      macroList.appendChild(empty);
    }
    macroPublishButton.disabled = !macroDraft || macroDraft.game !== game || Boolean(macroRecording);
  }
  async function loadMacroLibrary() {
    const game = emu?.currentRomUrl || "";
    publishedMacros = [];
    renderMacroList();
    if (!game) return;
    setMacroStatus("Loading published macros...");
    try {
      const response = await fetch("/api/macros?game=" + encodeURIComponent(game));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load macros.");
      publishedMacros = data;
      setMacroStatus(data.length ? "Choose a macro to play." : "No published macros for this game yet.");
      renderMacroList();
    } catch (error) {
      setMacroStatus(error.message || "Could not load published macros.");
    }
  }
  async function publishMacro(macro) {
    const name = macroNameInput.value.trim() || macro.name;
    try {
      const response = await fetch("/api/macros", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, game: macro.game, duration: macro.duration, events: macro.events }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not publish macro.");
      macroDraft = null;
      localStorage.removeItem("webboy_macro_draft");
      macroNameInput.value = "";
      setMacroStatus("Macro published.");
      await loadMacroLibrary();
    } catch (error) {
      setMacroStatus(error.message || "Could not publish macro.");
    }
  }

  document.getElementById("btn-macros").addEventListener("click", () => {
    showMacroOverlay(true);
    if (macroDraft?.game === emu?.currentRomUrl) macroNameInput.value = macroDraft.name;
    loadMacroLibrary();
  });
  document.getElementById("btn-close-macros").addEventListener("click", () => showMacroOverlay(false));
  macroOverlay.addEventListener("click", (event) => {
    if (event.target === macroOverlay) showMacroOverlay(false);
  });
  macroRecordButton.addEventListener("click", () => {
    if (macroRecording) {
      finishMacroRecording("Recording stopped.");
      return;
    }
    if (!emu?.romData) {
      setMacroStatus("Load a game before recording.");
      return;
    }
    if (macroPlayback) finishMacroPlayback("Playback stopped.");
    const mem = emu.nes?.cpu?.mem;
    macroRecording = {
      name: macroNameInput.value.trim().slice(0, 48) || "My attempt",
      game: emu.currentRomUrl,
      events: [],
      startFrame: emu.frameCount,
      lastFrame: emu.frameCount,
      world: mem?.[0x075F],
      level: mem?.[0x075C],
    };
    if (!macroNameInput.value.trim()) macroNameInput.value = "My attempt";
    macroPublishButton.disabled = true;
    macroRecordButton.textContent = "Stop recording";
    setMacroStatus("Recording. It will stop when the level changes.");
    if (!emu.isRunning) emu.start();
    canvas.focus();
  });
  macroPublishButton.addEventListener("click", () => {
    if (macroDraft) publishMacro(macroDraft);
  });

  // On-screen (mobile) controls
  const mobileControls = document.getElementById("mobile-controls");
  const btnToggleMobile = document.getElementById("btn-toggle-bottom-controls");
  if (mobileControls && btnToggleMobile) {
    const setMobileVisible = (show) => {
      mobileControls.classList.toggle("hidden", !show);
      mobileControls.setAttribute("aria-hidden", String(!show));
      btnToggleMobile.textContent = show ? "Mobile Controls: On" : "Mobile Controls: Off";
      btnToggleMobile.setAttribute("aria-pressed", String(show));
    };
    btnToggleMobile.addEventListener("click", () => {
      setMobileVisible(mobileControls.classList.contains("hidden"));
    });
    const mobileViewport = window.matchMedia("(max-width: 768px)");
    setMobileVisible(mobileViewport.matches);
    mobileViewport.addEventListener("change", (event) => setMobileVisible(event.matches));
    mobileControls.querySelectorAll(".m-btn").forEach((btn) => {
      const name = btn.dataset.btn;
      if (!name || !emu) return;
      const press = (e) => { e.preventDefault(); emu.buttonPress(name); };
      const release = (e) => { e.preventDefault(); emu.buttonRelease(name); };
      btn.addEventListener("pointerdown", press);
      btn.addEventListener("pointerup", release);
      btn.addEventListener("pointercancel", release);
      btn.addEventListener("pointerleave", release);
      btn.addEventListener("contextmenu", (e) => e.preventDefault());
    });
  }

  // Other UI handlers, custom-corruption logic, mobile controls, etc. remain unchanged from original code.
  // For brevity in this replacement block, the remainder of the original file logic (corruption triggers,
  // custom corruption modal, auto-corrupt, mobile controls, etc.) should be kept as originally implemented.

  // Trigger corrupt function (keeps original behavior)
  const triggerCorruptFromUI = () => {
    if (!emu) return;
    let type = "random";
    if (corruptionType) {
      const v = corruptionType.value;
      const validTypes = ["bitflip", "light_bitflip", "byteswap", "checkerboard", "texturevomit", "everybyte", "worldlevel", "music", "musicswap", "swapper", "numberscramble", "assetscramble", "logicscramble", "blockscramble", "levelscrambler", "powerupscramble", "enemyscramble", "xor", "scramble", "or", "and", "nand", "not", "binaryswap", "completebinaryswap", "light_random", "clusterbytes", "random"];
      if (validTypes.includes(v) || customList.find(c => c.id === v)) {
        type = v;
      }
    }
    let amount = 64;
    if (corruptionAmount) {
      const v = parseInt(corruptionAmount.value, 10);
      if (Number.isFinite(v)) {
        amount = Math.min(1024, Math.max(1, v));
        corruptionAmount.value = String(amount);
      }
    }

    const custom = customList.find(c => c.id === type);
    if (custom && custom.code) {
      try {
        const mem = emu.nes && emu.nes.cpu ? emu.nes.cpu.mem : null;
        const fn = new Function("emu", "mem", "count", custom.code);
        if (mem) fn(emu, mem, amount);
        emu.onStatus(`Ran custom corruption: ${custom.name}`);
        emu.corruptionCount++;
      } catch (e) {
        console.error("Custom corruption error:", e);
        emu.onStatus(`Custom corruption failed: ${e.message}`);
      }
      return;
    }

    emu.doCorrupt(amount, type);
  };

  if (btnCorrupt) btnCorrupt.addEventListener("click", triggerCorruptFromUI);
  if (btnCorruptLevelLayout) {
    btnCorruptLevelLayout.addEventListener("click", () => emu?.corruptSMBWorldLayout());
  }
  btnCorruptTextures?.addEventListener("click", () => emu?.corruptTextures());
  btnCorruptPalette?.addEventListener("click", () => emu?.corruptPalette());
  btnCorruptAudio?.addEventListener("click", () => emu?.corruptAudio());
  btnScrambleChr?.addEventListener("click", () => emu?.scrambleTextures());
  btnGlitchTileMap?.addEventListener("click", () => emu?.corruptNametableTiles());
  btnCorruptBackgroundPalette?.addEventListener("click", () => emu?.corruptBackgroundPalette());
  btnCorruptSpritePalette?.addEventListener("click", () => emu?.corruptSpritePalette());

  // Corrupt x2: runs the corruption twice back-to-back
  if (btnCorruptTwice) {
    btnCorruptTwice.addEventListener("click", () => {
      triggerCorruptFromUI();
      setTimeout(triggerCorruptFromUI, 0);
    });
  }

  // Auto Corrupt: repeatedly corrupts on an interval (toggle)
  if (btnAutoCorrupt) {
    const updateAutoLabel = () => {
      btnAutoCorrupt.textContent = autoCorruptTimer ? `Auto Corrupt: On (${autoCorruptIntervalInput.value}s)` : "Auto Corrupt: Off";
    };
    btnAutoCorrupt.addEventListener("click", () => {
      if (autoCorruptTimer) {
        clearInterval(autoCorruptTimer);
        autoCorruptTimer = null;
      } else {
        const secs = Math.min(120, Math.max(1, parseInt(autoCorruptIntervalInput.value, 10) || 10));
        autoCorruptIntervalInput.value = String(secs);
        autoCorruptTimer = setInterval(triggerCorruptFromUI, secs * 1000);
      }
      updateAutoLabel();
    });
    autoCorruptIntervalInput.addEventListener("input", updateAutoLabel);
  }

  // Corrupt When Press: corrupts each time a game button is pressed (toggle)
  if (btnCorruptPress) {
    btnCorruptPress.addEventListener("click", () => {
      corruptWhenPressActive = !corruptWhenPressActive;
      btnCorruptPress.textContent = corruptWhenPressActive ? "CorruptWhenPress: On" : "CorruptWhenPress: Off";
    });
  }

  // Custom Corruption creator
  const customModal = document.getElementById("custom-corrupt-modal");
  const btnCreateCustom = document.getElementById("btn-create-custom");
  const btnSaveCustom = document.getElementById("btn-save-custom");
  const btnCancelCustom = document.getElementById("btn-cancel-custom");
  const btnDescribeAI = document.getElementById("btn-describe-ai");
  const customNameInput = document.getElementById("custom-name");
  const customDescInput = document.getElementById("custom-desc");
  const customCodeInput = document.getElementById("custom-code");

  const showCustomModal = (show) => {
    if (!customModal) return;
    customModal.classList.toggle("show", show);
    customModal.setAttribute("aria-hidden", String(!show));
  };

  if (btnCreateCustom) btnCreateCustom.addEventListener("click", () => showCustomModal(true));
  if (btnCancelCustom) btnCancelCustom.addEventListener("click", () => showCustomModal(false));

  if (btnSaveCustom) {
    btnSaveCustom.addEventListener("click", () => {
      const name = customNameInput.value.trim();
      const code = customCodeInput.value.trim();
      if (!name || !code) {
        statusEl.textContent = "Custom corruption needs a name and code.";
        return;
      }
      const id = "custom_" + Date.now().toString(36);
      const custom = {
        id,
        name,
        desc: customDescInput.value.trim() || "(custom)",
        code
      };
      customList.push(custom);
      saveCustomCorruptions(customList);
      corruptionMetadata[id] = { desc: custom.desc, severity: "User", category: "Custom" };
      populateCustomOptions();
      corruptionType.value = id;
      updateCorruptionBlerp();
      customNameInput.value = "";
      customDescInput.value = "";
      customCodeInput.value = "";
      showCustomModal(false);
      statusEl.textContent = `Saved custom corruption: ${name}`;
    });
  }

  if (btnDescribeAI) {
    btnDescribeAI.addEventListener("click", async () => {
      const desc = customDescInput.value.trim();
      const nameReq = customNameInput.value.trim();
      if (!desc && !customCodeInput.value.trim()) {
        statusEl.textContent = "Describe a corruption in the description box first.";
        return;
      }
      statusEl.textContent = "Corruption Lab: generating...";
      btnDescribeAI.disabled = true;
      try {
        const system = `You create NES emulator corruption "glitch" code. The user describes the glitch they want and you write a single JavaScript function body that mutates the NES RAM array.
Context: mem is a Uint8Array containing the NES CPU's 2KB working RAM (0x0000-0x07FF), plus mirroring. "emu" is the emulator object (emu state, level data, etc.). "count" is an integer 1-1024 for how aggressive/many bytes to corrupt.
Randomize addresses with Math.random() within 0x0000-0x07FF where relevant. Keep code compact, safe, and idempotent-ish (it may run repeatedly). Respond WITH ONLY a JSON object in this exact schema, no other text:
{
  "name": "short snake_case or Title Case glitch name",
  "desc": "one short sentence describing the glitch",
  "code": "the full JS function body string"
}`;
        const messages = [
          { role: "system", content: system },
          { role: "user", content: `Glitch: ${desc || "random interesting corruption"}.${nameReq ? " Prefer this name: " + nameReq : ""}` }
        ];
        const completion = await websim.chat.completions.create({
          messages,
          json: true,
        });
        const result = JSON.parse(completion.content);
        if (result.code) {
          customCodeInput.value = (result.code || "").trim();
          customNameInput.value = (result.name || nameReq || "").trim();
          customDescInput.value = (result.desc || "").trim();
          statusEl.textContent = "Corruption Lab: code generated — review and press Save.";
        } else {
          statusEl.textContent = "AI returned nothing usable; try again.";
        }
      } catch (e) {
        console.error("AI generation failed:", e);
        statusEl.textContent = "Corruption Lab failed: " + (e && e.message ? e.message : e);
      } finally {
        btnDescribeAI.disabled = false;
      }
    });
  }

  // Export / Import custom corruptions (JSON)
  const btnExportCorruptions = document.getElementById("btn-export-corruptions");
  const btnImportCorruptions = document.getElementById("btn-import-corruptions");
  const corruptionImportInput = document.getElementById("corruption-import");

  if (btnExportCorruptions) {
    btnExportCorruptions.addEventListener("click", () => {
      const json = JSON.stringify(customList, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "corruptions.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      statusEl.textContent = `Exported ${customList.length} corruptions.`;
    });
  }

  if (btnImportCorruptions) btnImportCorruptions.addEventListener("click", () => corruptionImportInput.click());

  if (corruptionImportInput) {
    corruptionImportInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const arr = JSON.parse(reader.result);
          if (!Array.isArray(arr)) throw new Error("Not an array");
          arr.forEach((c) => {
            if (c && c.name && c.code && !customList.find((x) => x.id === c.id)) {
              customList.push(c);
              if (!corruptionMetadata[c.id]) corruptionMetadata[c.id] = { desc: c.desc || "(custom)", severity: "User", category: "Custom" };
            }
          });
          saveCustomCorruptions(customList);
          populateCustomOptions();
          statusEl.textContent = `Imported ${arr.length} corruption(s).`;
        } catch (err) {
          console.error("Import failed:", err);
          statusEl.textContent = `Import failed: ${err.message}`;
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    });
  }

  // Preserve event wiring for other controls (keyboard shortcuts, custom modal, auto-corrupt, mobile buttons, etc.)
  // For the full application keep the rest of original event wiring unchanged.
  // Finally, load the first available game automatically (if any)
  if (emu && Array.isArray(AVAILABLE_GAMES) && AVAILABLE_GAMES.length) {
    loadGameAtIndex(0);
    // Auto-start once the ROM is loaded so the screen shows content right
    // away instead of staying black until the user presses Start.
    (function waitToStart(attempts) {
      if (emu.romData) {
        if (!emu.isRunning) emu.start();
        return;
      }
      if (attempts > 0) setTimeout(() => waitToStart(attempts - 1), 60);
    })(50);
  }

  // ===== Polaroid screenshot feature =====
  const btnPolaroid = document.getElementById("btn-polaroid");
  const btnPolaroidFilter = document.getElementById("btn-polaroid-filter");
  const polaroidOverlay = document.getElementById("polaroid-overlay");
  const polaroidCanvas = document.getElementById("polaroid-canvas");
  const btnPolaroidToggle = document.getElementById("btn-polaroid-toggle-filter");
  const btnPolaroidDownload = document.getElementById("btn-polaroid-download");
  const btnPolaroidClose = document.getElementById("btn-polaroid-close");

  let polaroidFilterOn = true;

  const getGameName = () => {
    if (btnGameCycle) {
      const placeholderOpt = btnGameCycle.querySelector('option[value=""]');
      if (placeholderOpt && placeholderOpt.textContent && placeholderOpt.textContent !== "Select Game") {
        return placeholderOpt.textContent;
      }
    }
    return (AVAILABLE_GAMES[currentGameIndex] && AVAILABLE_GAMES[currentGameIndex].name) || "webboy";
  };

  const renderPolaroid = () => {
    if (!polaroidCanvas || !canvas) return;
    const ctx = polaroidCanvas.getContext("2d");
    const W = polaroidCanvas.width;
    const H = polaroidCanvas.height;

    // Yellowish aged paper background (the "white" of a Polaroid)
    const paper = ctx.createLinearGradient(0, 0, W, H);
    paper.addColorStop(0, "#f6eed6");
    paper.addColorStop(0.5, "#ecddb6");
    paper.addColorStop(1, "#e2cf9c");
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, W, H);

    // Soft uneven vignette / patina
    const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.75);
    vig.addColorStop(0, "rgba(120,90,40,0)");
    vig.addColorStop(1, "rgba(120,80,30,0.22)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);

    // Photo area (the large square). Room for name+date strip at the bottom.
    const pad = W * 0.07;
    const photoPad = pad - W * 0.015;
    const photoSize = Math.min(W - photoPad * 2, H * 0.62);

    // Draw photo backing (darker grey frame behind)
    ctx.fillStyle = "#8c8c86";
    ctx.fillRect(photoPad, photoPad, photoSize, photoSize);

    // Draw screenshot onto canvas
    const src = canvas.width === 256 && canvas.height === 240
      ? renderScreenPixels(photoSize, photoSize, polaroidFilterOn, polaroidFilterName())
      : renderScaledSource(photoSize, photoSize, polaroidFilterOn, polaroidFilterName());
    ctx.putImageData(src, photoPad, photoPad);

    // Hand-written-style game name
    const name = getGameName();
    ctx.save();
    ctx.translate(W / 2, photoPad + photoSize + 30);
    ctx.rotate(-0.02);
    ctx.font = '26px "Mario Bros", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // subtle ink shadow under light/cream paper
    ctx.shadowColor = "rgba(140,100,40,0.25)";
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = "#4a3a20";
    const maxW = W - 40;
    if (ctx.measureText(name).width > maxW) {
      let n = name;
      while (n.length > 1 && ctx.measureText(n + "…").width > maxW) n = n.slice(0, -1);
      ctx.fillText(n + "…", 0, 0);
    } else {
      ctx.fillText(name, 0, 0);
    }
    ctx.restore();

    // Date strip
    const now = new Date();
    const dateStr = now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    ctx.save();
    ctx.translate(W / 2, photoPad + photoSize + 56);
    ctx.rotate(-0.015);
    ctx.font = '18px "Mario Bros", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#e8dcc0"; // stamped cream
    ctx.fillText(dateStr, 0.6, 0.6);
    ctx.fillStyle = "#4a3a20";
    ctx.fillText(dateStr, 0, 0);
    ctx.restore();
  };

  // --- helper for reading the live NES frame ---
  let polaroidFilterIdx = 0;
  const polaroidFilters = [
    { name: "None",   apply: (d, w, h) => {} },
    { name: "Sepia",  apply: (d, w, h) => { for (let i=0;i<d.length;i+=4){ const r=d[i],g=d[i+1],b=d[i+2]; d[i]=Math.min(255, r*1.07+g*0.2+b*0.09); d[i+1]=Math.min(255, r*0.12+g*0.94+b*0.1); d[i+2]=Math.min(255, r*0.12+g*0.28+b*0.8); } } },
    { name: "Aged",   apply: (d, w, h) => { for (let i=0;i<d.length;i+=4){ const r=d[i],g=d[i+1],b=d[i+2]; const gr = (r+g+b)/3; d[i]=gr*0.9+20; d[i+1]=gr*0.85+10; d[i+2]=gr*0.7+5; d[i]=d[i]&0xff; d[i+1]=d[i+1]&0xff; d[i+2]=d[i+2]&0xff; } } },
    { name: "Silver", apply: (d, w, h) => { for (let i=0;i<d.length;i+=4){ const gr=(d[i]+d[i+1]+d[i+2])/3; d[i]=d[i+1]=d[i+2]=gr&0xff; } } }
  ];
  const polaroidFilterName = () => polaroidFilters[polaroidFilterIdx].name;

  // Read current on-screen pixel data and scale to dn*dn with an optional filter
  const renderScreenPixels = (dn, dn2, useFilter, filterName) => {
    const w = canvas.width, h = canvas.height;
    const temp = document.createElement("canvas");
    temp.width = dn; temp.height = dn2;
    const tctx = temp.getContext("2d");
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(canvas, 0, 0, dn, dn2);
    let data;
    try { data = temp.getContext("2d").getImageData(0, 0, dn, dn2); }
    catch(e) { data = null; }
    if (!data) {
      const out = document.createElement("canvas");
      out.width = dn; out.height = dn2;
      const o = out.getContext("2d");
      o.imageSmoothingEnabled = false;
      o.drawImage(canvas, 0, 0, dn, dn2);
      data = o.getImageData(0, 0, dn, dn2);
    }
    const filt = polaroidFilters.find(f => f.name === filterName);
    if (useFilter && filt && filt.name !== "None") filt.apply(data.data, dn, dn2);
    return data;
  };

  const renderScaledSource = (dn, dn2, useFilter, filterName) => {
    const w = canvas.width, h = canvas.height;
    const card = document.createElement("canvas");
    card.width = dn; card.height = dn2;
    const cctx = card.getContext("2d");
    cctx.imageSmoothingEnabled = false;
    cctx.drawImage(canvas, 0, 0, dn, dn2);
    const filt = polaroidFilters.find(f => f.name === filterName);
    if (useFilter && filt) {
      const id = cctx.getImageData(0,0,dn,dn2);
      filt.apply(id.data, dn, dn2);
      cctx.putImageData(id, 0, 0);
    }
    return cctx.getImageData(0,0,dn,dn2);
  };

  if (btnPolaroid) {
    btnPolaroid.addEventListener("click", () => {
      if (!polaroidOverlay) return;
      renderPolaroid();
      polaroidOverlay.classList.add("show");
      polaroidOverlay.setAttribute("aria-hidden", "false");
    });
  }
  if (btnPolaroidFilter) {
    btnPolaroidFilter.addEventListener("click", () => {
      polaroidFilterIdx = (polaroidFilterIdx + 1) % polaroidFilters.length;
      btnPolaroidFilter.textContent = `Filter: ${polaroidFilterName()}`;
      if (polaroidOverlay && polaroidOverlay.classList.contains("show")) {
        renderPolaroid();
      }
    });
  }
  if (btnPolaroidToggle) {
    btnPolaroidToggle.addEventListener("click", () => {
      polaroidFilterOn = !polaroidFilterOn;
      btnPolaroidToggle.textContent = polaroidFilterOn ? "Filter: On" : "Filter: Off";
      renderPolaroid();
    });
  }
  if (btnPolaroidDownload) {
    btnPolaroidDownload.addEventListener("click", () => {
      if (!polaroidCanvas) return;
      const name = getGameName().replace(/[^\w\- ]+/g, "").trim() || "webboy";
      const a = document.createElement("a");
      a.href = polaroidCanvas.toDataURL("image/png");
      a.download = `${name} polaroid.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }
  if (btnPolaroidClose) {
    btnPolaroidClose.addEventListener("click", () => {
      if (polaroidOverlay) {
        polaroidOverlay.classList.remove("show");
        polaroidOverlay.setAttribute("aria-hidden", "true");
      }
    });
  }

  // Tutorial shown on first open
  const TUTORIAL_KEY = "webboy_tutorial_seen_v1";
  const showTutorial = (show) => {
    if (!tutorialOverlay) return;
    tutorialOverlay.classList.toggle("show", show);
    tutorialOverlay.setAttribute("aria-hidden", String(!show));
  };
  if (btnCloseTutorial) {
    btnCloseTutorial.addEventListener("click", () => {
      try { localStorage.setItem(TUTORIAL_KEY, "1"); } catch (e) {}
      showTutorial(false);
    });
  }
  let tutorialSeen = false;
  try { tutorialSeen = !!localStorage.getItem(TUTORIAL_KEY); } catch (e) {}
  if (!tutorialSeen) showTutorial(true);
}

window.addEventListener("DOMContentLoaded", () => { setup().catch(e=>{ console.error(e); }); });