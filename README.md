# WaitLess — "Waze for restaurant wait times" (v0.1 PWA)

Crowdsourced drive-thru / dine-in wait times. Single folder, no paid APIs, Python stdlib only.

## Layout
- `server.py` – HTTP server + JSON API + SQLite (`waitapp.db`). Places come from OpenStreetMap Overpass (restaurant/fast_food/cafe), cached 6 h.
- `public/` – PWA (index.html, app.js, app.css, manifest.json, sw.js, icons/). Leaflet + OSM tiles.
- `run.sh` – supervisor (restarts the server if it dies; `TUNNEL=1` also runs a cloudflared quick tunnel, restarted on exit, URL written to `PUBLIC_URL.txt`).
- `screenshots/` – iPhone-size (390x844) screenshots of map and list.

## Run
    nohup setsid ./run.sh >/dev/null 2>&1 &      # http://localhost:8787
    TUNNEL=1 nohup setsid ./run.sh >/dev/null 2>&1 &   # + public https URL (cat PUBLIC_URL.txt)
Env: `PORT` (8787), `APP_NAME`, `DB_PATH`, `DEV_ALLOW_FAR=1` (lets `?dev=1` clients skip the 300 m check and backdate test reports via `age_min`; turn OFF in production).
Rename the app: edit "WaitLess" in public/index.html, public/manifest.json, app.js CFG, and APP_NAME.

## API
- `GET /api/places?lat=&lon=&radius=3000` → places with `status.drive_thru|inside = {minutes, reports, last_ago_min, last_report_id, cars}` or null, plus `typical_min` (fast-food time-of-day guess, labeled "est.").
- `POST /api/report {device, place_id, mode: drive_thru|inside, wait_min: 0|5|10|15|20|30, cars?, lat, lon}` – must be within 300 m; 1 report per place/mode per device per 10 min; 20/hour per device.
- `POST /api/confirm {device, report_id}` – thumbs-up; can't confirm your own; 30/hour.

## Estimate math
weight = 0.5^(age_min/45) × (1 + 0.5 × confirmations); reports > 120 min ignored; estimate = weighted mean.
Colors: ≤7 min green, ≤17 yellow, else red.

## Next steps
1. Host it for real (free tier): Render / Fly.io / Railway (need a free account; add a persistent disk for SQLite or switch to Postgres/Supabase). Then the URL is permanent.
2. Native app: wrap with Expo/React Native (reuse the API) or a thin Swift WKWebView wrapper; needs an Apple Developer account ($99/yr) for TestFlight/App Store.
3. Push notifications, accounts/reputation, anti-spam (trust scores), Google/Apple Places data for hours, auto-detected waits from dwell time (opt-in).

## Deploy on Render (free)
Render → New → Web Service → Public Git Repository → `https://github.com/Espskater102987/waitless`.
Runtime Python, build `pip install -r requirements.txt`, start `python3 server.py`, health check `/api/health`. Render sets `$PORT`; the server binds 0.0.0.0.
Leave `DEV_ALLOW_FAR` unset (off). The free tier has **no persistent disk**: the SQLite DB (reports + place cache) resets whenever the instance restarts or spins down after ~15 min idle (first load after idle takes ~30-60 s). Fine for a prototype since reports expire after 2 h anyway.
