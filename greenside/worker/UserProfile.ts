/// <reference types="@cloudflare/workers-types" />

// One Durable Object per golfer account. Holds their display name, their saved round snapshots
// (so history/stats/handicap follow them across devices), and their friends list. Passwordless:
// the account is identified by a random id + secret the device stores; every call carries the
// secret in the x-secret header and the DO checks it. Low-stakes by design (it's your own scores).
export class UserProfile implements DurableObject {
  ctx: DurableObjectState;
  env: any;
  constructor(ctx: DurableObjectState, env: any) { this.ctx = ctx; this.env = env; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Create the account once. Stores the secret and name; a second create is ignored.
    if (path.endsWith("/create") && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      const existing = await this.ctx.storage.get("secret");
      if (!existing) {
        await this.ctx.storage.put("secret", String(b.secret || ""));
        await this.ctx.storage.put("name", String(b.name || "").slice(0, 40));
        await this.ctx.storage.put("created", Date.now());
      }
      return Response.json({ ok: true });
    }

    // Friend card: name + recent round summaries. Readable by anyone holding the account id (a
    // random capability shared only as a friend code); no secret required. The Worker only forwards
    // this for an account id the caller has added as a friend.
    if (path.endsWith("/card")) {
      const name = (await this.ctx.storage.get<string>("name")) || "";
      const map = await this.ctx.storage.list<any>({ prefix: "round:" });
      const rounds: any[] = []; for (const [, v] of map) rounds.push(v);
      rounds.sort((a, b) => (b.endedAt || b.savedAt || 0) - (a.endedAt || a.savedAt || 0));
      return Response.json({ ok: true, name, rounds: rounds.slice(0, 10) });
    }

    // Everything below requires the right secret.
    const secret = await this.ctx.storage.get<string>("secret");
    if (!secret || request.headers.get("x-secret") !== secret) return new Response("Unauthorized", { status: 401 });

    if (path.endsWith("/auth")) return Response.json({ ok: true });

    if (path.endsWith("/me")) {
      const name = (await this.ctx.storage.get<string>("name")) || "";
      const friends = (await this.ctx.storage.get<any[]>("friends")) || [];
      const map = await this.ctx.storage.list<any>({ prefix: "round:" });
      const rounds: any[] = []; for (const [, v] of map) rounds.push(v);
      return Response.json({ ok: true, name, friends, rounds });
    }

    if (path.endsWith("/round") && request.method === "PUT") {
      const snap = await request.json<any>().catch(() => null);
      if (!snap || !snap.code) return Response.json({ ok: false });
      await this.ctx.storage.put("round:" + String(snap.code), snap);
      return Response.json({ ok: true });
    }

    if (path.endsWith("/name") && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      await this.ctx.storage.put("name", String(b.name || "").slice(0, 40));
      return Response.json({ ok: true });
    }

    if (path.endsWith("/friends") && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      const list = (await this.ctx.storage.get<any[]>("friends")) || [];
      if (b.add && b.add.id) {
        if (!list.some((f) => f.id === b.add.id)) { list.push({ id: String(b.add.id), name: String(b.add.name || "").slice(0, 40), added: Date.now() }); await this.ctx.storage.put("friends", list); }
      } else if (b.removeId) {
        const next = list.filter((f) => f.id !== b.removeId); await this.ctx.storage.put("friends", next);
      }
      return Response.json({ ok: true, friends: (await this.ctx.storage.get<any[]>("friends")) || [] });
    }

    return new Response("Not found", { status: 404 });
  }
}
