/// <reference types="@cloudflare/workers-types" />

// Great-circle distance in meters between two lat/lng points.
function haversineM(la1: number, ln1: number, la2: number, ln2: number): number {
  const R = 6371000, d = Math.PI / 180;
  const dLa = (la2 - la1) * d, dLn = (ln2 - ln1) * d;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * d) * Math.cos(la2 * d) * Math.sin(dLn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

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
      // Short-lived device-link codes: redeemed once to carry an account to another device.
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS linkcodes (code TEXT PRIMARY KEY, account TEXT, secret TEXT, expires INTEGER)`
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
      const rows = sql.exec("SELECT map,name FROM holemaps WHERE coordkey = ?", key).toArray();
      if (!rows.length) return Response.json({ found: false });
      try { return Response.json({ found: true, name: (rows[0] as any).name || "", map: JSON.parse((rows[0] as any).map) }); }
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

    // Mint / redeem a device-link code (account cross-device). Codes last 10 minutes, one use.
    if (url.pathname.endsWith("/linkmint") && request.method === "POST") {
      const b = await request.json<any>().catch(() => null);
      if (!b || !b.code || !b.account) return Response.json({ ok: false });
      sql.exec("DELETE FROM linkcodes WHERE expires < ?", Date.now());
      sql.exec("INSERT OR REPLACE INTO linkcodes (code,account,secret,expires) VALUES (?,?,?,?)", String(b.code), String(b.account), String(b.secret || ""), Date.now() + 600000);
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/linkclaim")) {
      const code = url.searchParams.get("code") || "";
      const rows = sql.exec("SELECT account,secret,expires FROM linkcodes WHERE code = ?", code).toArray() as any[];
      const row = rows[0];
      if (!row || row.expires < Date.now()) return Response.json({ ok: false });
      sql.exec("DELETE FROM linkcodes WHERE code = ?", code);
      return Response.json({ ok: true, account: row.account, secret: row.secret });
    }

    // Nearest saved course to a lat/lng (for Quick round — "the course you're standing on").
    // Returns the closest course within ~2.5 miles, with its holes and tees ready to start.
    if (url.pathname.endsWith("/near")) {
      const lat = parseFloat(url.searchParams.get("lat") || "");
      const lng = parseFloat(url.searchParams.get("lng") || "");
      if (!isFinite(lat) || !isFinite(lng)) return Response.json({ found: false });
      const rows = sql.exec("SELECT id,name,where_txt,lat,lng,holes,tees,default_tee FROM courses WHERE lat IS NOT NULL AND lng IS NOT NULL").toArray() as any[];
      let best: any = null, bestD = Infinity;
      for (const r of rows) {
        const d = haversineM(lat, lng, r.lat, r.lng);
        if (d < bestD) { bestD = d; best = r; }
      }
      if (!best || bestD > 4000) return Response.json({ found: false });
      let tees: any = []; try { tees = best.tees ? JSON.parse(best.tees) : []; } catch {}
      let holes: any = []; try { holes = JSON.parse(best.holes); } catch {}
      return Response.json({ found: true, distance: Math.round(bestD), course: { id: best.id, name: best.name, where: best.where_txt, lat: best.lat, lng: best.lng, holes, tees, defaultTee: best.default_tee || null } });
    }

    // Nearest saved courses to a lat/lng, sorted by distance (for the Start tab's "near you" list).
    if (url.pathname.endsWith("/nearby")) {
      const lat = parseFloat(url.searchParams.get("lat") || "");
      const lng = parseFloat(url.searchParams.get("lng") || "");
      const n = Math.min(Math.max(parseInt(url.searchParams.get("n") || "6") || 6, 1), 12);
      if (!isFinite(lat) || !isFinite(lng)) return Response.json({ courses: [] });
      const rows = sql.exec("SELECT id,name,where_txt,lat,lng FROM courses WHERE lat IS NOT NULL AND lng IS NOT NULL").toArray() as any[];
      const withD = rows.map((r) => ({ r, d: haversineM(lat, lng, r.lat, r.lng) })).filter((x) => x.d <= 64000).sort((a, b) => a.d - b.d).slice(0, n);
      return Response.json({ courses: withD.map(({ r, d }) => ({ id: r.id, name: r.name, where: r.where_txt, lat: r.lat, lng: r.lng, distance: Math.round(d) })) });
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
