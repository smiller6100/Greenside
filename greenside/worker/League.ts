/// <reference types="@cloudflare/workers-types" />

// One Durable Object per league (keyed by a league code). Holds members and the per-round results
// submitted to it; standings are computed on read so the points formula can evolve. Friendly/low
// stakes: joining and submitting are open by code. Members are matched to a round's players by name.
const POINTS = [10, 8, 6, 5, 4, 3, 2, 1]; // per-round placing points; everyone else gets 1

export class League implements DurableObject {
  ctx: DurableObjectState;
  env: any;
  constructor(ctx: DurableObjectState, env: any) { this.ctx = ctx; this.env = env; }

  async members(): Promise<any[]> { return (await this.ctx.storage.get<any[]>("members")) || []; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url); const path = url.pathname;

    if (path.endsWith("/create") && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      const meta = await this.ctx.storage.get<any>("meta");
      if (!meta) await this.ctx.storage.put("meta", { name: String(b.name || "League").slice(0, 60), code: b.code, created: Date.now(), adminSecret: String(b.adminSecret || "") });
      return Response.json({ ok: true });
    }

    const meta = await this.ctx.storage.get<any>("meta");
    if (!meta) return new Response("No league", { status: 404 });

    if (path.endsWith("/info")) {
      const members = await this.members();
      const map = await this.ctx.storage.list<any>({ prefix: "lr:" });
      return Response.json({ ok: true, name: meta.name, members: members.map((m) => ({ id: m.id, name: m.name })), rounds: [...map].length });
    }

    if (path.endsWith("/join") && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      const name = String(b.name || "").slice(0, 40); if (!name) return Response.json({ ok: false });
      const members = await this.members();
      if (b.accountId) { const ex = members.find((m) => m.accountId === b.accountId); if (ex) return Response.json({ ok: true, memberId: ex.id }); }
      const id = "m_" + Math.random().toString(36).slice(2, 10);
      members.push({ id, name, accountId: b.accountId || null, joined: Date.now() });
      await this.ctx.storage.put("members", members);
      return Response.json({ ok: true, memberId: id });
    }

    if (path.endsWith("/submit") && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      const roundCode = String(b.roundCode || ""); if (!roundCode || !Array.isArray(b.entries)) return Response.json({ ok: false });
      const members = await this.members();
      const byName: Record<string, any> = {}; members.forEach((m) => (byName[m.name.toLowerCase()] = m));
      const results: any[] = [];
      for (const e of b.entries) {
        const m = byName[String(e.name || "").toLowerCase()];
        if (m && e.netToPar != null) results.push({ memberId: m.id, name: m.name, netToPar: Number(e.netToPar), gross: Number(e.gross) || null });
      }
      if (!results.length) return Response.json({ ok: true, matched: 0 });
      await this.ctx.storage.put("lr:" + roundCode, { code: roundCode, date: Number(b.date) || Date.now(), results });
      return Response.json({ ok: true, matched: results.length });
    }

    if (path.endsWith("/standings")) {
      const members = await this.members();
      const agg: Record<string, { id: string; name: string; points: number; rounds: number; sumNet: number }> = {};
      members.forEach((m) => (agg[m.id] = { id: m.id, name: m.name, points: 0, rounds: 0, sumNet: 0 }));
      const map = await this.ctx.storage.list<any>({ prefix: "lr:" });
      const roundList: any[] = [];
      for (const [, lr] of map) {
        roundList.push({ code: lr.code, date: lr.date, n: lr.results.length });
        const ranked = [...lr.results].sort((a, b) => a.netToPar - b.netToPar);
        ranked.forEach((r, i) => {
          const a = agg[r.memberId]; if (!a) return;
          a.points += i < POINTS.length ? POINTS[i] : 1;
          a.rounds += 1; a.sumNet += r.netToPar;
        });
      }
      const standings = Object.values(agg).filter((a) => a.rounds > 0).map((a) => ({ ...a, avgNet: a.sumNet / a.rounds }))
        .sort((x, y) => y.points - x.points || y.rounds - x.rounds || x.avgNet - y.avgNet);
      roundList.sort((a, b) => b.date - a.date);
      return Response.json({ ok: true, name: meta.name, standings, rounds: roundList, memberCount: members.length });
    }

    return new Response("Not found", { status: 404 });
  }
}
