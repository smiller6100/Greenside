/// <reference types="@cloudflare/workers-types" />

// One Durable Object per username (addressed by idFromName("cred:" + username-lowercased)). It holds
// the login record that maps a username + password to an existing passwordless account (its id +
// secret). Username uniqueness is guaranteed by the addressing: there is exactly one DO per name, and
// /create is a compare-and-set that refuses to overwrite an existing record. Password hashing and
// verification happen in the Worker (WebCrypto PBKDF2); this object only stores and returns the record.
// Nothing here is publicly reachable — only the Worker can address a DO — so returning the secret to
// the Worker on lookup is safe; the Worker only forwards it to the client after the password checks out.
type CredRecord = {
  username: string;   // original-case, for display
  accountId: string;  // the passwordless account this logs into
  secret: string;     // that account's secret (the real session credential)
  pwHash: string;     // PBKDF2 hex
  pwSalt: string;     // hex
  createdAt: number;
};

export class AccountCred implements DurableObject {
  ctx: DurableObjectState;
  env: any;
  constructor(ctx: DurableObjectState, env: any) { this.ctx = ctx; this.env = env; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const rec = await this.ctx.storage.get<CredRecord>("rec");

    // Lookup: returns the record (incl. hash + secret) to the Worker for password verification.
    if (path.endsWith("/record")) {
      return Response.json(rec ? { exists: true, ...rec } : { exists: false });
    }

    // Create: compare-and-set. Refuses if this username already has an account (uniqueness).
    if (path.endsWith("/create") && request.method === "POST") {
      if (rec) return Response.json({ ok: false, taken: true });
      const b = await request.json<any>().catch(() => null);
      if (!b || !b.username || !b.accountId || !b.secret || !b.pwHash || !b.pwSalt) return Response.json({ ok: false });
      const next: CredRecord = {
        username: String(b.username).slice(0, 20),
        accountId: String(b.accountId),
        secret: String(b.secret),
        pwHash: String(b.pwHash),
        pwSalt: String(b.pwSalt),
        createdAt: Date.now(),
      };
      await this.ctx.storage.put("rec", next);
      return Response.json({ ok: true });
    }

    // Change password (reset / user-initiated). Only valid for an existing record, and only for the
    // same account that owns it (the Worker checks ownership, or passes admin: true for an admin reset).
    if (path.endsWith("/setpw") && request.method === "POST") {
      if (!rec) return Response.json({ ok: false });
      const b = await request.json<any>().catch(() => null);
      if (!b || !b.pwHash || !b.pwSalt) return Response.json({ ok: false });
      if (!b.admin && b.accountId !== rec.accountId) return Response.json({ ok: false });
      rec.pwHash = String(b.pwHash); rec.pwSalt = String(b.pwSalt);
      await this.ctx.storage.put("rec", rec);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }
}
