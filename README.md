# Daily Dairy

Fetches a diary entry from a school parent portal, saves it as a PDF, sends it to WhatsApp, and can run automatically every day.

## Setup

```
npm install
cp .env.example .env
```

Edit `.env` and fill in `PORTAL_URL` (your school's parent-portal login page), plus your real `USID` and `PASSWORD`. This file is gitignored and never read by anyone but the script.

## Run

```
npm run fetch-diary
```

By default it fetches today's diary. Pass a date to fetch a different day instead:

```
npm run fetch-diary -- "Sep 24"
npm run fetch-diary -- "2026-09-24"
```

Pass a from and to date to fetch a whole range (one PDF per day that has an entry; days with no diary published, e.g. weekends, are skipped):

```
npm run fetch-diary -- "Sep 24" "Sep 30"
```

The portal browser runs visibly by default so you can watch it work. Set `HEADLESS=true` to run it hidden in the background instead:

```
HEADLESS=true npm run fetch-diary
```

Output is saved to `diary/YYYY-MM-DD.pdf` — a portrait A4 PDF with the subject table on page 1 and announcements on a separate page. If something fails, a screenshot is saved to `last-failure.png` to help debug. `diary/` is gitignored since these PDFs contain personal information.

Any attachments linked in the diary are downloaded to `ATTACHMENTS_DIR` (default: `./attachments/YYYY-MM-DD/`; point it anywhere, e.g. a synced cloud-drive folder). When attachments are found, a note listing them and their saved path is added to the PDF below the table.

## WhatsApp

After each PDF is saved, it's automatically sent to a WhatsApp group (set via the `WHATSAPP_GROUP` env var) with a caption like "Diary — 30 Sep 2026", via `whatsapp.js`.

Sending is handled by [WAHA](https://waha.devlike.pro/) (WhatsApp HTTP API) — a separate, self-hosted Docker container that runs its own WhatsApp Web session and exposes a simple REST API. `whatsapp.js` just makes HTTP calls to it; it doesn't drive a browser itself, which avoids the fragility of DOM-selector-based automation (WhatsApp Web's UI changes periodically and silently breaks that approach).

**Running WAHA:**
```
docker run -d --name waha \
  -p 127.0.0.1:3000:3000 \
  -v waha_sessions:/app/.sessions \
  -e WHATSAPP_API_KEY=<a key of your choosing> \
  -e WAHA_DASHBOARD_USERNAME=admin \
  -e WAHA_DASHBOARD_PASSWORD=<same key> \
  --restart unless-stopped \
  devlikeapro/waha
```
Bound to `localhost` only — not exposed to the internet, since this script and WAHA run on the same machine. To do the one-time QR code login, tunnel its dashboard to your own machine (`ssh -L 3000:localhost:3000 <host>`), open `http://localhost:3000/dashboard/`, connect to the server (URL `http://localhost:3000`, API key as set above), and start a session named `default` — scan the QR code shown there with WhatsApp on your phone (Linked Devices). The session persists in the `waha_sessions` Docker volume afterward.

Env vars: `WAHA_URL` (default `http://localhost:3000`), `WAHA_API_KEY` (must match what WAHA was started with), `WAHA_SESSION` (default `default`), `WHATSAPP_CHAT_ID` (optional — skips the by-name group lookup if set, e.g. `1234567890@g.us`).

If a WhatsApp send fails (e.g. the session logs out, or WAHA isn't running), it's logged as a warning but doesn't affect the PDF — the diary is still fetched and saved either way.

**Note on server sizing**: WAHA runs its own Chromium instance, which needs real memory headroom — a `t3.micro` (1GB RAM) EC2 instance was not enough and hung under memory pressure; add swap space (`fallocate`/`mkswap`/`swapon`, persisted via `/etc/fstab`) if running on a small instance.

## Scheduled daily run (Windows Task Scheduler)

A scheduled task runs `run-diary.bat` every day at **6:00 PM**, which sets `HEADLESS=true` and runs `node fetch-diary.js` with no arguments (today's diary). Output is appended to `logs/scheduler.log` (gitignored) with a timestamp header per run — check there if a scheduled run seems to have not worked.

Set it up with:
```
schtasks /Create /TN "DailyDairyFetch" /TR "<full path to>\run-diary.bat" /SC DAILY /ST 18:00 /F
```

Manage it with:
```
schtasks /Query /TN "DailyDairyFetch" /V /FO LIST   REM check status / last run
schtasks /Delete /TN "DailyDairyFetch" /F            REM remove it
```

Notes:
- The task only runs while you're logged into Windows (not if fully logged off), and won't start on battery power by default — both are standard Task Scheduler behavior for a per-user task set up without a stored password.
- Because `HEADLESS=true` is used, WhatsApp's session must already be linked (see above) before the scheduled run happens — there's no one to scan a QR code at 6pm, so login there is capped at 30s and fails fast into the log instead of hanging.
