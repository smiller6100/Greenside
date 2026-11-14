// A Ryder Cup event: two teams, a roster, sessions, and matches with live hole-by-hole scores.
// Live-synced to every phone over a hibernatable WebSocket, mirroring GolfRound. The match-play
// math lives client-side in src/lib/cup.ts; this object just holds and broadcasts the shared state.
interface Env { CUP_EVENT: DurableObjectNamespace; }

type CupState = {
  code: string;
  name: string;
  method: "low" | "full" | "gross";
  createdAt: number;
  course: any | null; // { name, where, holes: [{num,par,si,yards}] }
  teams: { A: { name: string; color: string }; B: { name: string; color: string } };
  roster: { id: string; name: string; hcp: number; team: "A" | "B" | null }[];
  sessions: { id: string; name: string; format: string; order: number }[];
  matches: { id: string; sessionId: string; format: string; sideA: string[]; sideB: string[]; scores: Record<string, (number | null)[]> }[];
};

const rid = () => Math.random().toString(36).slice(2, 9);

export class CupEvent implements DurableObject {
  ctx: DurableObjectState;
  env: Env;
  constructor(ctx: DurableObjectState, env: Env) { this.ctx = ctx; this.env = env; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/init") && request.method === "POST") {
      const cfg = await request.json<any>();
      const existing = await this.ctx.storage.get("state");
      if (!existing) {
        if (cfg.adminToken) await this.ctx.storage.put("adminToken", cfg.adminToken);
        const state: CupState = {
          code: cfg.code,
          name: String(cfg.name || "Ryder Cup").slice(0, 60),
          method: ["low", "full", "gross"].includes(cfg.method) ? cfg.method : "low",
          createdAt: Date.now(),
          course: cfg.course || null,
          teams: {
            A: { name: String(cfg.teams?.A?.name || "Team A").slice(0, 40), color: cfg.teams?.A?.color || "#15392a" },
            B: { name: String(cfg.teams?.B?.name || "Team B").slice(0, 40), color: cfg.teams?.B?.color || "#9a2b2b" },
          },
          roster: Array.isArray(cfg.roster) ? cfg.roster : [],
          sessions: [],
          matches: [],
        };
        await this.ctx.storage.put("state", state);
      }
      return Response.json({ ok: true });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const state = await this.ctx.storage.get("state");
      if (!state) return new Response("Cup not found", { status: 404 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: "state", state }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (request.method === "GET") {
      const state = await this.ctx.storage.get("state");
      return state ? Response.json(state) : new Response("Not found", { status: 404 });
    }
    return new Response("Bad request", { status: 400 });
  }

  async save(state: CupState) { await this.ctx.storage.put("state", state); this.broadcast({ type: "state", state }); }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    let data: any;
    try { data = JSON.parse(message); } catch { return; }
    const state = (await this.ctx.storage.get<CupState>("state"));
    if (!state) return;

    // Setup actions are captain-only (hold the admin token); scoring is open to everyone in a match.
    const adminToken = await this.ctx.storage.get("adminToken");
    const isAdmin = !adminToken || data.token === adminToken;

    switch (data.type) {
      case "meta": {
        if (!isAdmin) return;
        if (typeof data.name === "string") state.name = data.name.slice(0, 60);
        if (["low", "full", "gross"].includes(data.method)) state.method = data.method;
        if (data.teams) {
          for (const side of ["A", "B"] as const) {
            if (data.teams[side]?.name != null) state.teams[side].name = String(data.teams[side].name).slice(0, 40);
            if (data.teams[side]?.color) state.teams[side].color = String(data.teams[side].color).slice(0, 16);
          }
        }
        return this.save(state);
      }
      case "course": { if (!isAdmin) return; state.course = data.course || null; return this.save(state); }
      case "rosterAdd": {
        if (!isAdmin) return;
        const name = String(data.name || "").trim().slice(0, 40); if (!name) return;
        state.roster.push({ id: rid(), name, hcp: Number.isFinite(data.hcp) ? Math.round(data.hcp) : 0, team: data.team === "A" || data.team === "B" ? data.team : null });
        return this.save(state);
      }
      case "rosterUpdate": {
        if (!isAdmin) return;
        const p = state.roster.find((r) => r.id === data.id); if (!p) return;
        if (typeof data.name === "string") p.name = data.name.slice(0, 40);
        if (Number.isFinite(data.hcp)) p.hcp = Math.round(data.hcp);
        if (data.team === "A" || data.team === "B" || data.team === null) p.team = data.team;
        return this.save(state);
      }
      case "rosterRemove": { if (!isAdmin) return; state.roster = state.roster.filter((r) => r.id !== data.id); return this.save(state); }
      case "sessionAdd": {
        if (!isAdmin) return;
        state.sessions.push({ id: rid(), name: String(data.name || "Session").slice(0, 40), format: String(data.format || "fourball"), order: state.sessions.length });
        return this.save(state);
      }
      case "sessionRemove": {
        if (!isAdmin) return;
        state.sessions = state.sessions.filter((s) => s.id !== data.id);
        state.matches = state.matches.filter((mt) => mt.sessionId !== data.id);
        return this.save(state);
      }
      case "matchAdd": {
        if (!isAdmin) return;
        const sess = state.sessions.find((s) => s.id === data.sessionId); if (!sess) return;
        state.matches.push({ id: rid(), sessionId: data.sessionId, format: sess.format, sideA: Array.isArray(data.sideA) ? data.sideA.slice(0, 2) : [], sideB: Array.isArray(data.sideB) ? data.sideB.slice(0, 2) : [], scores: {} });
        return this.save(state);
      }
      case "matchRemove": { if (!isAdmin) return; state.matches = state.matches.filter((mt) => mt.id !== data.id); return this.save(state); }
      case "score": {
        // Open to all — players enter their own scores and keep each other honest.
        const mt = state.matches.find((x) => x.id === data.matchId); if (!mt) return;
        const slot = String(data.slot || "");
        const hole = Number(data.hole);
        if (!slot || !Number.isInteger(hole) || hole < 0 || hole > 26) return;
        const n = state.course?.holes?.length || 18;
        if (!mt.scores[slot]) mt.scores[slot] = new Array(n).fill(null);
        const v = data.value;
        mt.scores[slot][hole] = v == null ? null : Math.max(1, Math.min(20, Math.round(v)));
        return this.save(state);
      }
    }
  }

  broadcast(obj: any) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch { /* dropped */ } }
  }
}
