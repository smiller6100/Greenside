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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Create a new round.
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

    // /api/round/:code   and   /api/round/:code/connect  -> the round's DO
    const m = path.match(/^\/api\/round\/([A-Za-z0-9]+)(?:\/connect)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      const stub = env.GOLF_ROUND.get(env.GOLF_ROUND.idFromName(code));
      return stub.fetch(request);
    }

    // Anything else under /api is unknown; non-/api paths are served as
    // static assets by the platform (this code never runs for those).
    return new Response("Not found", { status: 404 });
  },
};
