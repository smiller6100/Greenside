/// <reference types="@cloudflare/workers-types" />
import { GolfRound } from "./GolfRound";
import { CourseCatalog } from "./CourseCatalog";
import type { Env } from "./GolfRound";

export { GolfRound, CourseCatalog };

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

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
      try {
        const r: any = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree", max_tokens: 16 });
        return Response.json({ accepted: true, reply: String(r?.response || "").slice(0, 200) });
      } catch (e: any) {
        return Response.json({ accepted: false, error: String(e?.message || e).slice(0, 400) });
      }
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
        const image = [...new Uint8Array(buf)];
        const prompt =
          'You read golf scorecards. Look at the image and return STRICT JSON only — no prose, no code fences — in exactly this shape: ' +
          '{"name":"<course name>","par_front":[9 numbers],"par_back":[9 numbers],"hcp_front":[9 numbers],"hcp_back":[9 numbers],"tees":[{"name":"<tee or color name>","front":[9 numbers],"back":[9 numbers]}]}. ' +
          'The card has a FRONT NINE (holes 1-9) and a BACK NINE (holes 10-18). Between and after the nines there are subtotal columns labeled OUT, IN, and TOTAL (or TOT). ' +
          'CRITICAL: NEVER include the OUT, IN, or TOTAL subtotal numbers. Return ONLY the 9 real hole values for the front and the 9 real hole values for the back. Every array must contain EXACTLY 9 numbers. ' +
          'par_front / par_back: the Par for those 9 holes. hcp_front / hcp_back: the Handicap / stroke-index (a rank 1-18) for those 9 holes; if men and women rows both exist, use the first. ' +
          '"tees": ONE entry for EACH tee box / colored row on the card (for example Black, Blue, White, Gold, Red, Orange, Teal). "front" and "back" are that tee row\'s 9 + 9 hole yardages, never the OUT/IN/TOTAL totals. ' +
          'If the card is only 9 holes, fill front and leave back as []. If a single value is unreadable use 0. Return only the JSON object.';
        const out: any = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { image, prompt, max_tokens: 2200 });
        const parsed = extractJson(out?.response || "");
        if (!parsed) return Response.json({ error: "unreadable" }, { status: 422 });

        const numArr = (a: any, cap = 0): number[] => {
          let x = Array.isArray(a) ? a.map((v) => Number(v) || 0) : [];
          if (cap) x = x.map((v) => (v >= cap ? 0 : v)); // drop subtotal/total values that slipped in
          return x.slice(0, 9);
        };
        // front + back, each forced to 9, concatenated to 18 (skips any OUT/IN/TOTAL by construction)
        const join9 = (f: any, b: any, cap = 0): number[] => {
          const front = numArr(f, cap); while (front.length < 9) front.push(0);
          const backArr = Array.isArray(b) && b.length ? numArr(b, cap) : [];
          if (!backArr.length) return front; // 9-hole card
          while (backArr.length < 9) backArr.push(0);
          return [...front, ...backArr];
        };

        let par = join9(parsed.par_front, parsed.par_back);
        let hcp = join9(parsed.hcp_front, parsed.hcp_back);
        let teesIn: any[] = Array.isArray(parsed.tees) ? parsed.tees : [];
        // tolerate the old flat 18-length shape if the model returns it
        if (!par.length && Array.isArray(parsed.par)) par = (parsed.par as any[]).map((x) => Number(x) || 0).slice(0, 18);
        if (!hcp.length && Array.isArray(parsed.handicap)) hcp = (parsed.handicap as any[]).map((x) => Number(x) || 0).slice(0, 18);

        const teeLens = teesIn.map((t) => join9(t.front, t.back, 900).length);
        const n = Math.max(par.length, hcp.length, ...teeLens, 0);
        if (!n) return Response.json({ error: "unreadable" }, { status: 422 });

        const clampPar = (p: number) => (p >= 3 && p <= 6 ? p : 4);
        let teeData = teesIn.map((t) => {
          const y = join9(t.front, t.back, 900); // cap 900 = no single hole that long, so totals are dropped
          const holes = Array.from({ length: n }, (_, i) => ({ num: i + 1, par: clampPar(par[i]), yards: Math.max(0, Math.min(899, y[i] || 0)), si: 0 }));
          return { name: (String(t.name || "Tee").trim() || "Tee"), total: holes.reduce((s, h) => s + h.yards, 0), holes };
        }).filter((t) => t.holes.length);
        if (!teeData.length) teeData = [{ name: "Scanned", total: 0, holes: Array.from({ length: n }, (_, i) => ({ num: i + 1, par: clampPar(par[i]), yards: 0, si: 0 })) }];

        // shared stroke index from the handicap row, else estimate from the longest tee
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
        return Response.json({ name: typeof parsed.name === "string" ? parsed.name : "", holes: def.holes, tees: teeData, defaultTee: def.name, siEstimated });
      } catch (e: any) {
        return Response.json({ error: "failed", detail: String(e?.message || e).slice(0, 300) }, { status: 500 });
      }
    }

    // ---- Create a round (and save its course to the catalog) ----
    if (path === "/api/round" && request.method === "POST") {
      const cfg = await request.json<any>();
      const code = genCode();
      const stub = env.GOLF_ROUND.get(env.GOLF_ROUND.idFromName(code));
      await stub.fetch("https://do/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...cfg, code }) });
      if (cfg.courseName && Array.isArray(cfg.course) && cfg.course.length) {
        try {
          await catalog(env).fetch("https://do/upsert", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: cfg.courseName, where: cfg.courseWhere || "", lat: cfg.lat ?? null, lng: cfg.lng ?? null, holes: cfg.course, tees: cfg.tees || null, defaultTee: cfg.teeName || cfg.defaultTee || null }) });
        } catch { /* non-fatal */ }
      }
      return Response.json({ code });
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
