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
        const messages = [
          { role: "system", content: "You read golf scorecards from photos and return strict JSON only. No prose, no code fences." },
          { role: "user", content: "From this scorecard, extract the course name and every hole. Return JSON exactly like {\"name\":\"Course Name\",\"holes\":[{\"num\":1,\"par\":4,\"yards\":380,\"si\":5}]}. 'par' is the hole's par, 'yards' is a typical (middle) tee yardage, 'si' is the stroke index / handicap number (1-18) for that hole. Include all holes (9 or 18). If a value is unreadable use 0. Return only the JSON." },
        ];
        const out: any = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { messages, image, max_tokens: 1200 });
        const parsed = extractJson(out?.response || "");
        if (!parsed || !Array.isArray(parsed.holes) || !parsed.holes.length) {
          return Response.json({ error: "unreadable" }, { status: 422 });
        }
        const holes = parsed.holes.map((h: any, i: number) => ({
          num: Number(h.num) || i + 1,
          par: Math.max(3, Math.min(6, Number(h.par) || 4)),
          yards: Math.max(0, Number(h.yards) || 0),
          si: Math.max(0, Math.min(18, Number(h.si) || 0)),
        }));
        return Response.json({ name: typeof parsed.name === "string" ? parsed.name : "", holes });
      } catch {
        return Response.json({ error: "failed" }, { status: 500 });
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
            body: JSON.stringify({ name: cfg.courseName, where: cfg.courseWhere || "", lat: cfg.lat ?? null, lng: cfg.lng ?? null, holes: cfg.course }) });
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
