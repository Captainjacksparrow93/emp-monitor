# EmpMonitor — Postgres edition (Neon free-tier friendly)

A self-contained, deployable version of EmpMonitor with three parts:

| Part | Folder | Runs on | What it does |
|---|---|---|---|
| **Desktop agent** | [`agent/`](agent) | Employees' Windows & macOS computers | Tracks active/idle time, apps, websites, takes screenshots, receives policy + remote commands |
| **API server** | [`server/`](server) | One always-on Node process (Fly.io, Railway, a VPS…) | Receives agent data, buffers it, writes to Postgres in batches, serves the dashboard API |
| **Dashboard** | [`dashboard/`](dashboard) | **Vercel** (static React app) | Analytics, screenshots, machine configuration, policies, DB-size panel |

```
 Windows / macOS agents ──HTTPS──▶  API server  ──batched writes every 20 min──▶  Neon Postgres (0.5 GB)
   (offline queue on disk)          │  in-memory buffer + disk spool                ▲
                                    │  screenshots ──▶ local disk or Cloudflare R2  │ reads (cached 60 s)
 Admin browser ──▶ Vercel dashboard ┘────────────────────────────────────────────────┘
```

## Features

- **Machines:** enrollment codes (single-use or fleet-wide), silent mass deployment, live status (online / idle / paused / current app), rename, assign employee, per-machine policy override, bulk actions, remote commands (screenshot now, pause/resume, reload policy, restart agent, show a message), revoke & uninstall, delete with all data.
- **Monitoring policy (global + per machine):** screenshot interval / random timing / JPEG quality / max width / blur / all monitors / skip while idle; app & website tracking; idle threshold; sampling rate; excluded (private) apps; working-hours schedule including overnight shifts; employee self-pause with a maximum length; upload & heartbeat intervals; one-time monitoring notice.
- **Analytics:** overview KPIs, activity by hour, productivity split, top apps & websites, team table, attendance (first/last activity, active/idle), app & website usage, productivity by person. Filter by employee, department or machine and by date range. CSV export.
- **Screenshots:** gallery with date / person / app filters, lightbox with keyboard navigation, delete. Images are served through short-lived signed URLs.
- **Productivity rules:** classify apps and domains, with a "needs classification" queue built from real usage. Rules apply retroactively.
- **People:** employees and departments.
- **Admin:** dashboard users (administrator / read-only viewer), organization timezone, data retention, audit log.
- **Database & system panel:** database size against the 0.5 GB Neon quota with a per-table breakdown, Neon CU-hours used (via the Neon API), autoscale and auto-suspend warnings, this server's compute wake-up counter, write-buffer state, screenshot storage use, and maintenance buttons (flush, retention cleanup, vacuum).

## How it keeps Neon compute (CU-hours) low

Neon's free plan suspends the compute after 5 minutes without queries, and you pay CU-hours only while it is awake. The design therefore avoids touching Postgres unless it has to:

| Traffic | Touches Postgres? |
|---|---|
| Agent heartbeats (every 2 min per machine), config polls, live view, machine list | **No.** Served from memory. |
| Agent activity uploads & screenshot metadata | Merged in memory and appended to a disk spool. Written in **one transaction every `FLUSH_INTERVAL_MIN`** (default 20) using set-based `UPSERT`s. Empty flushes are skipped. |
| Screenshot images | **Never.** Stored on local disk or S3/R2. Postgres keeps ~120 bytes of metadata per image. |
| Admin/agent authentication | **No.** Stateless JWT, plus an in-memory device table. |
| Dashboard pages | Yes, but every analytics request first flushes pending data (the DB is awake anyway), and results are cached for 60 s. |
| Retention cleanup | Once a day, straight after a scheduled flush. It never causes a wake-up of its own. |
| `/healthz` (uptime monitors) | **No.** |

The pool also closes idle connections after 10 s, so nothing holds the compute open.

**Rough budget:** with a 20-minute flush, the compute is awake about 5–7 of every 20 minutes while agents are working. On the minimum 0.25 CU that is roughly **0.25 CU × ~3 h/day × 22 working days ≈ 17 CU-h**, plus dashboard use. That fits comfortably inside the free plan's 100 CU-h per month. Raise `FLUSH_INTERVAL_MIN` (for example to 30 or 60) for even fewer wake-ups; the dashboard still shows fresh data because it flushes on load.

**Storage:** activity is stored pre-aggregated per hour, which works out to roughly 10–30 KB per machine per working day. With the default 180-day retention, 0.5 GB holds about 50–100 machines. The System panel shows the real numbers.

## Deploy

### 1. Neon database
1. Create a project at neon.tech and copy the **pooled** connection string (the host contains `-pooler`).
2. In *Compute settings*, set autoscaling to **0.25 → 0.25 CU** (or 0.5 max) and leave auto-suspend on (default 5 min).
3. Optional: create an API key (Account → API keys) and note the project ID. These let the System panel show exact CU-hours.

### 2. API server (always-on host)
The server must be **one long-running process**, not serverless. It holds the write buffer, live presence and the flush timer. Vercel Functions, Netlify Functions and similar platforms won't work for it. Good options are Fly.io (see [`server/fly.toml.example`](server/fly.toml.example)), Railway, Render (paid instance with a disk), or any small VPS.

```bash
cd pg-edition
docker build -f server/Dockerfile -t empmonitor-server .
docker run -d -p 8080:8080 -v empmonitor-data:/data \
  -e DATABASE_URL='postgresql://…-pooler…/neondb?sslmode=require' \
  -e JWT_SECRET='a-long-random-string' \
  -e PUBLIC_URL='https://api.yourcompany.com' \
  -e CORS_ORIGINS='https://your-dashboard.vercel.app' \
  empmonitor-server
```

Without Docker: `cd server && npm ci && cp .env.example .env` (edit it) `&& npm start`.

All settings are documented in [`server/.env.example`](server/.env.example). The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon pooled connection string |
| `JWT_SECRET` | Signs admin and device tokens. Don't change it after machines are enrolled. |
| `CORS_ORIGINS` | Your Vercel dashboard URL(s), comma-separated |
| `PUBLIC_URL` | The URL agents use; shown on the "Add machine" screen |
| `DATA_DIR` | Disk spool + local screenshots. Must be **persistent**. |
| `FLUSH_INTERVAL_MIN` | Batch write interval (CU-hours vs. freshness) |
| `S3_*` | Optional Cloudflare R2 / S3 bucket for screenshots (R2 free = 10 GB) |
| `NEON_API_KEY`, `NEON_PROJECT_ID` | Optional: CU-hour usage in the System panel |
| `AGENT_DOWNLOAD_WIN`, `AGENT_DOWNLOAD_MAC` | Links shown to admins on the "Add machine" screen |

On first start the server creates the schema and seeds starter productivity rules.

### 3. Dashboard on Vercel
1. Import the repository in Vercel and set **Root Directory** to `pg-edition/dashboard`. The framework (Vite) is detected from `vercel.json`.
2. Add the environment variable **`VITE_API_URL=https://api.yourcompany.com`** (your API server, no trailing slash).
3. Deploy, open the site and create the first administrator account.
4. Add the Vercel URL to the server's `CORS_ORIGINS`.

### 4. Desktop agent (Windows & macOS)
Installers are built by GitHub Actions ([`.github/workflows/pg-edition-agent.yml`](../.github/workflows/pg-edition-agent.yml)):

- **Actions → "Build desktop agent" → Run workflow**: downloads appear as workflow artifacts.
- Push a tag `agent-v1.0.0`: a GitHub Release is published with `EmpMonitor-Agent-Setup-1.0.0.exe` and `EmpMonitor-Agent-1.0.0-mac.dmg` (universal: Intel + Apple Silicon).

Then, in the dashboard, go to **Machines → Add machine**: create a code, install the agent, and enter the server URL and code.

**Mass deployment:** create an *unlimited* code, then do one of the following:
- Put `enroll.json` (`{"serverUrl":"…","code":"…"}`) next to the installer and run `EmpMonitor-Agent-Setup.exe /S` (the installer copies it to `%ProgramData%\EmpMonitorAgent\`).
- On macOS, deploy `/Library/Application Support/EmpMonitorAgent/enroll.json` with your MDM.
- Launch the agent with `--server=… --code=…`.

**macOS permissions:** the agent needs *Screen Recording* (for screenshots) and *Accessibility* (for window titles and browser URLs). It prompts for both after enrollment. With an MDM, grant them silently using a PPPC profile for bundle ID `com.empmonitor.agent`. The dashboard flags Macs that are missing a permission.

**Code signing:** unsigned builds work, but Windows SmartScreen and macOS Gatekeeper show warnings (on macOS: right-click → Open the first time). For production, add the signing secrets listed at the top of the workflow file.

**Website tracking:** on macOS, the agent reads the active tab's URL from Safari, Chrome, Edge, Brave and Arc, and stores only the domain. On Windows, browsers don't expose the URL to other apps, so the agent picks up the domain only when it appears in the window title. Otherwise the time is recorded under the browser's name.

## Develop locally

```bash
# Postgres (any local instance)
createdb empmonitor

# API
cd pg-edition/server && npm install
DATABASE_URL=postgresql://localhost/empmonitor JWT_SECRET=dev-secret-dev-secret npm run dev

# Dashboard (proxies /api to :8080)
cd pg-edition/dashboard && npm install && npm run dev

# Agent
cd pg-edition/agent && npm install && npm start -- --server=http://localhost:8080 --code=XXXXX-XXXXX
```

Tests:

```bash
cd pg-edition/server && TEST_DATABASE_URL=postgresql://localhost/empmonitor_test npm test   # end-to-end API flow
cd pg-edition/agent && npm test                                                              # aggregation / schedule / parsing
```

## Privacy & legal

Employee monitoring is regulated in many countries (for example GDPR in the EU/UK, and state laws in the US). The agent is deliberately **visible**: it has a tray / menu-bar icon and shows a one-time notice that lists what is collected. It stores domains rather than full URLs, keeps window titles out of the database, supports private/excluded apps, blurred screenshots and working-hours-only monitoring, and supports retention limits. Make sure your use complies with local law and your employment agreements.
