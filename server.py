#!/usr/bin/env python3
"""WaitLess backend: stdlib only (http.server + sqlite3)."""
import json, math, os, sqlite3, time, threading, urllib.request, urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

APP_NAME = os.environ.get("APP_NAME", "WaitLess")
PORT = int(os.environ.get("PORT", "8787"))
DB = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "waitapp.db"))
DEV_OVERRIDE = os.environ.get("DEV_ALLOW_FAR", "0") == "1"
HALF_LIFE_MIN = 45.0
MAX_AGE_MIN = 120.0
MAX_DIST_M = 300.0
PUBLIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
lock = threading.Lock()

def db():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row; return c

def init():
    c = db()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS places(id TEXT PRIMARY KEY, name TEXT, kind TEXT, lat REAL, lon REAL, drive_thru INT, updated REAL);
    CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT, place_id TEXT, device TEXT, mode TEXT,
      wait_min INT, cars INT, lat REAL, lon REAL, ts REAL);
    CREATE TABLE IF NOT EXISTS confirms(report_id INT, device TEXT, ts REAL, PRIMARY KEY(report_id, device));
    CREATE INDEX IF NOT EXISTS r_place ON reports(place_id, ts);
    """); c.commit(); c.close()

def haversine(a, b, c_, d):
    R = 6371000; p1, p2 = math.radians(a), math.radians(c_)
    dp, dl = p2 - p1, math.radians(d - b)
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(h))

def estimate(rows, now):
    """Recency-weighted mean. weight = 0.5^(age/45min) * (1 + 0.5*confirms). Ignore > 120 min."""
    num = den = 0.0; newest = None; n = 0; cars = None
    for r in rows:
        age = (now - r["ts"]) / 60.0
        if age > MAX_AGE_MIN or age < 0: continue
        w = 0.5 ** (age / HALF_LIFE_MIN) * (1 + 0.5 * (r["confirms"] or 0))
        num += w * r["wait_min"]; den += w; n += 1
        if newest is None or r["ts"] > newest["ts"]: newest = r
    if not den: return None
    return {"minutes": round(num/den, 1), "reports": n, "last_ago_min": round((now-newest["ts"])/60, 1),
            "last_report_id": newest["id"], "cars": newest["cars"]}

def typical(kind, now):
    """Rough time-of-day prior for fast food only (local box time)."""
    if kind != "fast_food": return None
    h = time.localtime(now).tm_hour
    table = {11: 8, 12: 12, 13: 10, 17: 9, 18: 12, 19: 9, 7: 5, 8: 6}
    return table.get(h, 4)

def place_status(c, p, now):
    out = {}
    for mode in ("drive_thru", "inside"):
        rows = c.execute("""SELECT r.*, (SELECT COUNT(*) FROM confirms f WHERE f.report_id=r.id) confirms
            FROM reports r WHERE place_id=? AND mode=? AND ts>?""", (p["id"], mode, now - MAX_AGE_MIN*60)).fetchall()
        out[mode] = estimate(rows, now)
    return out

UA = "WaitLess/0.2 (crowdsourced wait times; +https://github.com/espskater102987/waitless)"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
            "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
KINDS = ("restaurant", "fast_food", "cafe")

def _overpass(url, lat, lon, radius, timeout):
    q = f"""[out:json][timeout:20];(nwr["amenity"~"^(restaurant|fast_food|cafe)$"](around:{radius},{lat},{lon}););out center tags 600;"""
    req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(), headers={"User-Agent": UA})
    els = json.load(urllib.request.urlopen(req, timeout=timeout))["elements"]
    out = []
    for e in els:
        t = e.get("tags", {}); la = e.get("lat") or e.get("center", {}).get("lat"); lo = e.get("lon") or e.get("center", {}).get("lon")
        if t.get("name") and la is not None:
            out.append((f"{e['type'][0]}{e['id']}", t["name"], t.get("amenity"), la, lo, 1 if t.get("drive_through") == "yes" else 0))
    return out

def _nominatim(lat, lon, radius, timeout):
    """Fallback: Nominatim structured amenity search inside a bounding box (1 req/s policy respected)."""
    d = radius / 111000.0; dl = d / max(0.2, math.cos(math.radians(lat)))
    vb = f"{lon-dl},{lat+d},{lon+dl},{lat-d}"; out = []
    for i, k in enumerate(KINDS):
        if i: time.sleep(1.1)
        u = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
            {"amenity": k, "viewbox": vb, "bounded": 1, "format": "jsonv2", "limit": 50})
        for e in json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=timeout)):
            if e.get("name"):
                out.append((f"{e['osm_type'][0]}{e['osm_id']}", e["name"], e.get("type", k), float(e["lat"]), float(e["lon"]), 0))
    return out

def fetch_osm(lat, lon, radius, budget=15):
    """Race all Overpass mirrors in parallel; first non-empty answer wins. Fall back to Nominatim."""
    import concurrent.futures as cf
    ex = cf.ThreadPoolExecutor(len(OVERPASS)); futs = [ex.submit(_overpass, u, lat, lon, radius, budget) for u in OVERPASS]
    errs = []
    try:
        for f in cf.as_completed(futs, timeout=budget):
            try:
                r = f.result()
                if r: return r, "overpass"
            except Exception as e: errs.append(repr(e)[:120])
    except cf.TimeoutError: errs.append("overpass timeout")
    finally: ex.shutdown(wait=False, cancel_futures=True)
    print("overpass failed:", errs, flush=True)
    return _nominatim(lat, lon, radius, 10), "nominatim"

cache = {}; fails = {}
def places_near(lat, lon, radius):
    key = (round(lat, 2), round(lon, 2), radius)
    now = time.time(); c = db(); meta = {"source": "cache"}
    if now - cache.get(key, 0) > 6*3600 and now - fails.get(key, 0) > 45:
        try:
            rows, src = fetch_osm(lat, lon, radius)
            with lock:
                for r in rows: c.execute("INSERT OR REPLACE INTO places VALUES(?,?,?,?,?,?,?)", (*r, now))
                c.commit()
            if rows: cache[key] = now; fails.pop(key, None)
            else: fails[key] = now
            meta = {"source": src}
        except Exception as ex:
            print("places error", ex, flush=True); fails[key] = now; meta = {"source": "error", "error": "Map data service is busy"}
    d = radius / 111000.0
    rows = c.execute("SELECT * FROM places WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                     (lat-d, lat+d, lon-d*1.3, lon+d*1.3)).fetchall()
    res = []
    for p in rows:
        dist = haversine(lat, lon, p["lat"], p["lon"])
        if dist > radius: continue
        s = place_status(c, p, now)
        res.append({**dict(p), "distance_m": round(dist), "status": s, "typical_min": typical(p["kind"], now)})
    c.close(); res.sort(key=lambda x: x["distance_m"]); return res, meta

class H(SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=PUBLIC, **k)
    def log_message(s, f, *a): pass
    def j(s, code, obj):
        b = json.dumps(obj).encode(); s.send_response(code)
        s.send_header("Content-Type", "application/json"); s.send_header("Content-Length", len(b)); s.send_header("Cache-Control", "no-store")
        s.end_headers(); s.wfile.write(b)
    def end_headers(s):
        if s.path.endswith("sw.js") or s.path in ("/", "/index.html"): s.send_header("Cache-Control", "no-cache")
        super().end_headers()
    def do_GET(s):
        u = urllib.parse.urlparse(s.path); q = dict(urllib.parse.parse_qsl(u.query))
        if u.path == "/api/places":
            try:
                lat, lon = float(q["lat"]), float(q["lon"]); r = max(500, min(int(q.get("radius", 8000)), 15000))
            except Exception: return s.j(400, {"error": "lat/lon required"})
            pl, meta = places_near(lat, lon, r)
            return s.j(200, {"places": pl, **meta, "retry": not pl, "now": time.time(), "app": APP_NAME})
        if u.path == "/api/config":
            return s.j(200, {"app": APP_NAME, "dev_allow_far": DEV_OVERRIDE, "max_dist_m": MAX_DIST_M, "half_life_min": HALF_LIFE_MIN})
        if u.path == "/api/health": return s.j(200, {"ok": True})
        return super().do_GET()
    def body(s):
        n = int(s.headers.get("Content-Length", 0) or 0)
        return json.loads(s.rfile.read(n) or b"{}")
    def do_POST(s):
        u = urllib.parse.urlparse(s.path)
        try: b = s.body()
        except Exception: return s.j(400, {"error": "bad json"})
        dev = str(b.get("device", ""))[:64]
        if len(dev) < 8: return s.j(400, {"error": "device id required"})
        now = time.time(); c = db()
        try:
            if u.path == "/api/report":
                mode = b.get("mode"); w = b.get("wait_min")
                if mode not in ("drive_thru", "inside") or w not in (0, 5, 10, 15, 20, 30):
                    return s.j(400, {"error": "bad mode or wait"})
                p = c.execute("SELECT * FROM places WHERE id=?", (b.get("place_id"),)).fetchone()
                if not p: return s.j(404, {"error": "unknown place"})
                far_ok = DEV_OVERRIDE and b.get("dev")
                try: dist = haversine(float(b["lat"]), float(b["lon"]), p["lat"], p["lon"])
                except Exception: dist = 1e9
                if dist > MAX_DIST_M and not far_ok:
                    return s.j(403, {"error": f"You need to be within {int(MAX_DIST_M)} m to report (you're ~{int(min(dist,99999))} m away)."})
                if c.execute("SELECT 1 FROM reports WHERE device=? AND place_id=? AND mode=? AND ts>?", (dev, p["id"], mode, now-600)).fetchone():
                    return s.j(429, {"error": "You already reported this one in the last 10 min."})
                if c.execute("SELECT COUNT(*) FROM reports WHERE device=? AND ts>?", (dev, now-3600)).fetchone()[0] >= 20:
                    return s.j(429, {"error": "Too many reports this hour."})
                cars = b.get("cars"); cars = int(cars) if isinstance(cars, int) and 0 <= cars <= 50 else None
                ts = now - float(b.get("age_min", 0))*60 if far_ok else now   # dev-only backdating for tests
                with lock:
                    c.execute("INSERT INTO reports(place_id,device,mode,wait_min,cars,lat,lon,ts) VALUES(?,?,?,?,?,?,?,?)",
                              (p["id"], dev, mode, w, cars, b.get("lat"), b.get("lon"), ts)); c.commit()
                return s.j(200, {"ok": True, "status": place_status(c, p, now)})
            if u.path == "/api/confirm":
                rid = int(b.get("report_id", 0))
                r = c.execute("SELECT * FROM reports WHERE id=?", (rid,)).fetchone()
                if not r: return s.j(404, {"error": "unknown report"})
                if r["device"] == dev: return s.j(400, {"error": "Can't confirm your own report."})
                if c.execute("SELECT COUNT(*) FROM confirms WHERE device=? AND ts>?", (dev, now-3600)).fetchone()[0] >= 30:
                    return s.j(429, {"error": "Slow down"})
                with lock:
                    c.execute("INSERT OR IGNORE INTO confirms VALUES(?,?,?)", (rid, dev, now)); c.commit()
                p = c.execute("SELECT * FROM places WHERE id=?", (r["place_id"],)).fetchone()
                return s.j(200, {"ok": True, "status": place_status(c, p, now)})
            return s.j(404, {"error": "not found"})
        finally: c.close()

if __name__ == "__main__":
    init(); print(f"{APP_NAME} on :{PORT} dev_override={DEV_OVERRIDE}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
