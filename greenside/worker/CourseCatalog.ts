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
      // Lightweight usage counters: one row per (UTC day, event type).
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS metrics (day TEXT, type TEXT, n INTEGER DEFAULT 0, PRIMARY KEY (day, type))`
      );
      // Saved hole maps, keyed by rounded "lat,lng". Holds hand-mapped greens (and persisted
      // OSM successes) so a course is served its map instantly, without depending on Overpass.
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS holemaps (coordkey TEXT PRIMARY KEY, name TEXT, map TEXT, updated INTEGER)`
      );
      // Live field registry: every round that's created at a course registers here, keyed by the
      // course's rounded "lat,lng". The clubhouse board reads it to see the whole course at once.
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS active_rounds (code TEXT PRIMARY KEY, coordkey TEXT, name TEXT, outing INTEGER DEFAULT 0, created INTEGER)`
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;

    // Save a hole map for a course (by rounded coord key). Replaces any existing map there.
    if (url.pathname.endsWith("/savemap") && request.method === "POST") {
      const b = await request.json<any>().catch(() => null);
      if (!b || !b.coordkey || !b.map) return Response.json({ ok: false });
      sql.exec(
        "INSERT INTO holemaps (coordkey,name,map,updated) VALUES (?,?,?,?) ON CONFLICT(coordkey) DO UPDATE SET name=excluded.name, map=excluded.map, updated=excluded.updated",
        String(b.coordkey), String(b.name || ""), JSON.stringify(b.map), Date.now()
      );
      return Response.json({ ok: true });
    }
    // Register a round at its course for the live field board.
    if (url.pathname.endsWith("/field/add") && request.method === "POST") {
      const b = await request.json<any>().catch(() => null);
      if (!b || !b.code || !b.coordkey) return Response.json({ ok: false });
      sql.exec(
        "INSERT INTO active_rounds (code,coordkey,name,outing,created) VALUES (?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET coordkey=excluded.coordkey, name=excluded.name, outing=excluded.outing, created=excluded.created",
        String(b.code), String(b.coordkey), String(b.name || ""), b.outing ? 1 : 0, Date.now()
      );
      return Response.json({ ok: true });
    }
    // List the recent rounds at a course (by coord key) for the clubhouse board.
    if (url.pathname.endsWith("/field/list")) {
      const key = url.searchParams.get("key") || "";
      const since = Date.now() - 8 * 3600 * 1000; // rounds started in the last 8 hours
      const rows = sql.exec("SELECT code,name,outing,created FROM active_rounds WHERE coordkey = ? AND created >= ? ORDER BY created DESC LIMIT 60", key, since).toArray();
      return Response.json({ rounds: rows });
    }
    // Fetch a saved hole map by coord key, if one exists.
    if (url.pathname.endsWith("/getmap")) {
      const key = url.searchParams.get("key") || "";
      const rows = sql.exec("SELECT map FROM holemaps WHERE coordkey = ?", key).toArray();
      if (!rows.length) return Response.json({ found: false });
      try { return Response.json({ found: true, map: JSON.parse((rows[0] as any).map) }); }
      catch { return Response.json({ found: false }); }
    }

    if (url.pathname.endsWith("/bump") && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      const type = String(b?.type || "").slice(0, 20);
      const amt = Math.max(1, Math.min(200, Number(b?.n) || 1));
      if (type) {
        const day = new Date().toISOString().slice(0, 10);
        sql.exec("INSERT INTO metrics (day,type,n) VALUES (?,?,?) ON CONFLICT(day,type) DO UPDATE SET n = n + excluded.n", day, type, amt);
      }
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith("/stats")) {
      const dayStr = (back: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - back); return d.toISOString().slice(0, 10); };
      const totalsRows = sql.exec("SELECT type, SUM(n) AS s FROM metrics GROUP BY type").toArray();
      const totals: any = {}; for (const r of totalsRows as any[]) totals[r.type] = r.s;
      const courses = (sql.exec("SELECT COUNT(*) AS c FROM courses").toArray()[0] as any).c;
      const sumSince = (from: string, type: string) => ((sql.exec("SELECT SUM(n) AS s FROM metrics WHERE type=? AND day>=?", type, from).toArray()[0] as any).s) || 0;
      const dailyRows = sql.exec("SELECT day, type, n FROM metrics WHERE day>=? ORDER BY day", dayStr(29)).toArray() as any[];
      const dmap: any = {}; for (const r of dailyRows) { (dmap[r.day] ||= {})[r.type] = r.n; }
      const daily: any[] = [];
      for (let i = 29; i >= 0; i--) { const d = dayStr(i); daily.push({ day: d, round: (dmap[d]?.round) || 0, scan: (dmap[d]?.scan) || 0 }); }
      const today = dayStr(0);
      return Response.json({
        courses, totals,
        today: { round: sumSince(today, "round"), scan: sumSince(today, "scan") },
        d7: { round: sumSince(dayStr(6), "round"), scan: sumSince(dayStr(6), "scan") },
        d30: { round: sumSince(dayStr(29), "round"), scan: sumSince(dayStr(29), "scan") },
        daily,
      });
    }

    if (url.pathname.endsWith("/resetstats") && request.method === "POST") {
      sql.exec("DELETE FROM metrics");
      return Response.json({ ok: true });
    }

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
      const existing = sql.exec("SELECT id, holes, tees FROM courses WHERE key = ?", key).toArray();
      if (existing.length) {
        const ex: any = existing[0];
        const yardSum = (hsJson: string, tsJson: string) => {
          let s = 0;
          try { for (const h of JSON.parse(hsJson || "[]")) s += Number(h.yards) || 0; } catch {}
          try { for (const t of (JSON.parse(tsJson || "null") || [])) for (const h of (t.holes || [])) s += Number(h.yards) || 0; } catch {}
          return s;
        };
        const inYards = yardSum(holes, teesJson || "null");
        const exYards = yardSum(ex.holes, ex.tees);
        // A blank/par-only re-scan shouldn't wipe out a richer saved card. Keep the existing
        // holes/tees (which have yardages) and just refresh name/location.
        if (inYards === 0 && exYards > 0) {
          sql.exec("UPDATE courses SET name=?,where_txt=?,lat=?,lng=? WHERE id=?", c.name, c.where || "", c.lat ?? null, c.lng ?? null, ex.id);
          return Response.json({ id: ex.id, kept: true });
        }
        sql.exec("UPDATE courses SET name=?,where_txt=?,lat=?,lng=?,holes=?,tees=?,default_tee=? WHERE id=?", c.name, c.where || "", c.lat ?? null, c.lng ?? null, holes, teesJson, defTee, ex.id);
        return Response.json({ id: ex.id });
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

    if (url.pathname.endsWith("/listfull")) {
      const rows = sql.exec("SELECT id,name,where_txt,lat,lng,holes FROM courses ORDER BY lower(name)").toArray();
      return Response.json({ courses: rows.map((r: any) => {
        let holesN = 0; try { holesN = JSON.parse(r.holes).length; } catch {}
        return { id: r.id, name: r.name, where: r.where_txt, lat: r.lat, lng: r.lng, holesN };
      }) });
    }

    if (url.pathname.endsWith("/setcoords") && request.method === "POST") {
      const { id, lat, lng } = await request.json<any>();
      if (!id) return Response.json({ ok: false });
      sql.exec("UPDATE courses SET lat=?,lng=? WHERE id=?", lat ?? null, lng ?? null, id);
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith("/rename") && request.method === "POST") {
      const { id, name, where } = await request.json<any>();
      if (!id || !name) return Response.json({ ok: false });
      const key = (name + "|" + (where || "")).toLowerCase().replace(/[^a-z0-9]/g, "");
      const clash = sql.exec("SELECT id FROM courses WHERE key=? AND id<>?", key, id).toArray();
      // Renaming corrects a bad scan, so wipe coords to force a fresh geocode under the new name.
      if (clash.length) sql.exec("UPDATE courses SET name=?,where_txt=?,lat=NULL,lng=NULL WHERE id=?", name, where || "", id);
      else sql.exec("UPDATE courses SET name=?,where_txt=?,key=?,lat=NULL,lng=NULL WHERE id=?", name, where || "", key, id);
      return Response.json({ ok: true });
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
