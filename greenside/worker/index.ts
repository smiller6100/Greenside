/// <reference types="@cloudflare/workers-types" />
import { GolfRound } from "./GolfRound";
import type { Env } from "./GolfRound";

export { GolfRound };

// Unambiguous alphabet (no 0/O, 1/I/L) so codes are easy to read aloud.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode(len = 4): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// ---- GolfCourse API helpers (https://golfcourseapi.com) ----
const GOLF_API = "https://api.golfcourseapi.com/v1";

function simplifyCourse(c: any) {
  const loc = c.location || {};
  const name = [c.club_name, c.course_name].filter(Boolean).join(" — ") || c.course_name || c.club_name || "Course";
  return {
    id: c.id,
    name,
    where: [loc.city, loc.state].filter(Boolean).join(", "),
    lat: loc.latitude ?? null,
    lng: loc.longitude ?? null,
  };
}

function courseToHoles(course: any) {
  const loc = course.location || {};
  const tees = course.tees || {};
  const teeArr =
    tees.male && tees.male.length ? tees.male :
    tees.female && tees.female.length ? tees.female : [];
  const tee = teeArr[0] || null;

  let holes: any[] = [];
  if (tee && Array.isArray(tee.holes) && tee.holes.length) {
    holes = tee.holes.map((h: any, i: number) => ({
      num: i + 1,
      par: Number(h.par) || 4,
      yards: Number(h.yardage) || 0,
      si: Number(h.handicap) || 0,
    }));
  }

  // If the data has no usable stroke index, estimate one by ranking holes
  // hardest-first by yardage. The organizer can correct it in the app.
  const uniqueSI = new Set(holes.map((h) => h.si));
  const siEstimated = holes.length > 0 && (!holes.some((h) => h.si > 0) || uniqueSI.size !== holes.length);
  if (siEstimated && holes.length) {
    [...holes].sort((a, b) => b.yards - a.yards).forEach((h, idx) => { h.si = idx + 1; });
  }

  return {
    name: [course.club_name, course.course_name].filter(Boolean).join(" — "),
    lat: loc.latitude ?? null,
    lng: loc.longitude ?? null,
    holes,
    siEstimated,
  };
}

async function cachedJson(cacheUrl: string, ttl: number, produce: () => Promise<Response>): Promise<Response> {
  const cache = (caches as any).default;
  const key = new Request(cacheUrl);
  const hit = await cache.match(key);
  if (hit) return hit;
  const fresh = await produce();
  if (fresh.ok) {
    const toCache = fresh.clone();
    toCache.headers.set("Cache-Control", `max-age=${ttl}`);
    await cache.put(key, toCache);
  }
  return fresh;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- Course search ----
    if (path === "/api/courses/search" && request.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return Response.json({ courses: [] });
      if (!env.GOLF_API_KEY) return Response.json({ courses: [], unconfigured: true });
      return cachedJson(`https://cache/csearch?q=${encodeURIComponent(q.toLowerCase())}`, 86400, async () => {
        const r = await fetch(`${GOLF_API}/search?search_query=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Key ${env.GOLF_API_KEY}` },
        });
        if (!r.ok) return Response.json({ courses: [], error: r.status });
        const data: any = await r.json();
        return Response.json({ courses: (data.courses || []).slice(0, 12).map(simplifyCourse) });
      });
    }

    // ---- Course detail (hole-by-hole) ----
    const cm = path.match(/^\/api\/courses\/(\d+)$/);
    if (cm && request.method === "GET") {
      if (!env.GOLF_API_KEY) return new Response("Course search not configured", { status: 503 });
      return cachedJson(`https://cache/course/${cm[1]}`, 604800, async () => {
        const r = await fetch(`${GOLF_API}/courses/${cm[1]}`, {
          headers: { Authorization: `Key ${env.GOLF_API_KEY}` },
        });
        if (!r.ok) return new Response("Course not found", { status: r.status });
        const data: any = await r.json();
        return Response.json(courseToHoles(data.course));
      });
    }

    // ---- Create a round ----
    if (path === "/api/round" && request.method === "POST") {
      const cfg = await request.json<any>();
      const code = genCode();
      const stub = env.GOLF_ROUND.get(env.GOLF_ROUND.idFromName(code));
      await stub.fetch("https://do/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...cfg, code }),
      });
      return Response.json({ code });
    }

    // ---- A round's live object ----
    const m = path.match(/^\/api\/round\/([A-Za-z0-9]+)(?:\/connect)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      const stub = env.GOLF_ROUND.get(env.GOLF_ROUND.idFromName(code));
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
