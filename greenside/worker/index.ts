/// <reference types="@cloudflare/workers-types" />
import { GolfRound } from "./GolfRound";
import { CourseCatalog } from "./CourseCatalog";
import { UserProfile } from "./UserProfile";
import { League } from "./League";
import { CupEvent } from "./CupEvent";
import { AccountCred } from "./AccountCred";
import type { Env } from "./GolfRound";

export { GolfRound, CourseCatalog, UserProfile, League, CupEvent, AccountCred };

const BUILD = "v113";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode(len = 4): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const GOLF_API = "https://api.golfcourseapi.com/v1";
const GOLFCORE = "https://api.golfcore.org/v1"; // scorecards + accurate stroke index (no geometry)
const catalog = (env: Env) => env.COURSE_CATALOG.get(env.COURSE_CATALOG.idFromName("global"));

// ---- Username + password auth (login layer on top of the passwordless id/secret accounts) ----
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const normUser = (u: any) => String(u || "").trim().toLowerCase();
const credStub = (env: Env, uname: string) => env.ACCOUNT_CRED.get(env.ACCOUNT_CRED.idFromName("cred:" + uname));
function toHex(buf: ArrayBuffer): string { return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
function fromHex(hex: string): Uint8Array { const a = new Uint8Array(hex.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a; }
async function pbkdf2(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return toHex(bits);
}
async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await pbkdf2(password, salt), salt: toHex(salt) };
}
async function verifyPassword(password: string, hash: string, saltHex: string): Promise<boolean> {
  const h = await pbkdf2(password, fromHex(saltHex));
  if (h.length !== hash.length) return false;
  let diff = 0; for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0; // constant-time-ish compare
}

// Validate an account by its id + secret headers; returns the DO stub or null.
async function accountAuth(env: Env, request: Request): Promise<{ id: string; secret: string; stub: DurableObjectStub } | null> {
  const id = request.headers.get("x-account-id") || "", secret = request.headers.get("x-account-secret") || "";
  if (!id || !secret) return null;
  const stub = env.USER_PROFILE.get(env.USER_PROFILE.idFromName(id));
  try { const r = await stub.fetch("https://do/auth", { headers: { "x-secret": secret } }); if (!r.ok) return null; } catch { return null; }
  return { id, secret, stub };
}

// Produce (and cache) a hole map for a coordinate. Shared by the public route and the admin probe.
async function holeMapFor(lat: number, lng: number, wantHoles: number): Promise<Response> {
  return cachedJson(`https://cache/holemap/v16/${lat.toFixed(4)},${lng.toFixed(4)},${wantHoles}`, 7 * 86400, async () => {
    // A course fits inside ~2.5km of its center, so we ask only for that plus nearby water.
    const qFull = `[out:json][timeout:20];(way["golf"](around:2500,${lat},${lng});relation["golf"](around:2500,${lat},${lng});way["leisure"="golf_course"](around:2500,${lat},${lng});relation["leisure"="golf_course"](around:2500,${lat},${lng});way["natural"="water"](around:2000,${lat},${lng});relation["natural"="water"](around:2000,${lat},${lng}););out geom;`;
    const servers = [
      "https://overpass.private.coffee/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://overpass-api.de/api/interpreter",
    ];
    const fetchOne = (ep: string, q: string) => {
      const host = ep.split("/")[2];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 18000);
      return fetch(ep, {
        method: "POST", signal: ctrl.signal,
        headers: { "content-type": "application/x-www-form-urlencoded", "accept": "application/json", "user-agent": GS_UA },
        body: "data=" + encodeURIComponent(q),
      }).then(async (r) => {
        if (!r.ok) throw new Error("overpass-" + r.status + "@" + host);
        return await r.json();
      }).finally(() => clearTimeout(timer));
    };
    const errs: string[] = [];

    // 1) Overpass (fast when the volunteer mirrors are healthy).
    try {
      const data: any = await Promise.any(servers.map((ep) => fetchOne(ep, qFull)));
      const result: any = parseHoleMap(data, lat, lng, wantHoles);
      if (result && result.available) return Response.json(result);
      errs.push("overpass-empty");
    } catch { errs.push("overpass-failed"); }

    // 2) Fallback: OpenStreetMap's own canonical API. The volunteer Overpass mirrors go up and
    // down, but api.openstreetmap.org is the authoritative server behind the editable map and is
    // far more reliable. It returns raw nodes/ways, which osmMapElements stitches back into the
    // same shape the parser expects. We try a generous box, then a tighter one if that's rejected.
    for (const half of [1700, 1100]) {
      const els = await osmMapElements(lat, lng, half).catch(() => null);
      if (els && els.length) {
        const result: any = parseHoleMap({ elements: els }, lat, lng, wantHoles);
        if (result && result.available) return Response.json(result);
      }
    }
    errs.push("osm-api-empty");
    return new Response(JSON.stringify({ available: false, error: errs.join("; ") }), { status: 503, headers: { "content-type": "application/json" } });
  });
}

const GS_UA = "GreenSideStrokes/1.0 (+https://greensidestrokes.com; golf hole maps)";
const OVERPASS_EPS = ["https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass-api.de/api/interpreter"];

// Fetch raw OSM data for a box around (lat,lng) from the canonical OSM API and reshape it into the
// element form parseHoleMap expects (ways/relations with inline {lat,lon} geometry). This is the
// reliable fallback when the volunteer Overpass mirrors are down. `half` is the half-box in meters.
async function osmMapElements(lat: number, lng: number, half: number): Promise<any[] | null> {
  const dLat = half / 111320;
  const dLng = half / (111320 * Math.cos((lat * Math.PI) / 180));
  const bbox = `${(lng - dLng).toFixed(5)},${(lat - dLat).toFixed(5)},${(lng + dLng).toFixed(5)},${(lat + dLat).toFixed(5)}`;
  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${bbox}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let data: any;
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": GS_UA } });
    if (!r.ok) return null; // 400 = box too dense/large; caller retries smaller
    data = await r.json();
  } catch { return null; } finally { clearTimeout(timer); }
  const els = (data && data.elements) || [];
  const nodes = new Map<number, { lat: number; lon: number }>();
  for (const e of els) if (e.type === "node") nodes.set(e.id, { lat: e.lat, lon: e.lon });
  const wayGeom = new Map<number, { lat: number; lon: number }[]>();
  const out: any[] = [];
  for (const e of els) {
    if (e.type === "way" && Array.isArray(e.nodes)) {
      const geometry = e.nodes.map((id: number) => nodes.get(id)).filter(Boolean) as { lat: number; lon: number }[];
      wayGeom.set(e.id, geometry);
      out.push({ type: "way", id: e.id, geometry, tags: e.tags || {} });
    }
  }
  for (const e of els) {
    if (e.type === "relation" && Array.isArray(e.members)) {
      const members = e.members.map((m: any) => ({ role: m.role, type: m.type, geometry: m.type === "way" ? wayGeom.get(m.ref) || [] : [] }));
      out.push({ type: "relation", id: e.id, members, tags: e.tags || {} });
    }
  }
  return out;
}
async function overpassJson(q: string): Promise<any | null> {
  for (const ep of OVERPASS_EPS) {
    try {
      const r = await fetch(ep, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "accept": "application/json", "user-agent": GS_UA }, body: "data=" + encodeURIComponent(q) });
      if (r.ok) return await r.json();
    } catch { /* next mirror */ }
  }
  return null;
}

// Fetch a hole map and, on a fresh success, bank it permanently in the global catalog so the
// course is instant and reliable from then on and never re-fetched. Never overwrites a hand-drawn
// map (those are saved under the course name; auto-built maps are saved under "osm").
async function holeMapPersist(env: any, lat: number, lng: number, wantHoles: number): Promise<Response> {
  const ck = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const resp = await holeMapFor(lat, lng, wantHoles);
  try {
    if (resp.ok) {
      const map: any = await resp.clone().json();
      if (map && map.available) {
        const existing: any = await catalog(env).fetch(`https://do/getmap?key=${encodeURIComponent(ck)}`).then((r) => r.json()).catch(() => null);
        const handMapped = existing && existing.found && existing.name && existing.name !== "osm";
        if (!handMapped) {
          await catalog(env).fetch(`https://do/savemap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ coordkey: ck, name: "osm", map }) }).catch(() => {});
        }
      }
    }
  } catch { /* serve what we have */ }
  return resp;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resolve a course to coordinates, returning debug on failure so we can see what OSM returned.
// Polite to Nominatim (~1 req/sec), keeps only golf_course results, and never caches a miss.
async function geocodeWithDebug(env: any, name: string, where: string): Promise<{ coords: { lat: number; lng: number } | null; debug: any }> {
  if (!name) return { coords: null, debug: { reason: "no-name" } };
  // Private clubs that public geocoders can't resolve by name. Matched on a distinctive
  // lowercased phrase in the course name; checked before any network lookup.
  const KNOWN: { needle: string; lat: number; lng: number }[] = [
    { needle: "merrill hills", lat: 42.9838, lng: -88.2923 },
  ];
  const nlow = name.toLowerCase();
  for (const k of KNOWN) {
    if (nlow.includes(k.needle)) return { coords: { lat: k.lat, lng: k.lng }, debug: { hit: "known:" + k.needle } };
  }
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

// Convert a Course Mapper export (tee + green front/center/back points per hole) into the same
// hole-map shape the round renders from OSM. Lets a hand-mapped course serve a real map/yardages
// with zero dependence on Overpass. Pure function — no network, no env.
function mapperToHoleMap(exp: any): any {
  const out: any[] = [];
  const holesIn = Array.isArray(exp && exp.holes) ? exp.holes : [];
  const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (const h of holesIn) {
    const g = h.green || {};
    const front = g.front || null, back = g.back || null;
    let center = g.center || null;
    if (!center && front && back) center = mid(front, back);
    const c = center || front || back;
    if (!c) continue; // nothing mapped for this hole — skip it
    const tee = h.tee || null;
    const mPerLat = 110540, mPerLng = 111320 * Math.cos((c[0] * Math.PI) / 180);
    const toLL = (nm: number, em: number) => [c[0] + nm / mPerLat, c[1] + em / mPerLng];
    const ydsOf = (a: number[], b: number[]) => { const n = (b[0] - a[0]) * mPerLat, e = (b[1] - a[1]) * mPerLng; return Math.round(Math.hypot(n, e) * 1.09361); };
    let ring: number[][];
    if (front && back) {
      const axN = (back[0] - front[0]) * mPerLat, axE = (back[1] - front[1]) * mPerLng;
      const L = Math.hypot(axN, axE) || 12;
      const pN = -axE / L, pE = axN / L, hw = Math.max(6, Math.min(14, L * 0.28));
      ring = [front, toLL(pN * hw, pE * hw), back, toLL(-pN * hw, -pE * hw)];
    } else {
      const r = 11; ring = [toLL(r, 0), toLL(0, r), toLL(-r, 0), toLL(0, -r)];
    }
    const teePt = tee || front || c;
    out.push({
      ref: Number(h.hole), par: h.par != null ? Number(h.par) : null,
      line: [teePt, c], tee: teePt, green: ring, greenC: c,
      fairways: [], rough: [], tees: [], hazards: [],
      teeToGreenYds: tee ? ydsOf(tee, c) : (Number(h.yards) || 0),
    });
  }
  return { available: out.length > 0, holes: out, counts: { found: out.length, greens: out.length, bunkers: 0, water: 0 }, source: "mapped" };
}

// Club + course into one label. Collapses the common case where a course's club
// and course names are identical ("Westmoor Country Club — Westmoor Country Club"),
// or one already contains the other, while keeping genuinely distinct pairs
// ("Marquette Gc — Greywalls").
function courseName(club: any, course: any): string {
  const a = String(club || "").trim();
  const b = String(course || "").trim();
  if (!a) return b || "Course";
  if (!b) return a;
  const na = a.toLowerCase().replace(/\s+/g, " ");
  const nb = b.toLowerCase().replace(/\s+/g, " ");
  if (na === nb) return a;
  if (nb.includes(na)) return b; // course label already carries the club name
  if (na.includes(nb)) return a; // club label already carries the course name
  return `${a} — ${b}`;
}

function simplifyCourse(c: any) {
  const loc = c.location || {};
  const name = courseName(c.club_name, c.course_name);
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
    name: courseName(course.club_name, course.course_name),
    where: [loc.city, loc.state].filter(Boolean).join(", "),
    lat: loc.latitude ?? null, lng: loc.longitude ?? null,
    holes, tees: teeData, defaultTee: def ? def.name : "", siEstimated,
  };
}

// Map a GolfCore course detail into the GSS course shape (same as courseToHoles). GolfCore gives the
// stroke index from its own database, so SI is authoritative here — no OCR, no estimate. No geometry.
function gcToHoles(gc: any) {
  const where = [gc.city, gc.region].filter(Boolean).join(", ");
  const base = { name: gc.name || "Course", where, lat: gc.lat ?? null, lng: gc.lng ?? null, holes: [] as any[], tees: [] as any[], defaultTee: "", siEstimated: false, rating: null as number | null, slope: null as number | null, source: "golfcore" };
  const layout = Array.isArray(gc.layouts) && gc.layouts.length ? gc.layouts[0] : null;
  if (!layout) return base;
  // Reference par + stroke index per hole position (tee-agnostic, from GolfCore's DB).
  const ref: Record<number, { par: number; si: number }> = {};
  (layout.holes || []).forEach((h: any) => { const pos = Number(h.position); if (Number.isFinite(pos)) ref[pos] = { par: Number(h.par) || 0, si: Number(h.stroke_index) || 0 }; });
  const mkHoles = (t: any) => (Array.isArray(t.holes) ? t.holes : []).map((h: any) => { const pos = Number(h.position) || 0; const r = ref[pos] || ({} as any); return { num: pos, par: Number(h.par) || r.par || 0, yards: Number(h.yards) || 0, si: Number(h.stroke_index) || r.si || 0 }; });
  const teeData = (Array.isArray(layout.tees) ? layout.tees : []).map((t: any) => ({ name: String(t.name || "Tee"), total: Number(t.yards) || 0, rating: Number(t.rating) || null, slope: Number(t.slope) || null, gender: t.gender || null, holes: mkHoles(t) })).filter((t: any) => t.holes.length);
  const sorted = [...teeData].sort((a, b) => b.total - a.total);
  const def = sorted[Math.floor(sorted.length / 2)] || teeData[0] || null;
  let holes = def ? def.holes.map((h: any) => ({ num: h.num, par: h.par || (ref[h.num]?.par) || 0, yards: h.yards, si: h.si || (ref[h.num]?.si) || 0 })) : [];
  if (!holes.length && Object.keys(ref).length) holes = Object.keys(ref).map(Number).sort((a, b) => a - b).map((pos) => ({ num: pos, par: ref[pos].par, yards: 0, si: ref[pos].si }));
  return { ...base, holes, tees: teeData, defaultTee: def ? def.name : "", rating: def?.rating ?? null, slope: def?.slope ?? null };
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

// Reconcile several independent reads of the stroke-index row into one correct 1..n permutation:
// per-column majority vote, then repair to a valid permutation, honoring the odd-front/even-back
// convention when the reads clearly follow it. This is what makes the S.I. row read reliably — one
// read of the whole card treats it as an afterthought, so we read it on its own and cross-check.
function reconcileSI(cands: number[][], n: number): number[] | null {
  const C = cands.filter((a) => Array.isArray(a) && a.length === n);
  if (!C.length) return null;
  const voted = new Array(n).fill(0), conf = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const counts = new Map<number, number>();
    for (const a of C) { const v = a[i]; if (v >= 1 && v <= n) counts.set(v, (counts.get(v) || 0) + 1); }
    let bv = 0, bc = 0;
    for (const [v, c] of counts) { if (c > bc || (c === bc && v < bv)) { bv = v; bc = c; } }
    voted[i] = bv; conf[i] = bc;
  }
  let parityFront = 0;
  if (n === 18) {
    let oF = 0, eF = 0, oB = 0, eB = 0;
    for (let i = 0; i < 9; i++) if (voted[i]) (voted[i] % 2 ? oF++ : eF++);
    for (let i = 9; i < 18; i++) if (voted[i]) (voted[i] % 2 ? oB++ : eB++);
    if (oF >= 7 && eB >= 7) parityFront = 1; else if (eF >= 7 && oB >= 7) parityFront = -1;
  }
  const wantOdd = (i: number) => { if (!parityFront) return null; const front = i < 9; return parityFront === 1 ? front : !front; };
  const okParity = (i: number, v: number) => { const w = wantOdd(i); return w === null || w === (v % 2 === 1); };
  const assigned = new Array(n).fill(0); const taken = new Set<number>();
  const order = [...Array(n).keys()].sort((a, b) => conf[b] - conf[a]);
  for (const i of order) { const v = voted[i]; if (v >= 1 && v <= n && !taken.has(v) && okParity(i, v)) { assigned[i] = v; taken.add(v); } }
  const open: number[] = []; for (let i = 0; i < n; i++) if (!assigned[i]) open.push(i);
  const missing: number[] = []; for (let v = 1; v <= n; v++) if (!taken.has(v)) missing.push(v);
  for (const i of open) { let idx = missing.findIndex((v) => okParity(i, v)); if (idx < 0) idx = 0; assigned[i] = missing.splice(idx, 1)[0] || 0; }
  const set = new Set(assigned);
  if (set.size !== n || assigned.some((v) => v < 1 || v > n)) return null;
  return assigned;
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

// ---- Number unlabeled OSM holes from the scorecard (no guessing) ----
// Signals: physical routing (a hole's green sits beside the next hole's tee) gives the ORDER; the
// scorecard's par sequence + yardages pin that order to actual numbers. Only forced assignments are
// committed; anything ambiguous is left null (for a tap later). Straight-line tee→green (what OSM
// gives) is <= the card's playing yardage, so the length window is asymmetric.
function hmLenOk(len: number, yards: number, par: number): boolean {
  const lo = par <= 3 ? 30 : par === 4 ? 70 : 90, hi = 35;
  return len >= yards - lo && len <= yards + hi;
}
function hmFits(h: any, c: any): boolean { return (h.par == null || h.par === c.par) && hmLenOk(h.len, c.yards, c.par); }
function hmRouteChains(osm: any[], dist: (a: number[], b: number[]) => number, thresh: number): number[][] {
  const n = osm.length, next = new Array(n).fill(-1), prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!osm[i].greenC) continue;
    let bj = -1, bd = Infinity;
    for (let j = 0; j < n; j++) { if (j === i || !osm[j].teeC) continue; const d = dist(osm[i].greenC, osm[j].teeC); if (d < bd) { bd = d; bj = j; } }
    if (bj >= 0 && bd <= thresh) next[i] = bj;
  }
  for (let i = 0; i < n; i++) if (next[i] >= 0) prev[next[i]] = i;
  const chains: number[][] = [], used = new Set<number>();
  for (let s = 0; s < n; s++) {
    if (prev[s] !== -1 || used.has(s)) continue;
    const chain: number[] = []; let c = s, guard = 0;
    while (c !== -1 && !used.has(c) && guard++ < n + 1) { chain.push(c); used.add(c); c = next[c]; }
    chains.push(chain);
  }
  for (let i = 0; i < n; i++) if (!used.has(i)) { chains.push([i]); used.add(i); }
  return chains;
}
function matchHoleNumbers(osm: any[], card: any[], dist: (a: number[], b: number[]) => number, thresh = 80): { refs: (number | null)[]; newlyNumbered: number } {
  const refs: (number | null)[] = osm.map((h) => (Number.isFinite(h.ref) && h.ref >= 1 ? h.ref : null));
  const taken = new Set<number>(refs.filter((r): r is number => r != null));
  for (const chain of hmRouteChains(osm, dist, thresh)) {
    const offsets: number[] = [];
    for (let off = 0; off + chain.length <= card.length; off++) {
      let good = true;
      for (let k = 0; k < chain.length; k++) {
        const slot = card[off + k], known = refs[chain[k]];
        if (known != null) { if (slot.num !== known) { good = false; break; } }
        else if (taken.has(slot.num) || !hmFits(osm[chain[k]], slot)) { good = false; break; }
      }
      if (good) offsets.push(off);
    }
    if (offsets.length === 1) { const off = offsets[0]; chain.forEach((i, k) => { if (refs[i] == null) { refs[i] = card[off + k].num; taken.add(card[off + k].num); } }); }
  }
  let progress = true;
  while (progress) {
    progress = false;
    const openIdx = refs.map((r, i) => (r == null ? i : -1)).filter((i) => i >= 0);
    const candsOf = (i: number) => card.filter((c) => !taken.has(c.num) && hmFits(osm[i], c)).map((c) => c.num);
    for (const c of card) { if (taken.has(c.num)) continue; const hs = openIdx.filter((i) => refs[i] == null && candsOf(i).includes(c.num)); if (hs.length === 1) { refs[hs[0]] = c.num; taken.add(c.num); progress = true; } }
    if (progress) continue;
    for (const i of openIdx) { if (refs[i] != null) continue; const cs = candsOf(i); if (cs.length === 1) { refs[i] = cs[0]; taken.add(cs[0]); progress = true; } }
  }
  return { refs, newlyNumbered: refs.filter((r, i) => r != null && osm[i].ref == null).length };
}
// Apply the scorecard numbering to an OSM hole map in place. Returns how many holes were newly numbered.
function numberHolesFromCard(map: any, card: any[]): number {
  if (!map || !Array.isArray(map.holes) || !Array.isArray(card)) return 0;
  const cardClean = card.filter((c: any) => Number.isFinite(c.num) && Number.isFinite(c.par) && Number.isFinite(c.yards) && c.yards > 0).map((c: any) => ({ num: c.num, par: c.par, yards: c.yards }));
  if (cardClean.length < 3) return 0;
  const osm = map.holes.map((h: any) => ({ teeC: Array.isArray(h.tee) ? h.tee : null, greenC: Array.isArray(h.greenC) ? h.greenC : null, par: Number.isFinite(h.par) ? h.par : null, len: Number.isFinite(h.teeToGreenYds) ? h.teeToGreenYds : 0, ref: Number.isFinite(h.ref) ? h.ref : null }));
  const { refs, newlyNumbered } = matchHoleNumbers(osm, cardClean, (a, b) => hmYds(hmHav(a, b)), 80);
  if (newlyNumbered > 0) map.holes.forEach((h: any, i: number) => { if (!Number.isFinite(h.ref) && refs[i] != null) h.ref = refs[i]; });
  return newlyNumbered;
}
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
  // Water: golf-tagged hazards AND plain lakes/ponds (often mapped only as natural=water, with no
  // golf tag), from both ways and relation outers (large ponds are frequently multipolygons).
  const gatherWater = () => {
    const out: any[] = [];
    els.forEach((e: any) => {
      const t = e.tags || {};
      if (!(t.golf === "water_hazard" || t.golf === "lateral_water_hazard" || t.natural === "water" || t.water || t.landuse === "reservoir")) return;
      const golf = t.golf === "water_hazard" || t.golf === "lateral_water_hazard";
      if (e.type === "way" && Array.isArray(e.geometry) && e.geometry.length >= 4) out.push({ poly: hmRing(e.geometry), c: hmCentroid(e.geometry), kind: "water", golf });
      else if (e.type === "relation" && Array.isArray(e.members)) e.members.forEach((m: any) => {
        if ((m.role === "outer" || !m.role) && Array.isArray(m.geometry) && m.geometry.length >= 4) out.push({ poly: hmRing(m.geometry), c: hmCentroid(m.geometry), kind: "water", golf });
      });
    });
    return out;
  };
  let water = gatherWater();

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
    const chosenSet = new Set<any>(chosen);
    let rescued = false;
    // Recover holes of THIS course that the selection missed — whether they were left out by a
    // too-tight outline (orphans) or drawn as a separate OSM piece. We chain outward: a candidate
    // is pulled in if it sits within ~550m of a hole we already have, up to the expected count. A
    // genuinely different course nearby (e.g. Spyglass next to Pebble) is >550m away and never chains.
    if (wantHoles && chosen.length < wantHoles) {
      const candidates = holeWays.filter((w: any) => !chosenSet.has(w));
      const near = (w: any) => chosen.some((cw: any) =>
        hmHav(teeOf(w), teeOf(cw)) < 550 || hmHav(teeOf(w), endOf(cw)) < 550 ||
        hmHav(endOf(w), teeOf(cw)) < 550 || hmHav(endOf(w), endOf(cw)) < 550);
      let added = true;
      while (added && chosen.length < wantHoles) {
        added = false;
        for (const w of candidates) {
          if (chosenSet.has(w)) continue;
          if (chosen.length >= wantHoles) break;
          if (near(w)) { chosen.push(w); chosenSet.add(w); added = true; rescued = true; }
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
    water = water.filter((x: any) => keepX(x));
  } else {
    // No course outline to filter against — keep only explicitly golf-tagged water so we don't
    // render every neighborhood pond that happened to be within range.
    water = water.filter((x: any) => x.golf);
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

      // GolfCore — primary online source (big coverage + accurate stroke index). Cached 1 day.
      let gc: any[] = [];
      if (env.GOLFCORE_KEY) {
        try {
          const r = await cachedJson(`https://cache/gcsearch?q=${encodeURIComponent(q.toLowerCase())}`, 86400, async () => {
            const res = await fetch(`${GOLFCORE}/courses?q=${encodeURIComponent(q)}&limit=10`, { headers: { Authorization: `Bearer ${env.GOLFCORE_KEY}` } });
            if (!res.ok) return Response.json({ courses: [] });
            const d: any = await res.json();
            return Response.json({ courses: (d.courses || []).slice(0, 10).map((c: any) => ({ id: "gc_" + c.slug, name: c.name, where: [c.city, c.region].filter(Boolean).join(", "), lat: c.lat ?? null, lng: c.lng ?? null, saved: false })) });
          });
          gc = ((await r.json()) as any).courses || [];
        } catch { /* */ }
      }

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

      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const seen = new Set(saved.map((c) => norm(c.name)));
      const merged = [...saved];
      for (const c of [...gc, ...online]) { const k = norm(c.name); if (!seen.has(k)) { seen.add(k); merged.push(c); } } // GolfCore first, then fallback source
      return Response.json({ courses: merged.slice(0, 12), unconfigured: !env.GOLF_API_KEY && !env.GOLFCORE_KEY && saved.length === 0 });
    }

    // ---- Nearest saved course to a GPS fix (Quick round) ----
    if (path === "/api/courses/near" && request.method === "GET") {
      const lat = url.searchParams.get("lat") || "", lng = url.searchParams.get("lng") || "";
      const r = await catalog(env).fetch(`https://do/near?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`);
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }

    // ---- Nearby saved courses, sorted by distance (Start tab suggestions) ----
    if (path === "/api/courses/nearby" && request.method === "GET") {
      const lat = url.searchParams.get("lat") || "", lng = url.searchParams.get("lng") || "", n = url.searchParams.get("n") || "6";
      const r = await catalog(env).fetch(`https://do/nearby?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&n=${encodeURIComponent(n)}`);
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }

    // ---- Course detail ----
    const cm = path.match(/^\/api\/courses\/([A-Za-z0-9_-]+)$/);
    if (cm && request.method === "GET") {
      const id = cm[1];
      if (id.startsWith("gc_")) {
        // GolfCore scorecard course. Slug is everything after the gc_ prefix.
        const slug = id.slice(3);
        if (!env.GOLFCORE_KEY) return new Response("Not configured", { status: 503 });
        return cachedJson(`https://cache/gc/v1/${slug}`, 31536000, async () => {
          let status = 0;
          for (let attempt = 0; attempt < 3; attempt++) {
            const r = await fetch(`${GOLFCORE}/courses/${encodeURIComponent(slug)}`, { headers: { Authorization: `Bearer ${env.GOLFCORE_KEY}` } });
            if (r.ok) {
              const d: any = await r.json();
              const course = gcToHoles(d.course || d);
              // Bank it into the catalog so it's served from there forever after — no more API calls.
              if (Array.isArray(course.holes) && course.holes.length) {
                ctx.waitUntil(catalog(env).fetch("https://do/upsert", { method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name: course.name, where: course.where || "", lat: course.lat ?? null, lng: course.lng ?? null, holes: course.holes, tees: course.tees || null, defaultTee: course.defaultTee || null }) }).catch(() => {}));
              }
              return Response.json(course);
            }
            status = r.status;
            if (r.status !== 429 && r.status < 500) break; // 404/400 is a real miss — don't retry
            await sleep(400 * (attempt + 1)); // transient: back off and retry
          }
          return Response.json({ error: "upstream", status }, { status: status || 502 });
        });
      }
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
        return cachedJson(`https://cache/course/v3/${id}`, 31536000, async () => {
          let status = 0;
          for (let attempt = 0; attempt < 3; attempt++) {
            const r = await fetch(`${GOLF_API}/courses/${id}`, { headers: { Authorization: `Key ${env.GOLF_API_KEY}` } });
            if (r.ok) {
              const d: any = await r.json();
              const course = courseToHoles(d.course);
              // Bank it into the catalog so it's served from there forever after — no more API calls
              // for this course, for anyone. This is what keeps the daily API quota from blocking people.
              if (Array.isArray(course.holes) && course.holes.length) {
                ctx.waitUntil(catalog(env).fetch("https://do/upsert", { method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name: course.name, where: course.where || "", lat: course.lat ?? null, lng: course.lng ?? null, holes: course.holes, tees: course.tees || null, defaultTee: course.defaultTee || null }) }).catch(() => {}));
              }
              return Response.json(course);
            }
            status = r.status;
            if (r.status !== 429 && r.status < 500) break; // 404/400 is a real miss — don't retry
            await sleep(400 * (attempt + 1)); // transient (rate-limit blip / 5xx): back off and retry
          }
          return Response.json({ error: "upstream", status }, { status: status || 502 });
        });
      }
      return new Response("Not found", { status: 404 });
    }

    // ---- Scan a scorecard photo with Cloudflare AI ----
    if (path === "/api/courses/scan" && request.method === "POST") {
      ctx.waitUntil(catalog(env).fetch("https://do/bump", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "scan" }) }).catch(() => {}));
      try {
        const wantNines = !!url.searchParams.get("nines"); // ?nines=3 → read a 27-hole / three-nines card
        const want9 = url.searchParams.get("holes") === "9"; // ?holes=9 → a nine-hole course
        const HOLES = want9 ? 9 : 18;
        const buf = await request.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const image = [...bytes]; // byte array for the small vision model
        let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const dataUrl = `data:image/jpeg;base64,${btoa(bin)}`; // data URL for Llama 4 Scout
        const prompt =
          'You read golf scorecards. Look at the image and return STRICT JSON only — no prose, no code fences — in exactly this shape: ' +
          '{"name":"<course name>","par":[18 numbers],"handicap":[18 numbers],"tees":[{"name":"<tee or color name>","yards":[18 numbers]}]}. ' +
          '"par" = the Par for holes 1 to 18 in order. "handicap" = the stroke-index / handicap row, usually labelled HANDICAP, HCP, HDCP, S.I., SI, INDEX or STROKE — a ranking of hole difficulty where the numbers 1 to 18 EACH APPEAR EXACTLY ONCE across the 18 holes. Read THAT row for holes 1 to 18 in order; do not copy par or yardage into it, and if men and women handicap rows both exist use the men\'s (first) row. Return 18 distinct numbers 1 to 18. ' +
          '"tees" = ONE entry for EACH tee box / colored row on the card (for example Black, Blue, White, Gold, Red, Orange, Teal); "yards" = that row\'s yardage for holes 1 to 18 in order. ' +
          'Read left to right, front nine then back nine. Ignore the OUT, IN and TOTAL subtotal columns — give only the 18 real hole numbers. If a value is unreadable use 0. Return only the JSON.';
        const prompt9 =
          'You read golf scorecards. This card is a NINE-hole course — holes 1 to 9 only. Return STRICT JSON only — no prose, no code fences — in exactly this shape: ' +
          '{"name":"<course name>","par":[9 numbers],"handicap":[9 numbers],"tees":[{"name":"<tee or color name>","yards":[9 numbers]}]}. ' +
          '"par" = the Par for holes 1 to 9 in order. "handicap" = the stroke-index / handicap rank for holes 1 to 9 in order. ' +
          '"tees" = ONE entry for EACH tee box / colored row, each with 9 yardages for holes 1 to 9. There may be SEVERAL yardage rows stacked beneath each other (one per tee) even if only the first is labelled "YARDS" or "YARDAGE" — return EACH full row as its own tee entry, in top-to-bottom order. SKIP any row that is blank or has only one or two numbers. ' +
          'Do NOT invent a back nine or holes 10 to 18 — this course has only 9 holes. Ignore the OUT and TOTAL subtotal columns. If a value is unreadable use 0. Return only the JSON.';
        const ninePrompt =
          'You read golf scorecards. This card is a 27-hole course made of SEPARATE nine-hole courses, each with its OWN name (for example "The Callow", "The Meath", "The Birr"), its own Par row (9 values), its own Handicap / stroke-index row (values 1 to 9), and one or more tee rows (e.g. Black, Blue, White, Red) each with 9 yardages. ' +
          'Return STRICT JSON only — no prose, no code fences — in exactly this shape: {"nines":[{"name":"<nine name>","par":[9 numbers],"handicap":[9 numbers],"tees":[{"name":"<tee>","yards":[9 numbers]}]}]}. ' +
          'Include one object per nine, in the order they appear. Each "par", "handicap" and "yards" array has exactly 9 values for holes 1 to 9 of THAT nine. Ignore OUT / IN / TOTAL columns. If a value is unreadable use 0. Return only the JSON.';

        const numArr = (a: any): number[] => (Array.isArray(a) ? a.map((v) => Number(v) || 0) : []);
        const flat = (one: any, f: any, b: any): number[] => {
          if (Array.isArray(one) && one.length) return numArr(one);
          return [...numArr(f), ...numArr(b)];
        };
        const strip = (arr: number[], isTotal: (v: number) => boolean): number[] => arr.filter((v) => !isTotal(v)).slice(0, HOLES);
        const clampPar = (p: number) => (p >= 3 && p <= 6 ? p : 4);

        // Build per-nine data from a {nines:[...]} reply for a 27-hole card.
        const buildNines = (parsed: any) => {
          const ninesIn = Array.isArray(parsed?.nines) ? parsed.nines : [];
          if (!ninesIn.length) return null;
          let ninesRead = true; // every nine's stroke index read as a clean 1..9 (not estimated)
          const nn = ninesIn.slice(0, 4).map((nine: any, idx: number) => {
            const par = numArr(nine.par).filter((v) => v >= 3 && v <= 6).slice(0, 9);
            const hcp = numArr(nine.handicap).filter((v) => v >= 1 && v <= 9).slice(0, 9);
            const teesIn = Array.isArray(nine.tees) ? nine.tees : [];
            const tees = teesIn.map((t: any) => ({ name: String(t.name || "Tee").trim() || "Tee", yards: numArr(t.yards).filter((v) => v < 800).slice(0, 9).map((y) => Math.max(0, Math.min(899, y))) })).filter((t: any) => t.yards.some((y: number) => y > 0));
            let si = Array.from({ length: 9 }, () => 0);
            const hcpClean = hcp.length === 9 && new Set(hcp).size === 9;
            if (!hcpClean) ninesRead = false;
            if (hcpClean) si = hcp.slice();
            else if (tees.length) { const longest = [...tees].sort((a, b) => b.yards.reduce((s: number, y: number) => s + y, 0) - a.yards.reduce((s: number, y: number) => s + y, 0))[0]; longest.yards.map((y: number, i: number) => ({ y, i })).sort((a, b) => b.y - a.y).forEach((o, r) => (si[o.i] = r + 1)); }
            else si = si.map((_, i) => i + 1);
            return { name: String(nine.name || `Nine ${idx + 1}`).trim() || `Nine ${idx + 1}`, par: Array.from({ length: 9 }, (_, i) => clampPar(par[i])), si, tees };
          }).filter((n: any) => n.tees.length || n.par.length);
          if (!nn.length) return null;
          const cells = nn.reduce((s: number, n: any) => s + n.tees.reduce((a: number, t: any) => a + t.yards.filter((y: number) => y > 0).length, 0), 0);
          return { score: 5000 + cells + (ninesRead ? 3000 : 0), siOk: ninesRead, payload: { multiNine: true, name: typeof parsed?.name === "string" ? parsed.name : "", nines: nn } };
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
          // Drop partial/stray rows (e.g. a lone "124" in an unfinished row) once we have a real tee.
          const filledOf = (t: any) => t.holes.filter((h: any) => h.yards > 0).length;
          const maxFilled = Math.max(0, ...teeData.map(filledOf));
          if (maxFilled >= Math.ceil(n / 2)) teeData = teeData.filter((t) => filledOf(t) >= Math.ceil(n / 2) || t.total === 0);
          // Auto-name unlabeled or duplicate tees (cards often label only the first row) longest→shortest.
          const blankName = (nm: string) => !nm || /^(tee|tees|scanned|yards?|yardage)$/i.test(nm);
          const nm = teeData.map((t) => t.name);
          if (teeData.length > 1 && (nm.some(blankName) || new Set(nm).size !== nm.length)) {
            const order = [...teeData].sort((a, b) => b.total - a.total);
            order.forEach((t, i) => { t.name = `Tee ${i + 1}`; });
          }

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
          const score = teesWithYards * 1000 + filledCells + (hUnique ? 3000 : 0); // reward yardages, and a clean 1..N stroke index read off the card
          return { score, siOk: hUnique, payload: { name: typeof parsed.name === "string" ? parsed.name : "", holes: def.holes, tees: teeData, defaultTee: def.name, siEstimated } };
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
        const usePrompt = wantNines ? ninePrompt : want9 ? prompt9 : prompt;
        const useSchema = wantNines ? ninesSchema : schema;
        const useBuild = wantNines ? buildNines : build;
        const asText = (resp: any) => (typeof resp === "string" ? resp : resp ? JSON.stringify(resp) : "");
        // Runners take a prompt/schema so we can also use them for a focused stroke-index read.
        const runScout = async (p: string = usePrompt, schema: any = useSchema) => {
          const out: any = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
            messages: [{ role: "user", content: [{ type: "text", text: p }, { type: "image_url", image_url: { url: dataUrl } }] }],
            max_tokens: 2400, temperature: 0.1, guided_json: schema,
          });
          return asText(out?.response);
        };
        const runSmall = async (p: string = usePrompt) => {
          const out: any = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { image, prompt: p, max_tokens: 2200 });
          return asText(out?.response);
        };
        // Moondream 3.1 is an OCR/structured-output-specialised vision model — a strong second read.
        const runMoondream = async (p: string = usePrompt) => {
          const out: any = await env.AI.run("@cf/moondream/moondream3.1-9B-A2B", { task: "query", image: dataUrl, question: p, max_tokens: 2400, temperature: 0.1 });
          return asText(out?.answer);
        };

        // One solid full-card read gets par + yardages (those read reliably). SI is handled separately.
        let best: any = null;
        const early = wantNines ? 5000 : 2000;
        for (const run of [runScout, runMoondream]) {
          let text = ""; try { text = await run(); } catch { continue; }
          const r = useBuild(extractJson(text));
          if (r && (!best || r.score > best.score)) best = r;
          if (best && best.score >= early) break;
        }
        if (!best || best.score < early) {
          let text = ""; try { text = await runSmall(); } catch { /* */ }
          const r = useBuild(extractJson(text));
          if (r && (!best || r.score > best.score)) best = r;
        }
        if (!best || best.score === 0) return Response.json({ error: "unreadable" }, { status: 422 });

        // ---- Dedicated stroke-index pass (single/9-18-hole cards) ----
        // Read ONLY the handicap row a couple more times and reconcile all reads into one correct
        // 1..N permutation. This is the part a whole-card read gets wrong most often.
        if (!wantNines && best.payload?.holes?.length) {
          const nH = best.payload.holes.length;
          const siPrompt =
            `Look ONLY at the single row on this golf scorecard labelled Handicap, Hcp, HDCP, H.C.P, S.I., SI, Index or Stroke. ` +
            `Return STRICT JSON only: {"handicap":[${nH} numbers]} — the stroke-index rank for holes 1 to ${nH} in order, left to right. ` +
            `It is a difficulty ranking where the numbers 1 to ${nH} EACH APPEAR EXACTLY ONCE. Read each cell carefully, column by column. ` +
            `Ignore the Par row, every yardage row, the course name and the OUT / IN / TOTAL columns. Return only the JSON.`;
          const siSchema = { type: "object", properties: { handicap: { type: "array", items: { type: "number" } } }, required: ["handicap"] };
          const readHcp = async (runner: (p: string, s?: any) => Promise<string>) => {
            try { const j = extractJson(await runner(siPrompt, siSchema)); const a = numArr(j?.handicap).map((v) => Math.round(v)).slice(0, nH); return a.length === nH ? a : null; }
            catch { return null; }
          };
          const cands: number[][] = [];
          if (best.siOk) cands.push(best.payload.holes.map((h: any) => h.si || 0)); // trust the full-card SI only if it was already clean
          const f1 = await readHcp(runScout); if (f1) cands.push(f1);
          const f2 = await readHcp(runMoondream); if (f2) cands.push(f2);
          const si = reconcileSI(cands, nH);
          if (si) {
            best.payload.holes.forEach((h: any, i: number) => { h.si = si[i]; });
            (best.payload.tees || []).forEach((t: any) => (t.holes || []).forEach((h: any, i: number) => { if (i < nH) h.si = si[i]; }));
            best.payload.siEstimated = false;
          }
        }
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
      // Reset a user's password (the interim recovery path until self-serve email reset is wired up).
      if (path === "/api/admin/account-reset" && request.method === "POST") {
        const b = await request.json<any>().catch(() => ({}));
        const uname = normUser(b.username);
        const password = String(b.newPassword || "");
        if (!USERNAME_RE.test(uname) || password.length < 6) return Response.json({ ok: false, error: "Need a valid username and a 6+ character password." });
        const rec: any = await (await credStub(env, uname).fetch("https://do/record")).json();
        if (!rec.exists) return Response.json({ ok: false, error: "No account with that username." });
        const { hash, salt } = await hashPassword(password);
        const r = await credStub(env, uname).fetch("https://do/setpw", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admin: true, pwHash: hash, pwSalt: salt }) });
        const d: any = await r.json();
        return Response.json(d.ok ? { ok: true } : { ok: false, error: "Reset failed." });
      }
      if (path === "/api/admin/stats" && request.method === "GET") {
        const r = await catalog(env).fetch("https://do/stats");
        return new Response(await r.text(), { headers: { "content-type": "application/json" } });
      }
      if (path === "/api/admin/stats/reset" && request.method === "POST") {
        const r = await catalog(env).fetch("https://do/resetstats", { method: "POST" });
        return new Response(await r.text(), { headers: { "content-type": "application/json" } });
      }
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
          let holesMapped = 0, mapErr: string | null = null, foundRaw: number | null = null, greens: number | null = null, tees: number | null = null;
          if (lat != null && lng != null) {
            try {
              const hm: any = await (await holeMapFor(lat, lng, c.holesN || 18)).json();
              foundRaw = hm.counts ? hm.counts.found : null;
              if (hm.counts) { greens = hm.counts.greens; tees = hm.counts.tees; }
              if (hm.available) holesMapped = (hm.holes || []).length; else mapErr = hm.error || "not-mapped";
            } catch { mapErr = "probe-failed"; }
          }
          out.push({ id: c.id, name: c.name, where: c.where, source, holesExpected: c.holesN, holesMapped, foundRaw, greens, tees, mapErr, geo });
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
      let lat = cfg.lat, lng = cfg.lng;
      // A freshly scanned course has no coordinates. If the creator gave a city/state, geocode it
      // now so the round (and the saved course) gets a hole map automatically — no admin step.
      if ((lat == null || lng == null) && cfg.courseName && cfg.courseWhere) {
        try { const gg = await geocodeCourse(env, cfg.courseName, cfg.courseWhere); if (gg) { lat = gg.lat; lng = gg.lng; } } catch { /* non-fatal */ }
      }
      const stub = env.GOLF_ROUND.get(env.GOLF_ROUND.idFromName(code));
      await stub.fetch("https://do/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...cfg, code, adminToken, lat, lng }) });
      // Usage counters (fire-and-forget).
      const players = Array.isArray(cfg.players) ? cfg.players.length : 0;
      ctx.waitUntil(catalog(env).fetch("https://do/bump", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "round" }) }).catch(() => {}));
      if (players) ctx.waitUntil(catalog(env).fetch("https://do/bump", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "players", n: players }) }).catch(() => {}));
      if (cfg.courseName && Array.isArray(cfg.course) && cfg.course.length) {
        try {
          const catHoles = Array.isArray(cfg.catalogHoles) && cfg.catalogHoles.length ? cfg.catalogHoles : cfg.course;
          const catTees = Array.isArray(cfg.catalogTees) && cfg.catalogTees.length ? cfg.catalogTees : (cfg.tees || null);
          await catalog(env).fetch("https://do/upsert", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: cfg.courseName, where: cfg.courseWhere || "", lat: lat ?? null, lng: lng ?? null, holes: catHoles, tees: catTees, defaultTee: cfg.teeName || cfg.defaultTee || null }) });
        } catch { /* non-fatal */ }
      }
      // Register the round at its course so the clubhouse board can see it among the whole field.
      if (lat != null && lng != null) {
        const ck = `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
        ctx.waitUntil(catalog(env).fetch("https://do/field/add", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, coordkey: ck, name: cfg.name || cfg.courseName || "", outing: !!cfg.outing }) }).catch(() => {}));
      }
      // Pre-warm the hole map so it's cached before the group reaches the first tee. Fire-and-forget
      // with the same coords/hole-count the round screen will request, so it lands on the same cache key.
      if (lat != null && lng != null && Array.isArray(cfg.course) && cfg.course.length) {
        ctx.waitUntil(holeMapPersist(env, lat, lng, cfg.course.length).catch(() => {}));
      }
      return Response.json({ code, adminToken });
    }

    // ---- Clubhouse live field: every active round at a course (admin only) ----
    if (path === "/api/clubhouse" && request.method === "GET") {
      const key = request.headers.get("x-admin-key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response("Unauthorized", { status: 401 });
      const lat = parseFloat(url.searchParams.get("lat") || "");
      const lng = parseFloat(url.searchParams.get("lng") || "");
      if (!isFinite(lat) || !isFinite(lng)) return Response.json({ rounds: [] });
      const ck = `${lat.toFixed(4)},${lng.toFixed(4)}`;
      let list: any[] = [];
      try { list = ((await (await catalog(env).fetch(`https://do/field/list?key=${encodeURIComponent(ck)}`)).json()) as any).rounds || []; } catch { /* */ }
      // Fan out to each round's live state; drop any that no longer exist.
      const rounds = await Promise.all(list.map(async (r: any) => {
        try {
          const stub = env.GOLF_ROUND.get(env.GOLF_ROUND.idFromName(String(r.code)));
          const rr = await stub.fetch("https://do/");
          if (!rr.ok) return null;
          const st = await rr.json();
          let positions: Record<string, any> = {};
          try { positions = ((await (await stub.fetch("https://do/positions")).json()) as any).positions || {}; } catch { /* */ }
          return { code: r.code, name: r.name, outing: !!r.outing, state: st, positions };
        } catch { return null; }
      }));
      return Response.json({ rounds: rounds.filter(Boolean) });
    }

    // ---- Accounts: optional cross-device profile (passwordless id + secret) ----
    if (path === "/api/account/create" && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      const id = "a_" + genCode(14), secret = genCode(24);
      await env.USER_PROFILE.get(env.USER_PROFILE.idFromName(id)).fetch("https://do/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret, name: String(b.name || "").slice(0, 40) }) });
      return Response.json({ ok: true, accountId: id, secret, name: String(b.name || "").slice(0, 40) });
    }

    // Is a username free and well-formed? (live check as the user types)
    if (path === "/api/account/username-available" && request.method === "GET") {
      const uname = normUser(url.searchParams.get("u"));
      if (!USERNAME_RE.test(uname)) return Response.json({ valid: false, available: false });
      const r = await credStub(env, uname).fetch("https://do/record");
      const d: any = await r.json();
      return Response.json({ valid: true, available: !d.exists });
    }

    // Sign up: pick a unique username + password, which creates a fresh account and links the two.
    if (path === "/api/account/signup" && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      const uname = normUser(b.username);
      const password = String(b.password || "");
      if (!USERNAME_RE.test(uname)) return Response.json({ ok: false, error: "Usernames are 3–20 characters: letters, numbers, or underscores." });
      if (password.length < 6) return Response.json({ ok: false, error: "Password must be at least 6 characters." });
      const existing: any = await (await credStub(env, uname).fetch("https://do/record")).json();
      if (existing.exists) return Response.json({ ok: false, error: "That username is taken." });
      const id = "a_" + genCode(14), secret = genCode(24);
      const name = String(b.name || b.username || "").slice(0, 40);
      await env.USER_PROFILE.get(env.USER_PROFILE.idFromName(id)).fetch("https://do/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret, name }) });
      const { hash, salt } = await hashPassword(password);
      const cr: any = await (await credStub(env, uname).fetch("https://do/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: String(b.username).slice(0, 20), accountId: id, secret, pwHash: hash, pwSalt: salt }) })).json();
      if (!cr.ok) return Response.json({ ok: false, error: "That username was just taken — try another." });
      return Response.json({ ok: true, accountId: id, secret, name, username: uname });
    }

    // Log in from any device: username + password -> the account's id + secret.
    if (path === "/api/account/login" && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      const uname = normUser(b.username);
      const password = String(b.password || "");
      if (!uname || !password) return Response.json({ ok: false });
      const rec: any = await (await credStub(env, uname).fetch("https://do/record")).json();
      if (!rec.exists || !(await verifyPassword(password, rec.pwHash, rec.pwSalt))) return Response.json({ ok: false, error: "Wrong username or password." });
      return Response.json({ ok: true, accountId: rec.accountId, secret: rec.secret, username: rec.username });
    }

    // Attach a username + password to an existing (passwordless) account, so it can sign in elsewhere.
    if (path === "/api/account/set-credentials" && request.method === "POST") {
      const a = await accountAuth(env, request); if (!a) return new Response("Unauthorized", { status: 401 });
      const b = await request.json<any>().catch(() => ({}));
      const uname = normUser(b.username);
      const password = String(b.password || "");
      if (!USERNAME_RE.test(uname)) return Response.json({ ok: false, error: "Usernames are 3–20 characters: letters, numbers, or underscores." });
      if (password.length < 6) return Response.json({ ok: false, error: "Password must be at least 6 characters." });
      const existing: any = await (await credStub(env, uname).fetch("https://do/record")).json();
      if (existing.exists) return Response.json({ ok: false, error: "That username is taken." });
      const { hash, salt } = await hashPassword(password);
      const cr: any = await (await credStub(env, uname).fetch("https://do/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: String(b.username).slice(0, 20), accountId: a.id, secret: a.secret, pwHash: hash, pwSalt: salt }) })).json();
      if (!cr.ok) return Response.json({ ok: false, error: "That username was just taken — try another." });
      return Response.json({ ok: true, username: uname });
    }
    if (path === "/api/account/me" && request.method === "GET") {
      const a = await accountAuth(env, request); if (!a) return new Response("Unauthorized", { status: 401 });
      const r = await a.stub.fetch("https://do/me", { headers: { "x-secret": a.secret } });
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }
    if (path === "/api/account/round" && request.method === "PUT") {
      const a = await accountAuth(env, request); if (!a) return new Response("Unauthorized", { status: 401 });
      const r = await a.stub.fetch("https://do/round", { method: "PUT", headers: { "x-secret": a.secret, "content-type": "application/json" }, body: await request.text() });
      return new Response(r.body, { status: r.status });
    }
    if (path === "/api/account/round" && request.method === "DELETE") {
      const a = await accountAuth(env, request); if (!a) return new Response("Unauthorized", { status: 401 });
      const r = await a.stub.fetch("https://do/round", { method: "DELETE", headers: { "x-secret": a.secret, "content-type": "application/json" }, body: await request.text() });
      return new Response(r.body, { status: r.status });
    }
    if (path === "/api/account/cup" && (request.method === "PUT" || request.method === "DELETE")) {
      const a = await accountAuth(env, request); if (!a) return new Response("Unauthorized", { status: 401 });
      const r = await a.stub.fetch("https://do/cup", { method: request.method, headers: { "x-secret": a.secret, "content-type": "application/json" }, body: await request.text() });
      return new Response(r.body, { status: r.status });
    }
    if (path === "/api/account/name" && request.method === "POST") {
      const a = await accountAuth(env, request); if (!a) return new Response("Unauthorized", { status: 401 });
      const r = await a.stub.fetch("https://do/name", { method: "POST", headers: { "x-secret": a.secret, "content-type": "application/json" }, body: await request.text() });
      return new Response(r.body, { status: r.status });
    }
    if (path === "/api/account/friends" && request.method === "POST") {
      const a = await accountAuth(env, request); if (!a) return new Response("Unauthorized", { status: 401 });
      const r = await a.stub.fetch("https://do/friends", { method: "POST", headers: { "x-secret": a.secret, "content-type": "application/json" }, body: await request.text() });
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }
    if (path === "/api/account/link" && request.method === "POST") {
      const a = await accountAuth(env, request); if (!a) return new Response("Unauthorized", { status: 401 });
      const code = genCode(6);
      await catalog(env).fetch("https://do/linkmint", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, account: a.id, secret: a.secret }) });
      return Response.json({ ok: true, code });
    }
    if (path === "/api/account/claim" && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const r = await catalog(env).fetch(`https://do/linkclaim?code=${encodeURIComponent(code)}`);
      const d: any = await r.json();
      if (!d || !d.account) return Response.json({ ok: false });
      return Response.json({ ok: true, accountId: d.account, secret: d.secret });
    }
    const fcm = path.match(/^\/api\/account\/card\/([A-Za-z0-9_]+)$/);
    if (fcm && request.method === "GET") {
      const a = await accountAuth(env, request); if (!a) return new Response("Unauthorized", { status: 401 });
      const r = await env.USER_PROFILE.get(env.USER_PROFILE.idFromName(fcm[1])).fetch("https://do/card");
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }

    // ---- Leagues (standing competitions, season standings) ----
    if (path === "/api/league/create" && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      const code = genCode(5), adminSecret = genCode(16);
      await env.LEAGUE.get(env.LEAGUE.idFromName(code)).fetch("https://do/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: String(b.name || "League"), code, adminSecret }) });
      return Response.json({ ok: true, code, adminSecret });
    }
    const lm = path.match(/^\/api\/league\/([A-Za-z0-9]+)\/(join|submit|standings|info)$/);
    if (lm) {
      const stub = env.LEAGUE.get(env.LEAGUE.idFromName(lm[1]));
      const action = lm[2];
      if ((action === "standings" || action === "info") && request.method === "GET") {
        const r = await stub.fetch(`https://do/${action}`);
        return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
      }
      if ((action === "join" || action === "submit") && request.method === "POST") {
        const r = await stub.fetch(`https://do/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: await request.text() });
        return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
      }
    }

    // ---- Current weather at the course (Open-Meteo, no key) for rangefinder "plays like" ----
    if (path === "/api/weather" && request.method === "GET") {
      const lat = parseFloat(url.searchParams.get("lat") || ""), lng = parseFloat(url.searchParams.get("lng") || "");
      if (!isFinite(lat) || !isFinite(lng)) return Response.json({ ok: false });
      return cachedJson(`https://cache/wx/${lat.toFixed(3)},${lng.toFixed(3)}`, 600, async () => {
        try {
          const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`;
          const r = await fetch(u, { cf: { cacheTtl: 600 } } as any);
          if (!r.ok) return Response.json({ ok: false });
          const d: any = await r.json(); const c = d.current || {};
          if (c.temperature_2m == null) return Response.json({ ok: false });
          return Response.json({ ok: true, tempF: Math.round(c.temperature_2m), windMph: Math.round(c.wind_speed_10m || 0), windDir: Math.round(c.wind_direction_10m || 0), gustMph: Math.round(c.wind_gusts_10m || 0) });
        } catch { return Response.json({ ok: false }); }
      });
    }

    // ---- Hole maps from OpenStreetMap (vector diagrams + distances) ----
    if (path === "/api/holemap" && request.method === "GET") {
      const lat = parseFloat(url.searchParams.get("lat") || "");
      const lng = parseFloat(url.searchParams.get("lng") || "");
      const wantHoles = parseInt(url.searchParams.get("holes") || "0") || 0;
      if (!isFinite(lat) || !isFinite(lng)) return Response.json({ available: false, error: "no-location" });
      // A saved map (hand-mapped, or a persisted OSM success) wins — instant and reliable,
      // no Overpass round-trip. Falls through to the live OSM fetch when there isn't one.
      const ck = `${lat.toFixed(4)},${lng.toFixed(4)}`;
      // The DO read is capped at 3s: a slow or wedged catalog can never leave the client
      // stuck on "Loading…" — it just falls through to the live OSM fetch.
      const withTimeout = (p: Promise<any>, ms: number): Promise<any> =>
        Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("do-timeout")), ms))]);
      try {
        const sm: any = await withTimeout(catalog(env).fetch(`https://do/getmap?key=${encodeURIComponent(ck)}`).then((r) => r.json()), 3000);
        if (sm && sm.found && sm.map && sm.map.available) return Response.json(sm.map);
      } catch { /* fall through to OSM */ }
      // Live fetch, banked permanently on success so the next visit is instant and offline-proof.
      return holeMapPersist(env, lat, lng, wantHoles);
    }

    // Same as GET, but carries the course scorecard so unlabeled OSM holes can be numbered from it.
    if (path === "/api/holemap" && request.method === "POST") {
      const b = await request.json<any>().catch(() => ({}));
      const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
      const wantHoles = parseInt(b.holes) || 0;
      const card = Array.isArray(b.card) ? b.card : [];
      if (!isFinite(lat) || !isFinite(lng)) return Response.json({ available: false, error: "no-location" });
      const ck = `${lat.toFixed(4)},${lng.toFixed(4)}`;
      const getmap = () => catalog(env).fetch(`https://do/getmap?key=${encodeURIComponent(ck)}`).then((r) => r.json());
      const withTimeout = (p: Promise<any>, ms: number): Promise<any> => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("do-timeout")), ms))]);
      let map: any = null;
      try { const sm: any = await withTimeout(getmap(), 3000); if (sm && sm.found && sm.map && sm.map.available) map = sm.map; } catch { /* */ }
      if (!map) { const resp = await holeMapPersist(env, lat, lng, wantHoles); try { map = await resp.json(); } catch { /* */ } }
      if (map && map.available && card.length && Array.isArray(map.holes) && map.holes.some((h: any) => !Number.isFinite(h.ref))) {
        const added = numberHolesFromCard(map, card);
        if (added > 0) {
          // Re-bank the now-numbered map, but never over a hand-mapped one.
          let handMapped = false;
          try { const ex: any = await getmap(); handMapped = ex && ex.found && ex.name && ex.name !== "osm"; } catch { /* */ }
          if (!handMapped) await catalog(env).fetch(`https://do/savemap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ coordkey: ck, name: "osm", map }) }).catch(() => {});
        }
      }
      return Response.json(map || { available: false });
    }

    // Save a Course Mapper export as a course's permanent hole map (admin only).
    if (path === "/api/coursemap" && request.method === "POST") {
      const key = request.headers.get("x-admin-key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response("Unauthorized", { status: 401 });
      const exp = await request.json<any>().catch(() => null);
      const lat = Number(exp && exp.lat), lng = Number(exp && exp.lng);
      if (!exp || !isFinite(lat) || !isFinite(lng)) return Response.json({ ok: false, error: "bad-input" });
      const map = mapperToHoleMap(exp);
      if (!map.available) return Response.json({ ok: false, error: "no-holes-mapped" });
      const ck = `${lat.toFixed(4)},${lng.toFixed(4)}`;
      await catalog(env).fetch("https://do/savemap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ coordkey: ck, name: exp.course || "", map }) });
      return Response.json({ ok: true, holes: map.holes.length });
    }

    // ---- Sponsor logos for a round (read public, set by admin token) ----
    const spm = path.match(/^\/api\/round\/([A-Za-z0-9]+)\/sponsors$/);
    if (spm) {
      const stub = env.GOLF_ROUND.get(env.GOLF_ROUND.idFromName(spm[1].toUpperCase()));
      if (request.method === "GET") { const r = await stub.fetch("https://do/getsponsors"); return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } }); }
      if (request.method === "POST") { const r = await stub.fetch("https://do/setsponsors", { method: "POST", headers: { "content-type": "application/json" }, body: await request.text() }); return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } }); }
    }

    // ---- Ryder Cup event ----
    if (path === "/api/cup/create" && request.method === "POST") {
      const cfg = await request.json<any>().catch(() => ({}));
      const code = genCode();
      const adminToken = genCode(20);
      const stub = env.CUP_EVENT.get(env.CUP_EVENT.idFromName(code));
      await stub.fetch("https://do/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...cfg, code, adminToken }) });
      return Response.json({ code, adminToken });
    }
    const cupM = path.match(/^\/api\/cup\/([A-Za-z0-9]+)(?:\/connect)?$/);
    if (cupM) {
      const stub = env.CUP_EVENT.get(env.CUP_EVENT.idFromName(cupM[1].toUpperCase()));
      return stub.fetch(request);
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
