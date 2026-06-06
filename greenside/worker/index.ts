/// <reference types="@cloudflare/workers-types" />
import { GolfRound } from "./GolfRound";
import { CourseCatalog } from "./CourseCatalog";
import type { Env } from "./GolfRound";

export { GolfRound, CourseCatalog };

const BUILD = "v27";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode(len = 4): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const GOLF_API = "https://api.golfcourseapi.com/v1";
const catalog = (env: Env) => env.COURSE_CATALOG.get(env.COURSE_CATALOG.idFromName("global"));

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

function parseHoleMap(data: any) {
  const els = (data && data.elements) || [];
  const ways = els.filter((e: any) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length);
  const g = (v: string) => ways.filter((w: any) => w.tags && w.tags.golf === v);
  const holeWays = g("hole").filter((w: any) => w.geometry.length >= 2);
  const greens = g("green").map((w: any) => ({ poly: hmRing(w.geometry), c: hmCentroid(w.geometry) }));
  const fairways = g("fairway").map((w: any) => ({ poly: hmRing(w.geometry), c: hmCentroid(w.geometry) }));
  const bunkers = g("bunker").map((w: any) => ({ poly: hmRing(w.geometry), c: hmCentroid(w.geometry), kind: "bunker" }));
  const water = ways.filter((w: any) => w.tags && (w.tags.golf === "water_hazard" || w.tags.golf === "lateral_water_hazard" || w.tags.natural === "water"))
    .map((w: any) => ({ poly: hmRing(w.geometry), c: hmCentroid(w.geometry), kind: "water" }));
  const counts = { holes: holeWays.length, greens: greens.length, bunkers: bunkers.length, water: water.length };
  if (!holeWays.length) return { available: false, counts };

  const nearest = (c: number[], arr: any[]) => { let best: any = null, bd = 1e12; for (const a of arr) { const d = hmHav(c, a.c); if (d < bd) { bd = d; best = a; } } return { best, bd }; };
  const minToLine = (c: number[], line: number[][]) => Math.min(...line.map((p) => hmHav(c, p)));

  const holes = holeWays.map((w: any) => {
    const line = hmRing(w.geometry);
    const tee = line[0], gEnd = line[line.length - 1];
    const ref = parseInt(w.tags.ref);
    const par = parseInt(w.tags.par) || null;
    const gn = nearest(gEnd, greens);
    const green = gn.best && gn.bd < 80 ? gn.best : null;
    const greenC = green ? green.c : gEnd;
    const fw = nearest(hmCentroid(w.geometry), fairways);
    const fairway = fw.best && fw.bd < 130 ? fw.best.poly : null;
    const hazards = [...bunkers, ...water].filter((h) => minToLine(h.c, line) < 55)
      .map((h) => ({ kind: h.kind, poly: h.poly, c: h.c, yards: hmYds(hmHav(tee, h.c)) }));
    return { ref: isFinite(ref) ? ref : null, par, line, tee, green: green ? green.poly : null, greenC, fairway, hazards, teeToGreenYds: hmYds(hmHav(tee, greenC)) };
  }).sort((a: any, b: any) => (a.ref || 99) - (b.ref || 99));

  return { available: true, counts, holes };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
        return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
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

        const numArr = (a: any): number[] => (Array.isArray(a) ? a.map((v) => Number(v) || 0) : []);
        const flat = (one: any, f: any, b: any): number[] => {
          if (Array.isArray(one) && one.length) return numArr(one);
          return [...numArr(f), ...numArr(b)];
        };
        const strip = (arr: number[], isTotal: (v: number) => boolean): number[] => arr.filter((v) => !isTotal(v)).slice(0, 18);
        const clampPar = (p: number) => (p >= 3 && p <= 6 ? p : 4);

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
        const asText = (resp: any) => (typeof resp === "string" ? resp : resp ? JSON.stringify(resp) : "");
        // Primary: Llama 4 Scout (far stronger vision). Fallback: the small vision model.
        const runScout = async () => {
          const out: any = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
            messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] }],
            max_tokens: 2400, temperature: 0.1, guided_json: schema,
          });
          return asText(out?.response);
        };
        const runSmall = async () => {
          const out: any = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { image, prompt, max_tokens: 2200 });
          return asText(out?.response);
        };

        let best: any = null;
        const attempts = [runScout, runScout, runSmall]; // strong model twice, then fall back
        for (const run of attempts) {
          let text = "";
          try { text = await run(); } catch { continue; }
          const r = build(extractJson(text));
          if (r && (!best || r.score > best.score)) best = r;
          if (best && best.score >= 2000) break; // two or more tees with real yardages — good enough
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
          await catalog(env).fetch("https://do/upsert", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: cfg.courseName, where: cfg.courseWhere || "", lat: cfg.lat ?? null, lng: cfg.lng ?? null, holes: cfg.course, tees: cfg.tees || null, defaultTee: cfg.teeName || cfg.defaultTee || null }) });
        } catch { /* non-fatal */ }
      }
      return Response.json({ code, adminToken });
    }

    // ---- Hole maps from OpenStreetMap (vector diagrams + distances) ----
    if (path === "/api/holemap" && request.method === "GET") {
      const lat = parseFloat(url.searchParams.get("lat") || "");
      const lng = parseFloat(url.searchParams.get("lng") || "");
      if (!isFinite(lat) || !isFinite(lng)) return Response.json({ available: false, error: "no-location" });
      return cachedJson(`https://cache/holemap/${lat.toFixed(4)},${lng.toFixed(4)}`, 7 * 86400, async () => {
        const q = `[out:json][timeout:25];(way["golf"](around:1600,${lat},${lng});relation["golf"](around:1600,${lat},${lng}););out geom;`;
        try {
          const r = await fetch("https://overpass-api.de/api/interpreter", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "data=" + encodeURIComponent(q),
          });
          if (!r.ok) return Response.json({ available: false, error: "overpass-" + r.status });
          const data = await r.json();
          return Response.json(parseHoleMap(data));
        } catch {
          return Response.json({ available: false, error: "overpass-fetch-failed" });
        }
      });
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
