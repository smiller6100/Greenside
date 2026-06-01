/// <reference types="@cloudflare/workers-types" />

export interface Env {
  GOLF_ROUND: DurableObjectNamespace;
  COURSE_CATALOG: DurableObjectNamespace;
  ASSETS: Fetcher;
  GOLF_API_KEY?: string;
  AI: any;
}

// One instance of this object exists per round code. Every phone in the
// round connects to it over a WebSocket; it is the single source of truth.
export class GolfRound implements DurableObject {
  ctx: DurableObjectState;
  env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Create / initialise the round (called once by the Worker on create).
    if (url.pathname.endsWith("/init") && request.method === "POST") {
      const cfg = await request.json<any>();
      const existing = await this.ctx.storage.get("state");
      if (!existing) {
        await this.ctx.storage.put("state", { ...cfg, scores: {}, createdAt: Date.now() });
      }
      return Response.json({ ok: true });
    }

    // WebSocket connection from a player's phone.
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const state = await this.ctx.storage.get("state");
      if (!state) return new Response("Round not found", { status: 404 });
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server); // hibernatable: no idle compute cost
      server.send(JSON.stringify({ type: "state", state }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // Plain state fetch (used to check a round exists before connecting).
    if (request.method === "GET") {
      const state = await this.ctx.storage.get("state");
      return state ? Response.json(state) : new Response("Not found", { status: 404 });
    }

    return new Response("Bad request", { status: 400 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    let data: any;
    try { data = JSON.parse(message); } catch { return; }

    const state = await this.ctx.storage.get<any>("state");
    if (!state) return;

    if (data.type === "score") {
      const hole = Number(data.hole);
      const strokes = Number(data.strokes);
      if (!Number.isInteger(hole) || hole < 1 || hole > 18) return;
      if (!Number.isInteger(strokes) || strokes < 1 || strokes > 30) return;
      if (!state.players.some((p: any) => p.id === data.playerId)) return;
      state.scores[data.playerId] = state.scores[data.playerId] || {};
      state.scores[data.playerId][hole] = strokes;
      await this.ctx.storage.put("state", state);
      this.broadcast({ type: "state", state });
    } else if (data.type === "clear") {
      const hole = Number(data.hole);
      if (state.scores[data.playerId]) {
        delete state.scores[data.playerId][hole];
        await this.ctx.storage.put("state", state);
        this.broadcast({ type: "state", state });
      }
    }
  }

  async webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch { /* already closing */ }
  }

  async webSocketError(ws: WebSocket) {
    try { ws.close(); } catch { /* */ }
  }

  broadcast(obj: any) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* dropped socket */ }
    }
  }
}
