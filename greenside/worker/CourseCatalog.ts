/// <reference types="@cloudflare/workers-types" />

// A single global instance holds every course anyone has confirmed.
// Each saved card makes the next person's search better.
export class CourseCatalog implements DurableObject {
  ctx: DurableObjectState;
  env: any;

  constructor(ctx: DurableObjectState, env: any) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS courses (
          id TEXT PRIMARY KEY,
          key TEXT UNIQUE,
          name TEXT,
          where_txt TEXT,
          lat REAL,
          lng REAL,
          holes TEXT,
          plays INTEGER DEFAULT 0,
          created INTEGER
        )`
      );
      // migrations for older tables — ignore if the column already exists
      try { this.ctx.storage.sql.exec("ALTER TABLE courses ADD COLUMN tees TEXT"); } catch {}
      try { this.ctx.storage.sql.exec("ALTER TABLE courses ADD COLUMN default_tee TEXT"); } catch {}
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;

    if (url.pathname.endsWith("/search")) {
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (q.length < 2) return Response.json({ courses: [] });
      const like = `%${q}%`;
      const rows = sql.exec(
        "SELECT id,name,where_txt,lat,lng FROM courses WHERE lower(name) LIKE ?1 OR lower(where_txt) LIKE ?1 ORDER BY plays DESC LIMIT 8",
        like
      ).toArray();
      return Response.json({
        courses: rows.map((r: any) => ({ id: r.id, name: r.name, where: r.where_txt, lat: r.lat, lng: r.lng, saved: true })),
      });
    }

    if (url.pathname.endsWith("/get")) {
      const id = url.searchParams.get("id") || "";
      const rows = sql.exec("SELECT * FROM courses WHERE id = ?", id).toArray();
      if (!rows.length) return new Response("Not found", { status: 404 });
      const r: any = rows[0];
      sql.exec("UPDATE courses SET plays = plays + 1 WHERE id = ?", id);
      let tees = null; try { tees = r.tees ? JSON.parse(r.tees) : null; } catch {}
      return Response.json({ name: r.name, where: r.where_txt, lat: r.lat, lng: r.lng, holes: JSON.parse(r.holes), tees, defaultTee: r.default_tee || null });
    }

    if (url.pathname.endsWith("/upsert") && request.method === "POST") {
      const c = await request.json<any>();
      if (!c?.name || !Array.isArray(c.holes) || !c.holes.length) return Response.json({ ok: false });
      const key = (c.name + "|" + (c.where || "")).toLowerCase().replace(/[^a-z0-9]/g, "");
      const holes = JSON.stringify(c.holes);
      const teesJson = c.tees && Array.isArray(c.tees) && c.tees.length ? JSON.stringify(c.tees) : null;
      const defTee = c.defaultTee || null;
      const existing = sql.exec("SELECT id FROM courses WHERE key = ?", key).toArray();
      if (existing.length) {
        const id = (existing[0] as any).id;
        sql.exec("UPDATE courses SET name=?,where_txt=?,lat=?,lng=?,holes=?,tees=?,default_tee=? WHERE id=?", c.name, c.where || "", c.lat ?? null, c.lng ?? null, holes, teesJson, defTee, id);
        return Response.json({ id });
      }
      const id = "c_" + crypto.randomUUID().slice(0, 8);
      sql.exec("INSERT INTO courses (id,key,name,where_txt,lat,lng,holes,tees,default_tee,plays,created) VALUES (?,?,?,?,?,?,?,?,?,0,?)",
        id, key, c.name, c.where || "", c.lat ?? null, c.lng ?? null, holes, teesJson, defTee, Date.now());
      return Response.json({ id });
    }

    if (url.pathname.endsWith("/list")) {
      const rows = sql.exec("SELECT id,name,where_txt,plays FROM courses ORDER BY lower(name)").toArray();
      return Response.json({ courses: rows.map((r: any) => ({ id: r.id, name: r.name, where: r.where_txt, plays: r.plays })) });
    }

    if (url.pathname.endsWith("/delete") && request.method === "POST") {
      const { id } = await request.json<any>();
      if (!id) return Response.json({ ok: false });
      sql.exec("DELETE FROM courses WHERE id = ?", id);
      return Response.json({ ok: true });
    }

    return new Response("Bad request", { status: 400 });
  }
}
