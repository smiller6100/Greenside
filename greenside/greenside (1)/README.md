# Greenside — live golf scoring

A shared, live-updating scorecard for a single golfer, a foursome, or a whole outing.
Built to run entirely on Cloudflare's free plan: one Worker serves the app **and** runs the
live engine (a `GolfRound` Durable Object) that syncs every phone over a WebSocket.

You don't need to write or run any code. Follow the steps below once, and from then on
shipping an update is just replacing files in your repo.

---

## One-time setup (about 10 minutes)

### 1. Put these files in a GitHub repo
1. Go to https://github.com/new and create a new repository named **greenside** (Private is fine).
2. On the new repo's page, click **uploading an existing file**.
3. Unzip the project, then drag **everything inside the `greenside` folder** into the upload box
   (the `src` folder, `worker` folder, `package.json`, `wrangler.jsonc`, `index.html`, etc.).
   - Do **not** upload `node_modules` or `dist` if they appear — they're rebuilt automatically.
4. Click **Commit changes**.

### 2. Connect the repo to Cloudflare
1. In the Cloudflare dashboard, open **Workers & Pages**.
2. Click **Create**, then choose **Import a repository** (connect to Git / GitHub).
3. Authorize GitHub if asked, then pick your **greenside** repo.
4. When it asks for build settings, set:
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy`
   (Leave other fields at their defaults.)
5. Click **Save and Deploy**.

Cloudflare installs everything, builds the app, and deploys it. The `GolfRound` Durable Object
is created automatically on that first deploy — you don't add it manually. When it finishes you'll
get a live URL like `https://greenside.<your-subdomain>.workers.dev`. That's the app.

> Free plan note: this uses SQLite-backed Durable Objects, which are included on the Workers Free
> plan. You won't be charged for storage; normal request limits apply.

---

## Using it
- Open the URL → **Start a round** → name it, add players + handicaps, pick formats → **Create round**.
- You get a short **code** (e.g. `K7QM`). Tap it to copy a share link.
- Anyone opens the link (or taps **Join a round** and types the code), picks who they are, and
  starts tapping in scores. Every phone updates instantly.

## Shipping an update later
When I send you new files:
1. In your GitHub repo, open the file (or folder) that changed.
2. Upload the new version (drag-and-drop replaces it).
3. Commit. Cloudflare rebuilds and redeploys on its own within a minute or two.

No terminal, ever.

---

## What's where (for reference)
- `index.html`, `src/` — the app you see (React).
- `worker/index.ts` — routing + creating rounds.
- `worker/GolfRound.ts` — the live engine (one per round; holds scores, broadcasts updates).
- `wrangler.jsonc` — tells Cloudflare how to wire it all together.

---

## Course search — one-time key setup

Course search uses GolfCourse API (free). The app still works without it (it falls
back to the demo Par 72), but to turn search on:

1. Go to https://golfcourseapi.com and sign up with your email — you'll get an API key.
2. In the Cloudflare dashboard: **Workers & Pages → greenside → Settings → Variables and Secrets**.
3. Click **Add**, choose type **Secret**, set:
   - **Name:** `GOLF_API_KEY`
   - **Value:** the key from step 1
4. Save. That's it — the key is stored securely on the Worker, never in your code.

The Worker caches every course it looks up, so you'll stay well under the free
limit of 50 lookups/day.

## Course aerial
Each hole shows a satellite aerial of the course (free, via Esri imagery). It's a
course-level view — true per-hole flyovers need per-hole GPS coordinates, which the
free data doesn't include. That's a later upgrade.
