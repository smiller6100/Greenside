// A Ryder Cup event: two teams, a roster, sessions, and matches with live hole-by-hole scores.
// Live-synced to every phone over a hibernatable WebSocket, mirroring GolfRound. The match-play
// math lives client-side in src/lib/cup.ts; this object just holds and broadcasts the shared state.
//
// Three permission tiers, all enforced here (the client only hides controls — the DO is the gate):
//   • Commissioner — holds the admin token (the creator's device/account). Can change every setting:
//     course, teams, handicap method, sessions, pairings, and who the captains are. Also decides how
//     teams are chosen (assign-himself vs captain draft).
//   • Captain — a roster member the commissioner promotes (one per team). Can only draft players onto
//     their OWN team, and only when it's their turn. Cannot touch settings or the other team.
//   • Player — anyone who joined with the code. Enters their own name/handicap, scores their own
//     matches, and chats. Can never assign teams or change settings.
interface Env { CUP_EVENT: DurableObjectNamespace; }

type Side = "A" | "B";
type CupState = {
  code: string;
  name: string;
  method: "low" | "full" | "gross";
  createdAt: number;
  course: any | null; // { name, where, holes: [{num,par,si,yards}] }
  teams: { A: { name: string; color: string }; B: { name: string; color: string } };
  roster: { id: string; name: string; hcp: number; team: Side | null }[];
  captains: { A: string | null; B: string | null }; // roster ids
  teamMode: "assign" | "draft"; // how players reach a team
  draft: { first: Side; turn: Side | null; started: boolean };
  sessions: { id: string; name: string; format: string; order: number }[];
  matches: { id: string; sessionId: string; format: string; sideA: string[]; sideB: string[]; scores: Record<string, (number | null)[]> }[];
  chat?: { id: string; name: string; text: string; ts: number }[];
};

const rid = () => Math.random().toString(36).slice(2, 9);

// Fill in fields that predate a given version so older saved Cups keep working.
function normalize(s: any): CupState {
  if (!s.captains) s.captains = { A: null, B: null };
  if (s.teamMode !== "assign" && s.teamMode !== "draft") s.teamMode = "assign";
  if (!s.draft) s.draft = { first: "A", turn: null, started: false };
  if (s.draft.first !== "A" && s.draft.first !== "B") s.draft.first = "A";
  if (typeof s.draft.started !== "boolean") s.draft.started = false;
  return s as CupState;
}

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
          captains: { A: null, B: null },
          teamMode: "assign",
          draft: { first: "A", turn: null, started: false },
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
      pair[1].send(JSON.stringify({ type: "state", state: normalize(state) }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (request.method === "GET") {
      const state = await this.ctx.storage.get("state");
      return state ? Response.json(normalize(state)) : new Response("Not found", { status: 404 });
    }
    return new Response("Bad request", { status: 400 });
  }

  async save(state: CupState) { await this.ctx.storage.put("state", state); this.broadcast({ type: "state", state }); }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    let data: any;
    try { data = JSON.parse(message); } catch { return; }
    const raw = await this.ctx.storage.get<CupState>("state");
    if (!raw) return;
    const state = normalize(raw);

    // Commissioner = holds the admin token. Captain-of-a-team = the roster id the commissioner set.
    const adminToken = await this.ctx.storage.get("adminToken");
    const isAdmin = !adminToken || data.token === adminToken;
    const me = String(data.me || "");
    const captainOf = (side: Side) => !!me && state.captains[side] === me;

    // Players still in the pool (no team yet), used by the draft.
    const pool = () => state.roster.filter((p) => !p.team);

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
      case "rosterUpdate": {
        // Commissioner edit (name/hcp/team). The manual team assignment path.
        if (!isAdmin) return;
        const p = state.roster.find((r) => r.id === data.id); if (!p) return;
        if (typeof data.name === "string") p.name = data.name.slice(0, 40);
        if (Number.isFinite(data.hcp)) p.hcp = Math.round(data.hcp);
        if (data.team === "A" || data.team === "B" || data.team === null) p.team = data.team;
        return this.save(state);
      }
      case "rosterRemove": {
        if (!isAdmin) return;
        state.roster = state.roster.filter((r) => r.id !== data.id);
        if (state.captains.A === data.id) state.captains.A = null;
        if (state.captains.B === data.id) state.captains.B = null;
        return this.save(state);
      }
      case "setCaptain": {
        // Commissioner promotes/demotes a captain. A captain plays for their own team, so promoting
        // one puts them on that team; the same person can't captain both teams.
        if (!isAdmin) return;
        const side: Side | null = data.team === "A" || data.team === "B" ? data.team : null;
        if (!side) return;
        const id = data.id ? String(data.id) : null;
        if (id === null) { state.captains[side] = null; return this.save(state); }
        const p = state.roster.find((r) => r.id === id); if (!p) return;
        const other: Side = side === "A" ? "B" : "A";
        if (state.captains[other] === id) state.captains[other] = null;
        state.captains[side] = id;
        p.team = side;
        return this.save(state);
      }
      case "teamMode": {
        if (!isAdmin) return;
        if (data.mode !== "assign" && data.mode !== "draft") return;
        state.teamMode = data.mode;
        if (data.mode === "assign") { state.draft.turn = null; state.draft.started = false; }
        return this.save(state);
      }
      case "draftFirst": {
        if (!isAdmin) return;
        if (data.team !== "A" && data.team !== "B") return;
        state.draft.first = data.team;
        return this.save(state);
      }
      case "draftStart": {
        // Commissioner begins the draft: everyone except the two captains goes back into the pool,
        // and the first team is on the clock.
        if (!isAdmin) return;
        if (state.teamMode !== "draft") return;
        if (!state.captains.A || !state.captains.B) return;
        for (const p of state.roster) { if (p.id !== state.captains.A && p.id !== state.captains.B) p.team = null; }
        state.draft.started = true;
        state.draft.turn = state.draft.first;
        return this.save(state);
      }
      case "draftReset": {
        if (!isAdmin) return;
        for (const p of state.roster) { if (p.id !== state.captains.A && p.id !== state.captains.B) p.team = null; }
        state.draft.started = false;
        state.draft.turn = null;
        return this.save(state);
      }
      case "draftPick": {
        // The heart of the three-tier rule: a pick lands only if it's a live draft, it's that team's
        // turn, and the sender is either the commissioner or THAT team's captain.
        if (state.teamMode !== "draft" || !state.draft.turn) return;
        const side = state.draft.turn;
        if (!isAdmin && !captainOf(side)) return;
        const p = state.roster.find((r) => r.id === String(data.playerId));
        if (!p || p.team) return; // must be an unassigned player
        p.team = side;
        const remaining = pool();
        state.draft.turn = remaining.length ? (side === "A" ? "B" : "A") : null; // straight alternating
        return this.save(state);
      }
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
      case "join": {
        // Open: a player joining with the code registers themselves (team unset). Idempotent on the
        // client-supplied id, and lets them fix their own hcp/name.
        const id = String(data.id || "").slice(0, 24);
        const name = String(data.name || "").trim().slice(0, 40);
        if (!id || !name) return;
        const existing = state.roster.find((r) => r.id === id);
        if (existing) { existing.name = name; if (Number.isFinite(data.hcp)) existing.hcp = Math.round(data.hcp); }
        else state.roster.push({ id, name, hcp: Number.isFinite(data.hcp) ? Math.round(data.hcp) : 0, team: null });
        return this.save(state);
      }
      case "chat": {
        const text = String(data.text || "").trim().slice(0, 280);
        const name = String(data.name || "").trim().slice(0, 24) || "Guest";
        if (!text) return;
        state.chat = [...(state.chat || []), { id: rid(), name, text, ts: Date.now() }].slice(-100);
        return this.save(state);
      }
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
