/// <reference types="@cloudflare/workers-types" />

export interface Env {
  GOLF_ROUND: DurableObjectNamespace;
  COURSE_CATALOG: DurableObjectNamespace;
  ASSETS: Fetcher;
  GOLF_API_KEY?: string;
  ADMIN_KEY?: string;
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
        const { adminToken, ...rest } = cfg;
        if (adminToken) await this.ctx.storage.put("adminToken", adminToken);
        await this.ctx.storage.put("state", { ...rest, scores: {}, wolf: {}, createdAt: Date.now() });
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

    // Live group positions — relayed to the rest of the group, never stored. Opt-in per player.
    if (data.type === "pos") {
      const lat = Number(data.lat), lng = Number(data.lng), id = String(data.id || "");
      if (!id || !isFinite(lat) || !isFinite(lng)) return;
      const acc = isFinite(Number(data.acc)) ? Number(data.acc) : undefined;
      this.relayExcept(ws, { type: "pos", id, lat, lng, acc });
      return;
    }
    if (data.type === "posClear") {
      const id = String(data.id || "");
      if (id) this.relayExcept(ws, { type: "posClear", id });
      return;
    }

    const state = await this.ctx.storage.get<any>("state");
    if (!state) return;

    if (data.type === "chat") {
      const text = String(data.text || "").trim().slice(0, 280);
      const name = String(data.name || "").trim().slice(0, 24) || "Guest";
      if (!text) return;
      const msg = { id: Math.random().toString(36).slice(2, 9), name, text, ts: Date.now() };
      state.chat = [...(state.chat || []), msg].slice(-80); // keep last 80
      await this.ctx.storage.put("state", state);
      this.broadcast({ type: "chatMsg", msg });
      return;
    }

    if (data.type === "addPlayer") {
      const id = String(data.id || "");
      const name = String(data.name || "").trim().slice(0, 24);
      const grp = data.group != null ? String(data.group) : undefined;
      if (!id || !name) return;
      if (state.players.length >= 200) return; // 36 foursomes ceiling, with headroom
      const hcp = Math.max(0, Math.min(54, parseInt(data.hcp) || 0));
      if (!state.players.some((p: any) => p.id === id)) {
        state.players.push({ id, name, hcp, ...(grp ? { group: grp } : {}) });
        await this.ctx.storage.put("state", state);
        this.broadcast({ type: "state", state });
      }
    } else if (data.type === "score") {
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
    } else if (data.type === "wolfPick") {
      const hole = Number(data.hole);
      if (!Number.isInteger(hole) || hole < 1 || hole > 18) return;
      const partner = data.partner;
      const valid = partner === null || partner === "lone" || state.players.some((p: any) => p.id === partner);
      if (!valid) return;
      state.wolf = state.wolf || {};
      if (partner === null) delete state.wolf[hole]; else state.wolf[hole] = partner;
      await this.ctx.storage.put("state", state);
      this.broadcast({ type: "state", state });
    } else if (data.type === "bbbPick") {
      const hole = Number(data.hole);
      if (!Number.isInteger(hole) || hole < 1 || hole > 18) return;
      const which = data.which;
      if (which !== "bingo" && which !== "bango" && which !== "bongo") return;
      const player = data.player;
      const valid = player === null || state.players.some((p: any) => p.id === player);
      if (!valid) return;
      state.bbb = state.bbb || {};
      state.bbb[hole] = state.bbb[hole] || {};
      if (player === null) delete state.bbb[hole][which]; else state.bbb[hole][which] = player;
      await this.ctx.storage.put("state", state);
      this.broadcast({ type: "state", state });
    } else if (data.type === "press") {
      const game = data.game;
      const hole = Number(data.hole);
      if ((game !== "sixes" && game !== "nassau") || !Number.isInteger(hole) || hole < 1 || hole > 18) return;
      state.presses = state.presses || {};
      const arr: number[] = state.presses[game] || [];
      const i = arr.indexOf(hole);
      if (i >= 0) {
        arr.splice(i, 1); // undo the press on this hole
      } else {
        // one press at a time per segment
        const segLo = game === "sixes" ? Math.floor((hole - 1) / 6) * 6 + 1 : (hole <= 9 ? 1 : 10);
        const segHi = game === "sixes" ? segLo + 5 : (hole <= 9 ? 9 : 18);
        if (arr.some((h) => h >= segLo && h <= segHi)) return; // already a live press here
        arr.push(hole);
      }
      state.presses[game] = arr;
      await this.ctx.storage.put("state", state);
      this.broadcast({ type: "state", state });
    } else if (data.type === "teamScore") {
      const hole = Number(data.hole);
      const strokes = Number(data.strokes);
      const group = data.group != null ? String(data.group) : "";
      if (!group || !Number.isInteger(hole) || hole < 1 || hole > 18) return;
      if (!Number.isInteger(strokes) || strokes < 1 || strokes > 30) return;
      state.teamScores = state.teamScores || {};
      state.teamScores[group] = state.teamScores[group] || {};
      state.teamScores[group][hole] = strokes;
      await this.ctx.storage.put("state", state);
      this.broadcast({ type: "state", state });
    } else if (data.type === "setTeamMode") {
      const stored = await this.ctx.storage.get("adminToken");
      if (stored && data.token !== stored) return; // admin only when a token exists
      if (data.mode === "bestball" || data.mode === "best2" || data.mode === "scramble") {
        state.teamMode = data.mode;
        await this.ctx.storage.put("state", state);
        this.broadcast({ type: "state", state });
      }
    } else if (data.type === "setRules") {
      const stored = await this.ctx.storage.get("adminToken");
      if (stored && data.token !== stored) return;
      if (data.handicapMode === "perHole" || data.handicapMode === "course" || data.handicapMode === "gross") state.handicapMode = data.handicapMode;
      if (data.formats && typeof data.formats === "object") {
        const f: any = {}; for (const k of ["net", "gross", "stableford", "chicago", "skins"]) f[k] = !!data.formats[k];
        if (Object.values(f).some(Boolean)) state.formats = f; // keep at least one format on
      }
      if (data.games && typeof data.games === "object") {
        const g: any = {}; for (const k of ["wolf", "nines", "sixes", "vegas", "nassau", "bbb", "bestball"]) g[k] = !!data.games[k];
        state.games = g;
      }
      if (data.stakes && typeof data.stakes === "object") {
        const s: any = {}; for (const k of ["skins", "nassau", "wolf", "nines", "vegas", "sixes", "bestball"]) { const v = Number(data.stakes[k]); if (isFinite(v) && v >= 0) s[k] = v; }
        state.stakes = s;
      }
      if ("teams" in data) {
        const ids = Array.isArray(data.teams) ? data.teams.filter((x: any) => typeof x === "string") : [];
        const valid = ids.length === 2 && ids.every((id: string) => state.players.some((p: any) => p.id === id));
        state.teams = valid ? ids : [];
      }
      await this.ctx.storage.put("state", state);
      this.broadcast({ type: "state", state });
    } else if (data.type === "deleteGroup") {
      const stored = await this.ctx.storage.get("adminToken");
      if (stored && data.token !== stored) return;
      const g = String(data.group || "");
      if (!g) return;
      const removed = state.players.filter((p: any) => (p.group || "1") === g).map((p: any) => p.id);
      state.players = state.players.filter((p: any) => (p.group || "1") !== g);
      removed.forEach((id: string) => { if (state.scores) delete state.scores[id]; });
      if (state.teamScores) delete state.teamScores[g];
      await this.ctx.storage.put("state", state);
      this.broadcast({ type: "state", state });
    } else if (data.type === "removePlayer") {
      const stored = await this.ctx.storage.get("adminToken");
      if (stored && data.token !== stored) return;
      const id = String(data.id || "");
      if (!id) return;
      state.players = state.players.filter((p: any) => p.id !== id);
      if (state.scores) delete state.scores[id];
      await this.ctx.storage.put("state", state);
      this.broadcast({ type: "state", state });
    } else if (data.type === "setMode") {
      if (data.game === "sixes" && (data.mode === "points" || data.mode === "skins")) {
        state.sixesMode = data.mode;
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

  relayExcept(sender: WebSocket, obj: any) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === sender) continue;
      try { ws.send(msg); } catch { /* dropped socket */ }
    }
  }
}
