/// <reference types="@cloudflare/workers-types" />
import { GolfRound } from "./GolfRound";
import { CourseCatalog } from "./CourseCatalog";
import type { Env } from "./GolfRound";

export { GolfRound, CourseCatalog };

const BUILD = "v71";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode(len = 4): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const GOLF_API = "https://api.golfcourseapi.com/v1";
const catalog = (env: Env) => env.COURSE_CATALOG.get(env.COURSE_CATALOG.idFromName("global"));

// Produce (and cache) a hole map for a coordinate. Shared by the public route and the admin probe.
async function holeMapFor(lat: number, lng: number, wantHoles: number): Promise<Response> {
  return cachedJson(`https://cache/holemap/v14/${lat.toFixed(4)},${lng.toFixed(4)},${wantHoles}`, 7 * 86400, async () => {
    const q = `[out:json][timeout:25];(way["golf"](around:5000,${lat},${lng});relation["golf"](around:5000,${lat},${lng});way["leisure"="golf_course"](around:5000,${lat},${lng});relation["leisure"="golf_course"](around:5000,${lat},${lng}););out geom;`;
    const servers = [
      "https://overpass.private.coffee/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://overpass-api.de/api/interpreter",
    ];
    // Hit every mirror at once and take whichever answers first. A hard 10s cutoff per mirror
    // means a single hung server can't stall the whole thing the way the old serial walk did.
    const fetchOne = async (ep: string) => {
      const host = ep.split("/")[2];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const r = await fetch(ep, {
          method: "POST", signal: ctrl.signal,
          headers: { "content-type": "application/x-www-form-urlencoded", "accept": "application/json", "user-agent": "GreenSideStrokes/1.0 (+https://greensidestrokes.com; golf hole maps)" },
          body: "data=" + encodeURIComponent(q),
        });
        if (!r.ok) throw new Error("overpass-" + r.status + "@" + host);
        const data = await r.json();
        return { data, host };
      } finally { clearTimeout(timer); }
    };
    let won: { data: any; host: string };
    try {
      won = await Promise.any(servers.map(fetchOne));
    } catch (agg: any) {
      const errs = ((agg && agg.errors) || []).map((e: any) => String((e && e.message) || e)).join("; ") || "all-mirrors-failed";
      return new Response(JSON.stringify({ available: false, error: errs }), { status: 503, headers: { "content-type": "application/json" } });
    }
    // Parse only the winner (all mirrors return the same OSM data, so one parse is enough).
    const result: any = parseHoleMap(won.data, lat, lng, wantHoles);
    // Only cache a map that actually came back with holes. An empty/failed parse returns a
    // non-200 so it is NOT cached — a later retry re-fetches instead of sticking for a week.
    if (result && result.available) return Response.json(result);
    const err = "parsed-empty(found " + ((result && result.counts && result.counts.found) || 0) + ")@" + won.host;
    return new Response(JSON.stringify({ available: false, error: err, counts: result && result.counts }), { status: 503, headers: { "content-type": "application/json" } });
  });
}

const GS_UA = "GreenSideStrokes/1.0 (+https://greensidestrokes.com; golf hole maps)";
const OVERPASS_EPS = ["https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass-api.de/api/interpreter"];
async function overpassJson(q: string): Promise<any | null> {
  for (const ep of OVERPASS_EPS) {
    try {
      const r = await fetch(ep, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "accept": "application/json", "user-agent": GS_UA }, body: "data=" + encodeURIComponent(q) });
      if (r.ok) return await r.json();
    } catch { /* next mirror */ }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resolve a course to coordinates, returning debug on failure so we can see what OSM returned.
// Polite to Nominatim (~1 req/sec), keeps only golf_course results, and never caches a miss.
async function geocodeWithDebug(env: any, name: string, where: string): Promise<{ coords: { lat: number; lng: number } | null; debug: any }> {
  if (!name) return { coords: null, debug: { reason: "no-name" } };
  const w = (where || "").trim();
  const UA = "GreenSideStrokes/1.0 (+https://greensidestrokes.com; golf hole maps)";
  const cacheKey = `https://cache/geo/v5/${encodeURIComponent((name + "|" + w).toLowerCase())}`;
  const cache = (caches as any).default;
  try { const hit = await cache.match(cacheKey); if (hit) { const j: any = await hit.json(); if (j && j.lat != null) return { coords: { lat: j.lat, lng: j.lng }, debug: { cached: true } }; } } catch { /* */ }

  const cleaned = name.replace(/\s+[-—/|]\s+/g, " ").trim();
  const parts = name.split(/\s+[-—/|]\s+/).map((s) => s.trim()).filter(Boolean);
  const sub = parts.length > 1 ? parts[parts.length - 1] : null;
  const cands: string[] = [];
  const add = (s: string) => { const t = (s || "").trim(); if (t && !cands.includes(t)) cands.push(t); };
  add(cleaned + (w ? " " + w : ""));
  if (sub) add(sub + (w ? " " + w : ""));
  add(cleaned);
  const candidates = cands.slice(0, 3);

  const debug: any = { tried: [] };
  for (const q of candidates) {
    if (env.GOLF_API_KEY) {
      try {
        const res = await fetch(`${GOLF_API}/search?search_query=${encodeURIComponent(q)}`, { headers: { Authorization: `Key ${env.GOLF_API_KEY}` } });
        if (res.ok) {
          const loc = (((await res.json()) as any).courses || [])[0]?.location || {};
          if (loc.latitude != null && loc.longitude != null) {
            const coords = { lat: loc.latitude, lng: loc.longitude };
            try { await cache.put(cacheKey, Response.json({ ...coords }, { headers: { "cache-control": "max-age=2592000" } })); } catch { /* */ }
            return { coords, debug: { ...debug, hit: "golfapi:" + q } };
          }
        }
      } catch { /* */ }
    }
    await sleep(1100); // honour Nominatim's ~1 req/sec policy
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`, { headers: { "user-agent": UA, "accept": "application/json" } });
      if (!res.ok) { debug.tried.push({ q, status: res.status }); continue; }
      const arr = (((await res.json()) as any) || []) as any[];
      debug.tried.push({ q, n: arr.length, types: arr.slice(0, 3).map((h) => (h.class || h.category) + "/" + h.type) });
      const golf = arr.find((h) => (h.class === "leisure" || h.category === "leisure") && h.type === "golf_course");
      if (golf) {
        const la = parseFloat(golf.lat), ln = parseFloat(golf.lon);
        if (isFinite(la) && isFinite(ln)) {
          const coords = { lat: la, lng: ln };
          try { await cache.put(cacheKey, Response.json({ ...coords }, { headers: { "cache-control": "max-age=2592000" } })); } catch { /* */ }
          return { coords, debug: { ...debug, hit: "osm:" + q } };
        }
      }
    } catch { debug.tried.push({ q, status: "fetch-failed" }); }
  }

  // Final fallback: Nominatim text search can't see this course, but its geometry is in OSM.
  // Find the town centre, then ask Overpass directly for a golf_course named like this nearby.
  if (w) {
    await sleep(1100);
    let clat = NaN, clng = NaN;
    try {
      const cr = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(w)}`, { headers: { "user-agent": GS_UA, "accept": "application/json" } });
      if (cr.ok) { const a = (((await cr.json()) as any) || [])[0]; if (a) { clat = parseFloat(a.lat); clng = parseFloat(a.lon); } }
    } catch { /* */ }
    if (isFinite(clat) && isFinite(clng)) {
      // Pull every golf course near the town and match by distinctive word overlap with the
      // catalog name — robust to "The Legend at X" vs "The Legends at X" style differences.
      const oq = `[out:json][timeout:25];(way["leisure"="golf_course"](around:18000,${clat},${clng});relation["leisure"="golf_course"](around:18000,${clat},${clng}););out center tags;`;
      const od = await overpassJson(oq);
      const els: any[] = (od && od.elements) || [];
      const stop = new Set(["the", "of", "at", "and", "a", "golf", "course", "courses", "club", "country", "links", "national", "resort", "gc", "cc"]);
      const toks = (s: string) => (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((x) => x && !stop.has(x));
      const want = toks(cleaned);
      const near = els.map((e) => { const c = e.center || (e.lat != null ? { lat: e.lat, lon: e.lon } : null); return c ? { name: (e.tags && e.tags.name) || "", c } : null; }).filter(Boolean) as any[];
      let best: any = null, bestScore = 0, bestLen = 0;
      for (const co of near) {
        const have = new Set(toks(co.name));
        const shared = want.filter((t) => have.has(t));
        const len = shared.reduce((m, t) => Math.max(m, t.length), 0);
        if (shared.length > bestScore || (shared.length === bestScore && len > bestLen)) { bestScore = shared.length; bestLen = len; best = co; }
      }
      const good = best && (bestScore >= 2 || bestLen >= 6); // need 2 shared words, or one distinctive one
      debug.overpass = { town: [+clat.toFixed(3), +clng.toFixed(3)], nearby: near.map((n) => n.name).filter(Boolean).slice(0, 8), pick: good ? best.name : null };
      if (good && isFinite(best.c.lat) && isFinite(best.c.lon)) {
        const coords = { lat: best.c.lat, lng: best.c.lon };
        try { await cache.put(cacheKey, Response.json({ ...coords }, { headers: { "cache-control": "max-age=2592000" } })); } catch { /* */ }
        return { coords, debug: { ...debug, hit: "overpass-match" } };
      }
    } else debug.overpass = { town: "not-found" };
  }
  return { coords: null, debug };
}

async function geocodeCourse(env: any, name: string, where: string): Promise<{ lat: number; lng: number } | null> {
  return (await geocodeWithDebug(env, name, where)).coords;
}

function simplifyCourse(c: any) {
  const loc = c.location || {};
  const name = [c.club_name, c.course_name].filter(Boolean).join(" — ") || c.course_name || c.club_name || "Course";
  return { id: c.id, name, where: [loc.city, loc.state].filter(Boolean).join(", "), lat: loc.latitude ?? null, lng: loc.longitude ?? null, saved: false };
}

function courseToHoles(course: any) {
  const loc = course.location || {};
  const tees = course.tees || {};
  const teeArr = (tees.male && tees.male.length ? tees.male : tees.female && tees.female.length ? tees.female : []) as any[];

  const mkHoles = (t: any) => (Array.isArray(t.holes) ? t.holes : []).map((h: any, i: number) => ({ num: i + 1, par: Number(h.par) || 4, yards: Number(h.yardage) || 0, si: Number(h.handicap) || 0 }));
  const teeData = teeArr.map((t) => ({ name: String(t.tee_name || "Tee"), total: Number(t.total_yards) || 0, holes: mkHoles(t) })).filter((t) => t.holes.length);

  // Shared stroke index across all tees: use a tee with real handicaps, else estimate from the longest tee.
  const siByNum: Record<number, number> = {};
  const withHcp = teeData.find((t) => { const u = new Set(t.holes.map((h) => h.si)); return t.holes.some((h) => h.si > 0) && u.size === t.holes.length; });
  let siEstimated = false;
  if (withHcp) { withHcp.holes.forEach((h) => { siByNum[h.num] = h.si; }); }
  else if (teeData.length) {
    siEstimated = true;
    const longest = [...teeData].sort((a, b) => b.total - a.total)[0];
    [...longest.holes].sort((a, b) => b.yards - a.yards).forEach((h, idx) => { siByNum[h.num] = idx + 1; });
  }
  teeData.forEach((t) => t.holes.forEach((h) => { h.si = siByNum[h.num] || h.si; }));

  const sorted = [...teeData].sort((a, b) => b.total - a.total);
  const def = sorted[Math.floor(sorted.length / 2)] || teeData[0] || null; // middle tee by distance
  const holes = def ? def.holes : [];

  return {
    name: [course.club_name, course.course_name].filter(Boolean).join(" — "),
    where: [loc.city, loc.state].filter(Boolean).join(", "),
    lat: loc.latitude ?? null, lng: loc.longitude ?? null,
    holes, tees: teeData, defaultTee: def ? def.name : "", siEstimated,
  };
}

async function cachedJson(cacheUrl: string, ttl: number, produce: () => Promise<Response>): Promise<Response> {
  const cache = (caches as any).default;
  const key = new Request(cacheUrl);
  const hit = await cache.match(key);
  if (hit) return hit;
  const fresh = await produce();
  if (fresh.ok) { const c = fresh.clone(); c.headers.set("Cache-Control", `max-age=${ttl}`); await cache.put(key, c); }
  return fresh;
}

// Pull JSON out of an AI text response that may include prose or code fences.
function extractJson(text: string): any {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

// ---- OpenStreetMap hole-map parsing (vector hole diagrams + distances) ----
function hmHav(a: number[], b: number[]): number { // meters between [lat,lng]
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
function hmRing(geom: any[]): number[][] { return geom.map((g) => [g.lat, g.lon]); }
function hmCentroid(geom: any[]): number[] { let la = 0, lo = 0; geom.forEach((g) => { la += g.lat; lo += g.lon; }); return [la / geom.length, lo / geom.length]; }
function hmYds(m: number): number { return Math.round(m * 1.09361); }
// Ray-casting point-in-polygon. pt and ring vertices are [lat,lng]; treat lng as x, lat as y.
function hmInside(pt: number[], ring: number[][]): boolean {
  const x = pt[1], y = pt[0];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][1], yi = ring[i][0], xj = ring[j][1], yj = ring[j][0];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// Local meters relative to origin o (equirectangular): returns [east, north].
function hmLocal(o: number[], p: number[]): number[] {
  return [(p[1] - o[1]) * 111320 * Math.cos((o[0] * Math.PI) / 180), (p[0] - o[0]) * 110540];
}
// Perpendicular distance (m) from point c to segment a-b.
function hmSegDist(c: number[], a: number[], b: number[]): number {
  const A = hmLocal(a, a), B = hmLocal(a, b), C = hmLocal(a, c);
  const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy || 1;
  let t = ((C[0] - A[0]) * dx + (C[1] - A[1]) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  const px = A[0] + t * dx, py = A[1] + t * dy;
  return Math.hypot(C[0] - px, C[1] - py);
}
// Min perpendicular distance (m) from c to a polyline's segments.
function hmPerpToPath(c: number[], line: number[][]): number {
  let m = 1e12;
  for (let i = 0; i + 1 < line.length; i++) m = Math.min(m, hmSegDist(c, line[i], line[i + 1]));
  return m;
}
// Signed along-track distance (m) of c from the tee toward the green (negative = behind tee).
function hmAlong(c: number[], tee: number[], gEnd: number[]): number {
  const G = hmLocal(tee, gEnd), C = hmLocal(tee, c);
  const L = Math.hypot(G[0], G[1]) || 1;
  return (C[0] * G[0] + C[1] * G[1]) / L;
}

function parseHoleMap(data: any, qLat: number, qLng: number, wantHoles: number) {
  const els = (data && data.elements) || [];
  const ways = els.filter((e: any) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length);
  const g = (v: string) => ways.filter((w: any) => w.tags && w.tags.golf === v);
  let holeWays = g("hole").filter((w: any) => w.geometry.length >= 2);
  let greens = g("green").map((w: any) => ({ poly: hmRing(w.geometry), c: hmCentroid(w.geometry) }));
  // Collect a golf-tagged area from both plain ways and relation outers (fairway/rough are often multipolygons).
  const gatherArea = (tag: string) => {
    const out: any[] = [];
    els.forEach((e: any) => {
      if (!e.tags || e.tags.golf !== tag) return;
      if (e.type === "way" && Array.isArray(e.geometry) && e.geometry.length >= 4) out.push({ poly: hmRing(e.geometry), c: hmCentroid(e.geometry) });
      else if (e.type === "relation" && Array.isArray(e.members)) e.members.forEach((m: any) => {
        if ((m.role === "outer" || !m.role) && Array.isArray(m.geometry) && m.geometry.length >= 4) out.push({ poly: hmRing(m.geometry), c: hmCentroid(m.geometry) });
      });
    });
    return out;
  };
  let fairways = gatherArea("fairway");
  let rough = gatherArea("rough");
  let tees = g("tee").map((w: any) => ({ poly: hmRing(w.geometry), c: hmCentroid(w.geometry) }));
  let bunkers = g("bunker").map((w: any) => ({ poly: hmRing(w.geometry), c: hmCentroid(w.geometry), kind: "bunker" }));
  let water = ways.filter((w: any) => w.tags && (w.tags.golf === "water_hazard" || w.tags.golf === "lateral_water_hazard" || w.tags.natural === "water"))
    .map((w: any) => ({ poly: hmRing(w.geometry), c: hmCentroid(w.geometry), kind: "water" }));

  // Course boundaries (to isolate ONE course when several are nearby). Ways + relation outers.
  const boundaries: number[][][] = [];
  els.forEach((e: any) => {
    if (!e.tags || e.tags.leisure !== "golf_course") return;
    if (e.type === "way" && Array.isArray(e.geometry) && e.geometry.length >= 4) boundaries.push(hmRing(e.geometry));
    else if (e.type === "relation" && Array.isArray(e.members)) {
      e.members.forEach((m: any) => {
        if ((m.role === "outer" || !m.role) && Array.isArray(m.geometry) && m.geometry.length >= 4) boundaries.push(hmRing(m.geometry));
      });
    }
  });

  // Pick the course for THIS round. Several courses can share one clubhouse, so prefer the one
  // whose hole count matches the round's, then the biggest/nearest.
  const q = [qLat, qLng];
  const teeOf = (w: any) => [w.geometry[0].lat, w.geometry[0].lon];
  const endOf = (w: any) => [w.geometry[w.geometry.length - 1].lat, w.geometry[w.geometry.length - 1].lon];
  const ringArea = (ring: number[][]) => { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][1] * ring[i][0] - ring[i][1] * ring[j][0]; return Math.abs(a / 2); };
  // Each hole belongs to the SMALLEST boundary containing its tee (handles a small course nested in a big one).
  const ownerOf = (w: any) => { let best: number[][] | null = null, ba = Infinity; for (const r of boundaries) { if (hmInside(teeOf(w), r)) { const a = ringArea(r); if (a < ba) { ba = a; best = r; } } } return best; };
  const groups = new Map<number[][], any[]>();
  for (const w of holeWays) { const o = ownerOf(w); if (!o) continue; const arr = groups.get(o) || []; arr.push(w); groups.set(o, arr); }
  const courses = [...groups.entries()].map(([ring, holes]) => ({ ring, holes }));
  let chosenGroups: { ring: number[][]; holes: any[] }[] = [];
  if (courses.length) {
    const distToCourse = (c: any) => Math.min(...c.holes.map((w: any) => hmHav(q, teeOf(w))));
    let relevant = courses.filter((c) => hmInside(q, c.ring) || distToCourse(c) < 400);
    if (!relevant.length) relevant = courses;
    // Order: the course under the query point first, then nearest, then larger.
    const scored = relevant.map((c) => ({ c, contains: hmInside(q, c.ring) ? 1 : 0, dist: distToCourse(c), n: c.holes.length }));
    scored.sort((a, b) => b.contains - a.contains || a.dist - b.dist || b.n - a.n);
    // Accumulate boundaries that move the running hole count TOWARD wantHoles. A 27/36-hole
    // facility is often drawn as separate pieces (an 18 plus a 9, or three 9s); this gathers all
    // of them while still stopping before it pulls in a genuinely different course nearby.
    let cum = 0;
    for (const s of scored) {
      const after = cum + s.n;
      if (chosenGroups.length && wantHoles && Math.abs(after - wantHoles) > Math.abs(cum - wantHoles)) break;
      chosenGroups.push(s.c); cum = after;
      if (!wantHoles || cum >= wantHoles) break;
    }
  }

  const rawFairways = fairways.length, rawRough = rough.length;
  const insideRings = (c: number[], rings: number[][][]) => rings.some((ring) => hmInside(c, ring));
  const overlapsRings = (x: any, rings: number[][][]) => rings.some((ring) => hmInside(x.c, ring) || x.poly.some((p: number[]) => hmInside(p, ring)));
  if (chosenGroups.length) {
    const rings = chosenGroups.map((c) => c.ring);
    let chosen = chosenGroups.flatMap((c) => c.holes);
    // Rescue orphan holes: a course outline in OSM is often drawn too tight and leaves some tees
    // just outside it, so those holes get no owner and vanish. Pull back any orphan hole that sits
    // close to a hole we already have (≤500m), up to the expected count — this recovers the missing
    // holes of THIS course without reaching across to a different course nearby.
    const ownedSet = new Set<any>(); courses.forEach((c) => c.holes.forEach((w: any) => ownedSet.add(w)));
    const orphans = holeWays.filter((w: any) => !ownedSet.has(w));
    let rescued = false;
    if (orphans.length && (!wantHoles || chosen.length < wantHoles)) {
      const near = (w: any) => chosen.some((cw: any) => hmHav(teeOf(w), teeOf(cw)) < 500 || hmHav(endOf(w), teeOf(cw)) < 500);
      let added = true;
      while (added && (!wantHoles || chosen.length < wantHoles)) {
        added = false;
        for (const w of orphans) {
          if (chosen.includes(w)) continue;
          if (wantHoles && chosen.length >= wantHoles) break;
          if (near(w)) { chosen.push(w); added = true; rescued = true; }
        }
      }
    }
    const hpts: number[][] = []; chosen.forEach((w: any) => { hpts.push(teeOf(w), endOf(w)); });
    const nearHole = (c: number[]) => hpts.some((p) => hmHav(c, p) < 90);
    const keepC = (c: number[]) => insideRings(c, rings) || (rescued && nearHole(c));
    const keepX = (x: any) => overlapsRings(x, rings) || (rescued && nearHole(x.c));
    holeWays = chosen;
    greens = greens.filter((x: any) => keepC(x.c));
    // A big fairway/rough can straddle an imperfect boundary, so keep it if its centroid OR any vertex is inside.
    fairways = fairways.filter((x: any) => keepX(x));
    rough = rough.filter((x: any) => keepX(x));
    tees = tees.filter((x: any) => keepC(x.c));
    bunkers = bunkers.filter((x: any) => keepC(x.c));
    water = water.filter((x: any) => keepC(x.c));
  }

  const counts = { found: g("hole").length, courses: boundaries.length, holes: holeWays.length, greens: greens.length, fairways: fairways.length, rawFairways, rough: rough.length, rawRough, tees: tees.length, bunkers: bunkers.length, water: water.length };
  if (!holeWays.length) return { available: false, counts };

  const nearest = (c: number[], arr: any[]) => { let best: any = null, bd = 1e12; for (const a of arr) { const d = hmHav(c, a.c); if (d < bd) { bd = d; best = a; } } return { best, bd }; };
  // Each tee box belongs to the hole whose tee it sits nearest to — stops one hole's box
  // (e.g. an adjacent hole's tee that happens to be close) being grabbed by its neighbour.
  const holeStarts = holeWays.map((w: any) => hmRing(w.geometry)[0]);

  let holes = holeWays.map((w: any) => {
    const line = hmRing(w.geometry);
    const tee = line[0], gEnd = line[line.length - 1];
    const ref = parseInt(w.tags.ref);
    const par = parseInt(w.tags.par) || null;
    const gn = nearest(gEnd, greens);
    const green = gn.best && gn.bd < 80 ? gn.best : null;
    const greenC = green ? green.c : gEnd;
    // Fairways: sample points along the actual play line (follows doglegs) and keep every
    // fairway polygon the line runs through. OSM splits a hole's fairway into several pieces.
    const mid = [(tee[0] + gEnd[0]) / 2, (tee[1] + gEnd[1]) / 2];
    const lineSamples: number[][] = [];
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1];
      for (let s = 0; s <= 12; s++) { const t = s / 12; lineSamples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    let holeFairways = fairways.filter((f: any) => lineSamples.some((p) => hmInside(p, f.poly))).map((f: any) => f.poly);
    if (!holeFairways.length) { const fw = nearest(mid, fairways); if (fw.best && fw.bd < 100) holeFairways = [fw.best.poly]; }
    // Rough: pieces the play line runs through, but skip any sitting well behind the tee
    // (a stray between-holes patch behind the box rather than the hole's own rough).
    const holeRough = rough.filter((r: any) => lineSamples.some((p) => hmInside(p, r.poly)) && hmAlong(r.c, tee, gEnd) > -45).map((r: any) => r.poly);
    // Tee boxes: a golf=tee polygon belongs here only if THIS hole's tee is the closest of all
    // holes (within a generous cap that still reaches the forward tees ahead of the back tee).
    const holeTees = tees.filter((t: any) => {
      const dMine = hmHav(t.c, tee);
      if (dMine > 95) return false;
      let dBest = 1e12; for (const s of holeStarts) { const d = hmHav(t.c, s); if (d < dBest) dBest = d; }
      return dMine <= dBest + 0.5;
    }).map((t: any) => t.poly);
    // Bunkers attach only if close to the tee->green corridor AND well past the tee
    // (drops a neighbouring hole's greenside sand that merely sits beside this tee).
    const teeToGreenM = hmHav(tee, greenC);
    const hazBunkers = bunkers.filter((h) => hmPerpToPath(h.c, line) < 35 && hmAlong(h.c, tee, gEnd) > 25 && hmAlong(h.c, tee, gEnd) < teeToGreenM + 35);
    const hazWater = water.filter((h) => hmPerpToPath(h.c, line) < 55); // forced tee carries are legit
    const hazards = [...hazBunkers, ...hazWater]
      .map((h) => ({ kind: h.kind, poly: h.poly, c: h.c, yards: hmYds(hmHav(tee, h.c)) }));
    return { ref: isFinite(ref) ? ref : null, par, line, tee, green: green ? green.poly : null, greenC, fairways: holeFairways, rough: holeRough, tees: holeTees, hazards, teeToGreenYds: hmYds(hmHav(tee, greenC)) };
  }).sort((a: any, b: any) => (a.ref || 99) - (b.ref || 99));

  // Safety net: if duplicate hole numbers remain, keep the first of each.
  const seen = new Set<number>();
  holes = holes.filter((h: any) => { if (h.ref == null) return true; if (seen.has(h.ref)) return false; seen.add(h.ref); return true; });

  return { available: true, counts, holes };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Version check: open /api/version in a browser to confirm which build is live.
    if (path === "/api/version") return Response.json({ version: BUILD });

    // Diagnostic: visit /api/diag in a browser to test the AI vision model.
    if (path === "/api/diag" && request.method === "GET") {
      const out: any = { worker: "ok", hasGolfKey: !!env.GOLF_API_KEY, hasAI: !!env.AI };
      const png = [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,13,73,68,65,84,120,156,99,250,207,0,0,0,3,1,1,0,24,221,141,219,0,0,0,0,73,69,78,68,174,66,96,130];
      try {
        const v: any = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { image: png, prompt: "Reply with the word OK.", max_tokens: 5 });
        out.visionOk = true; out.visionReply = String(v?.response || "").slice(0, 80);
      } catch (e: any) {
        out.visionOk = false; out.visionError = String(e?.message || e).slice(0, 400);
      }
      return Response.json(out);
    }

    // One-time: visit /api/agree to accept Meta's license through THIS worker's AI binding.
    if (path === "/api/agree" && request.method === "GET") {
      const out: any = {};
      const models: [string, string][] = [
        ["vision", "@cf/meta/llama-3.2-11b-vision-instruct"],
        ["scout", "@cf/meta/llama-4-scout-17b-16e-instruct"],
      ];
      for (const [key, model] of models) {
        try {
          const r: any = await env.AI.run(model, { prompt: "agree", max_tokens: 16 });
          out[key] = { accepted: true, reply: String(r?.response || "").slice(0, 160) };
        } catch (e: any) {
          out[key] = { accepted: false, error: String(e?.message || e).slice(0, 240) };
        }
      }
      return Response.json(out);
    }

    // ---- Search: our catalog first, then the public API ----
    if (path === "/api/courses/search" && request.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return Response.json({ courses: [] });

      let saved: any[] = [];
      try { saved = (await (await catalog(env).fetch(`https://do/search?q=${encodeURIComponent(q)}`)).json() as any).courses || []; } catch { /* */ }

      let online: any[] = [];
      if (env.GOLF_API_KEY) {
        try {
          const r = await cachedJson(`https://cache/csearch?q=${encodeURIComponent(q.toLowerCase())}`, 86400, async () => {
            const res = await fetch(`${GOLF_API}/search?search_query=${encodeURIComponent(q)}`, { headers: { Authorization: `Key ${env.GOLF_API_KEY}` } });
            if (!res.ok) return Response.json({ courses: [] });
            const d: any = await res.json();
            return Response.json({ courses: (d.courses || []).slice(0, 10).map(simplifyCourse) });
          });
          online = ((await r.json()) as any).courses || [];
        } catch { /* */ }
      }

      const seen = new Set(saved.map((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, "")));
      const merged = [...saved, ...online.filter((c) => !seen.has(c.name.toLowerCase().replace(/[^a-z0-9]/g, "")))].slice(0, 12);
      return Response.json({ courses: merged, unconfigured: !env.GOLF_API_KEY && saved.length === 0 });
    }

    // ---- Course detail ----
    const cm = path.match(/^\/api\/courses\/([A-Za-z0-9_]+)$/);
    if (cm && request.method === "GET") {
      const id = cm[1];
      if (id.startsWith("c_")) {
        const r = await catalog(env).fetch(`https://do/get?id=${encodeURIComponent(id)}`);
        if (!r.ok) return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
        const c: any = await r.json();
        // Self-heal: a scanned course with no coords gets geocoded once so its rounds can show a map.
        if ((c.lat == null || c.lng == null) && c.name) {
          const g = await geocodeCourse(env, c.name, c.where || "");
          if (g) {
            c.lat = g.lat; c.lng = g.lng;
            await catalog(env).fetch("https://do/setcoords", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, lat: g.lat, lng: g.lng }) });
          }
        }
        return Response.json(c);
      }
      if (/^\d+$/.test(id)) {
        if (!env.GOLF_API_KEY) return new Response("Not configured", { status: 503 });
        return cachedJson(`https://cache/course/v2/${id}`, 604800, async () => {
          const r = await fetch(`${GOLF_API}/courses/${id}`, { headers: { Authorization: `Key ${env.GOLF_API_KEY}` } });
          if (!r.ok) return new Response("Course not found", { status: r.status });
          const d: any = await r.json();
          return Response.json(courseToHoles(d.course));
        });
      }
      return new Response("Not found", { status: 404 });
    }

    // ---- Scan a scorecard photo with Cloudflare AI ----
    if (path === "/api/courses/scan" && request.method === "POST") {
      try {
        const wantNines = !!url.searchParams.get("nines"); // ?nines=3 → read a 27-hole / three-nines card
        const buf = await request.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const image = [...bytes]; // byte array for the small vision model
        let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const dataUrl = `data:image/jpeg;base64,${btoa(bin)}`; // data URL for Llama 4 Scout
        const prompt =
          'You read golf scorecards. Look at the image and return STRICT JSON only — no prose, no code fences — in exactly this shape: ' +
          '{"name":"<course name>","par":[18 numbers],"handicap":[18 numbers],"tees":[{"name":"<tee or color name>","yards":[18 numbers]}]}. ' +
          '"par" = the Par for holes 1 to 18 in order. "handicap" = the stroke-index / handicap rank (1 to 18) for holes 1 to 18 in order; if men and women rows both exist use the first row. ' +
          '"tees" = ONE entry for EACH tee box / colored row on the card (for example Black, Blue, White, Gold, Red, Orange, Teal); "yards" = that row\'s yardage for holes 1 to 18 in order. ' +
          'Read left to right, front nine then back nine. Ignore the OUT, IN and TOTAL subtotal columns — give only the 18 real hole numbers. If a value is unreadable use 0. Return only the JSON.';
        const ninePrompt =
          'You read golf scorecards. This card is a 27-hole course made of SEPARATE nine-hole courses, each with its OWN name (for example "The Callow", "The Meath", "The Birr"), its own Par row (9 values), its own Handicap / stroke-index row (values 1 to 9), and one or more tee rows (e.g. Black, Blue, White, Red) each with 9 yardages. ' +
          'Return STRICT JSON only — no prose, no code fences — in exactly this shape: {"nines":[{"name":"<nine name>","par":[9 numbers],"handicap":[9 numbers],"tees":[{"name":"<tee>","yards":[9 numbers]}]}]}. ' +
          'Include one object per nine, in the order they appear. Each "par", "handicap" and "yards" array has exactly 9 values for holes 1 to 9 of THAT nine. Ignore OUT / IN / TOTAL columns. If a value is unreadable use 0. Return only the JSON.';

        const numArr = (a: any): number[] => (Array.isArray(a) ? a.map((v) => Number(v) || 0) : []);
        const flat = (one: any, f: any, b: any): number[] => {
          if (Array.isArray(one) && one.length) return numArr(one);
          return [...numArr(f), ...numArr(b)];
        };
        const strip = (arr: number[], isTotal: (v: number) => boolean): number[] => arr.filter((v) => !isTotal(v)).slice(0, 18);
        const clampPar = (p: number) => (p >= 3 && p <= 6 ? p : 4);

        // Build per-nine data from a {nines:[...]} reply for a 27-hole card.
        const buildNines = (parsed: any) => {
          const ninesIn = Array.isArray(parsed?.nines) ? parsed.nines : [];
          if (!ninesIn.length) return null;
          const nn = ninesIn.slice(0, 4).map((nine: any, idx: number) => {
            const par = numArr(nine.par).filter((v) => v >= 3 && v <= 6).slice(0, 9);
            const hcp = numArr(nine.handicap).filter((v) => v >= 1 && v <= 9).slice(0, 9);
            const teesIn = Array.isArray(nine.tees) ? nine.tees : [];
            const tees = teesIn.map((t: any) => ({ name: String(t.name || "Tee").trim() || "Tee", yards: numArr(t.yards).filter((v) => v < 800).slice(0, 9).map((y) => Math.max(0, Math.min(899, y))) })).filter((t: any) => t.yards.some((y: number) => y > 0));
            let si = Array.from({ length: 9 }, () => 0);
            if (hcp.length === 9 && new Set(hcp).size === 9) si = hcp.slice();
            else if (tees.length) { const longest = [...tees].sort((a, b) => b.yards.reduce((s: number, y: number) => s + y, 0) - a.yards.reduce((s: number, y: number) => s + y, 0))[0]; longest.yards.map((y: number, i: number) => ({ y, i })).sort((a, b) => b.y - a.y).forEach((o, r) => (si[o.i] = r + 1)); }
            else si = si.map((_, i) => i + 1);
            return { name: String(nine.name || `Nine ${idx + 1}`).trim() || `Nine ${idx + 1}`, par: Array.from({ length: 9 }, (_, i) => clampPar(par[i])), si, tees };
          }).filter((n: any) => n.tees.length || n.par.length);
          if (!nn.length) return null;
          const cells = nn.reduce((s: number, n: any) => s + n.tees.reduce((a: number, t: any) => a + t.yards.filter((y: number) => y > 0).length, 0), 0);
          return { score: 5000 + cells, payload: { multiNine: true, name: typeof parsed?.name === "string" ? parsed.name : "", nines: nn } };
        };

        // Turn one model JSON reply into tee data plus a quality score (or null if nothing usable).
        const build = (parsed: any) => {
          if (!parsed) return null;
          const par = strip(flat(parsed.par, parsed.par_front, parsed.par_back), (v) => v > 7);       // par 3-6; 36/72 subtotals removed
          const hcp = strip(flat(parsed.handicap, parsed.hcp_front, parsed.hcp_back), (v) => v > 18); // stroke index 1-18
          let teesIn: any[] = Array.isArray(parsed.tees) ? parsed.tees : [];
          if (!teesIn.length && Array.isArray(parsed.holes)) {
            teesIn = [{ name: "Tees", yards: parsed.holes.map((h: any) => Number(h.yards) || 0) }];
            parsed.holes.forEach((h: any, i: number) => { if (!par[i]) (par as any)[i] = Number(h.par) || 0; });
          }
          const teeYards = (t: any): number[] => strip(flat(t.yards, t.front, t.back), (v) => v >= 800); // no single hole is 800+, so totals drop out
          const n = Math.max(par.length, hcp.length, ...teesIn.map((t) => teeYards(t).length), 0);
          if (!n) return null;
          let teeData = teesIn.map((t) => {
            const y = teeYards(t);
            const holes = Array.from({ length: n }, (_, i) => ({ num: i + 1, par: clampPar(par[i]), yards: Math.max(0, Math.min(899, y[i] || 0)), si: 0 }));
            return { name: (String(t.name || "Tee").trim() || "Tee"), total: holes.reduce((s, h) => s + h.yards, 0), holes };
          }).filter((t) => t.holes.length);
          if (!teeData.length) teeData = [{ name: "Scanned", total: 0, holes: Array.from({ length: n }, (_, i) => ({ num: i + 1, par: clampPar(par[i]), yards: 0, si: 0 })) }];

          const siByNum: Record<number, number> = {};
          const hValid = hcp.filter((x) => x >= 1 && x <= n);
          const hUnique = hValid.length === n && new Set(hValid).size === n;
          let siEstimated = false;
          if (hUnique) { hcp.forEach((v, i) => (siByNum[i + 1] = v)); }
          else {
            siEstimated = true;
            const longest = [...teeData].sort((a, b) => b.total - a.total)[0];
            [...longest.holes].sort((a, b) => b.yards - a.yards).forEach((h, idx) => (siByNum[h.num] = idx + 1));
          }
          teeData.forEach((t) => t.holes.forEach((h) => (h.si = siByNum[h.num] || 0)));
          const sorted = [...teeData].sort((a, b) => b.total - a.total);
          const def = sorted[Math.floor(sorted.length / 2)] || teeData[0];
          const teesWithYards = teeData.filter((t) => t.total > 0).length;
          const filledCells = teeData.reduce((s, t) => s + t.holes.filter((h) => h.yards > 0).length, 0);
          const score = teesWithYards * 1000 + filledCells; // reward reads that actually have yardages
          return { score, payload: { name: typeof parsed.name === "string" ? parsed.name : "", holes: def.holes, tees: teeData, defaultTee: def.name, siEstimated } };
        };

        // The vision model is inconsistent on dense cards — read a few times and keep the best.
        // Structured-output schema so the strong model returns clean, parseable JSON.
        const schema = {
          type: "object",
          properties: {
            name: { type: "string" },
            par: { type: "array", items: { type: "number" } },
            handicap: { type: "array", items: { type: "number" } },
            tees: { type: "array", items: { type: "object", properties: { name: { type: "string" }, yards: { type: "array", items: { type: "number" } } }, required: ["name", "yards"] } },
          },
          required: ["par", "tees"],
        };
        const ninesSchema = {
          type: "object",
          properties: {
            name: { type: "string" },
            nines: { type: "array", items: { type: "object", properties: {
              name: { type: "string" },
              par: { type: "array", items: { type: "number" } },
              handicap: { type: "array", items: { type: "number" } },
              tees: { type: "array", items: { type: "object", properties: { name: { type: "string" }, yards: { type: "array", items: { type: "number" } } }, required: ["name", "yards"] } },
            }, required: ["name", "par", "tees"] } },
          },
          required: ["nines"],
        };
        const usePrompt = wantNines ? ninePrompt : prompt;
        const useSchema = wantNines ? ninesSchema : schema;
        const useBuild = wantNines ? buildNines : build;
        const asText = (resp: any) => (typeof resp === "string" ? resp : resp ? JSON.stringify(resp) : "");
        // Primary: Llama 4 Scout (far stronger vision). Fallback: the small vision model.
        const runScout = async () => {
          const out: any = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
            messages: [{ role: "user", content: [{ type: "text", text: usePrompt }, { type: "image_url", image_url: { url: dataUrl } }] }],
            max_tokens: 2400, temperature: 0.1, guided_json: useSchema,
          });
          return asText(out?.response);
        };
        const runSmall = async () => {
          const out: any = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { image, prompt: usePrompt, max_tokens: 2200 });
          return asText(out?.response);
        };

        let best: any = null;
        const attempts = [runScout, runScout, runSmall]; // strong model twice, then fall back
        for (const run of attempts) {
          let text = "";
          try { text = await run(); } catch { continue; }
          const r = useBuild(extractJson(text));
          if (r && (!best || r.score > best.score)) best = r;
          if (best && best.score >= (wantNines ? 5000 : 2000)) break;
        }
        if (!best || best.score === 0) return Response.json({ error: "unreadable" }, { status: 422 });
        return Response.json(best.payload);
      } catch (e: any) {
        return Response.json({ error: "failed", detail: String(e?.message || e).slice(0, 300) }, { status: 500 });
      }
    }

    // ---- Admin (gated by the ADMIN_KEY secret set in the Cloudflare dashboard) ----
    if (path.startsWith("/api/admin/")) {
      const key = request.headers.get("x-admin-key") || "";
      const ok = !!env.ADMIN_KEY && key === env.ADMIN_KEY;
      if (path === "/api/admin/check" && request.method === "POST") {
        return Response.json({ ok, configured: !!env.ADMIN_KEY });
      }
      if (!ok) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      if (path === "/api/admin/courses" && request.method === "GET") {
        const r = await catalog(env).fetch("https://do/list");
        return new Response(await r.text(), { headers: { "content-type": "application/json" } });
      }
      if (path === "/api/admin/courses/delete" && request.method === "POST") {
        const body = await request.text();
        const r = await catalog(env).fetch("https://do/delete", { method: "POST", headers: { "content-type": "application/json" }, body });
        return new Response(await r.text(), { headers: { "content-type": "application/json" } });
      }

      if (path === "/api/admin/courses/rename" && request.method === "POST") {
        const body = await request.text();
        const r = await catalog(env).fetch("https://do/rename", { method: "POST", headers: { "content-type": "application/json" }, body });
        return new Response(await r.text(), { headers: { "content-type": "application/json" } });
      }

      // Walk the catalog: fill missing coords (geocode + persist), then probe OSM for hole coverage.
      // Paginate with ?offset & ?limit to be gentle on the public Overpass mirrors.
      if (path === "/api/admin/coverage" && request.method === "GET") {
        const offset = parseInt(url.searchParams.get("offset") || "0") || 0;
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "30") || 30, 60);
        const idsParam = url.searchParams.get("ids");
        const ids = idsParam ? idsParam.split(",").map((s) => s.trim()).filter(Boolean) : null;
        const lr = await catalog(env).fetch("https://do/listfull");
        const all = (((await lr.json()) as any).courses || []) as any[];
        const slice = ids ? all.filter((c) => ids.includes(c.id)).slice(0, 12) : all.slice(offset, offset + limit);
        const out: any[] = [];
        for (const c of slice) {
          let lat = c.lat, lng = c.lng, source = "catalog";
          let geo: any = null;
          if (lat == null || lng == null) {
            const gr = await geocodeWithDebug(env, c.name, c.where || "");
            if (gr.coords) {
              lat = gr.coords.lat; lng = gr.coords.lng; source = "geocoded";
              await catalog(env).fetch("https://do/setcoords", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: c.id, lat, lng }) });
            } else { source = "no-coords"; geo = gr.debug; }
          }
          let holesMapped = 0, mapErr: string | null = null, foundRaw: number | null = null;
          if (lat != null && lng != null) {
            try {
              const hm: any = await (await holeMapFor(lat, lng, c.holesN || 18)).json();
              foundRaw = hm.counts ? hm.counts.found : null;
              if (hm.available) holesMapped = (hm.holes || []).length; else mapErr = hm.error || "not-mapped";
            } catch { mapErr = "probe-failed"; }
          }
          out.push({ id: c.id, name: c.name, where: c.where, source, holesExpected: c.holesN, holesMapped, foundRaw, mapErr, geo });
        }
        return Response.json({ total: ids ? slice.length : all.length, offset, returned: slice.length, nextOffset: ids ? null : (offset + slice.length < all.length ? offset + slice.length : null), courses: out });
      }
      return new Response("Not found", { status: 404 });
    }

    // ---- Create a round (and save its course to the catalog) ----
    if (path === "/api/round" && request.method === "POST") {
      const cfg = await request.json<any>();
      const code = genCode();
      const adminToken = genCode(20);
      const stub = env.GOLF_ROUND.get(env.GOLF_ROUND.idFromName(code));
      await stub.fetch("https://do/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...cfg, code, adminToken }) });
      if (cfg.courseName && Array.isArray(cfg.course) && cfg.course.length) {
        try {
          const catHoles = Array.isArray(cfg.catalogHoles) && cfg.catalogHoles.length ? cfg.catalogHoles : cfg.course;
          const catTees = Array.isArray(cfg.catalogTees) && cfg.catalogTees.length ? cfg.catalogTees : (cfg.tees || null);
          await catalog(env).fetch("https://do/upsert", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: cfg.courseName, where: cfg.courseWhere || "", lat: cfg.lat ?? null, lng: cfg.lng ?? null, holes: catHoles, tees: catTees, defaultTee: cfg.teeName || cfg.defaultTee || null }) });
        } catch { /* non-fatal */ }
      }
      // Pre-warm the hole map so it's cached before the group reaches the first tee. Fire-and-forget
      // with the same coords/hole-count the round screen will request, so it lands on the same cache key.
      if (cfg.lat != null && cfg.lng != null && Array.isArray(cfg.course) && cfg.course.length) {
        ctx.waitUntil(holeMapFor(cfg.lat, cfg.lng, cfg.course.length).catch(() => {}));
      }
      return Response.json({ code, adminToken });
    }

    // ---- Hole maps from OpenStreetMap (vector diagrams + distances) ----
    if (path === "/api/holemap" && request.method === "GET") {
      const lat = parseFloat(url.searchParams.get("lat") || "");
      const lng = parseFloat(url.searchParams.get("lng") || "");
      const wantHoles = parseInt(url.searchParams.get("holes") || "0") || 0;
      if (!isFinite(lat) || !isFinite(lng)) return Response.json({ available: false, error: "no-location" });
      return holeMapFor(lat, lng, wantHoles);
    }

    // ---- A round's live object ----
    const m = path.match(/^\/api\/round\/([A-Za-z0-9]+)(?:\/connect)?$/);
    if (m) {
      const stub = env.GOLF_ROUND.get(env.GOLF_ROUND.idFromName(m[1].toUpperCase()));
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
