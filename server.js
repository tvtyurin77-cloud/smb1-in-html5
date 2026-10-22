export const schema = `
  CREATE TABLE IF NOT EXISTS macros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    game TEXT NOT NULL,
    events TEXT NOT NULL,
    duration INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS macros_game_created ON macros (game, created_at DESC);
  CREATE INDEX IF NOT EXISTS macros_user ON macros (user_id);
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/macros") {
      const game = url.searchParams.get("game");
      if (!game || game.length > 180) return Response.json({ error: "Choose a game" }, { status: 400 });
      const { results } = await env.DB.prepare(
        "SELECT id, name, game, username, events, duration, created_at FROM macros WHERE game = ? ORDER BY created_at DESC LIMIT 50"
      ).bind(game).all();
      return Response.json(results.map((macro) => ({ ...macro, events: JSON.parse(macro.events) })));
    }

    if (request.method === "POST" && url.pathname === "/api/macros") {
      const userId = request.headers.get("x-websim-user-id");
      const username = request.headers.get("x-websim-username");
      if (!userId || !username) return Response.json({ error: "Sign in to publish macros" }, { status: 401 });

      let body;
      try { body = await request.json(); } catch { return Response.json({ error: "Invalid macro data" }, { status: 400 }); }
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 48) : "";
      const game = typeof body.game === "string" ? body.game : "";
      const duration = Number(body.duration);
      const events = body.events;
      if (!name || !game || game.length > 180 || !Number.isInteger(duration) || duration < 1 || duration > 216000 || !Array.isArray(events) || !events.length || events.length > 10000) {
        return Response.json({ error: "Invalid macro" }, { status: 400 });
      }
      let previousFrame = 0;
      for (const event of events) {
        if (!Array.isArray(event) || event.length !== 3 || !Number.isInteger(event[0]) || event[0] < 1 || event[0] > duration || event[0] < previousFrame || !Number.isInteger(event[1]) || event[1] < 0 || event[1] > 7 || typeof event[2] !== "boolean") {
          return Response.json({ error: "Invalid macro events" }, { status: 400 });
        }
        previousFrame = event[0];
      }
      const encodedEvents = JSON.stringify(events);
      if (encodedEvents.length > 100000) return Response.json({ error: "Macro is too large" }, { status: 400 });
      const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM macros WHERE user_id = ?").bind(userId).first("total");
      if (count >= 100) return Response.json({ error: "You have reached the 100 macro limit" }, { status: 429 });
      const result = await env.DB.prepare(
        "INSERT INTO macros (user_id, username, name, game, events, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(userId, username, name, game, encodedEvents, duration, Date.now()).run();
      return Response.json({ ok: true, id: result.meta.last_row_id });
    }

    return new Response("Not found", { status: 404 });
  },
};
