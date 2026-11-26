"""Whoop -> Daily Planner sync (runs on the laptop).

What it does
------------
1. Logs in to YOUR Whoop account through Whoop's official developer API
   (the normal "Allow access?" page in your browser). No password is stored.
2. Downloads the last 14 days of recovery %, HRV, resting heart rate, sleep
   and workouts, and saves them in sync/whoop-data.json.
3. Runs a small https server on the laptop. When the planner app on the
   iPhone is opened on the same Wi-Fi, it asks the laptop for that file.

Only Python's standard library is used: nothing to install.

Commands (run them in the project folder, in a terminal):
  python sync/whoop_sync.py setup        first time: Whoop app keys + login
  python sync/whoop_sync.py login        log in to Whoop again
  python sync/whoop_sync.py fetch        download now and show what came back
  python sync/whoop_sync.py serve        keep running: phone can sync (Ctrl+C stops)
  python sync/whoop_sync.py phone-setup  page for the iPhone's one-time setup
  python sync/whoop_sync.py status       show what is set up

Private files (all ignored by git, never commit them):
  sync/config.json   Whoop client id + secret, sync key, ports
  sync/tokens.json   Whoop login tokens (renewed automatically)
  sync/certs/        the home-made https certificates (see localcert.py)
  sync/whoop-data.json  the downloaded numbers
"""

import datetime as dt
import hmac
import http.server
import json
import os
import secrets
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import localcert  # noqa: E402  (our own file, next to this one)

CONFIG_FILE = HERE / "config.json"
TOKENS_FILE = HERE / "tokens.json"
DATA_FILE = HERE / "whoop-data.json"
CERT_DIR = HERE / "certs"

AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
DEFAULTS = {
    "api_base": "https://api.prod.whoop.com/developer",
    "login_port": 8722,     # http://localhost:8722/callback  (Whoop sends you back here after login)
    "sync_port": 8765,      # https://<laptop>:8765/whoop.json (the phone asks here)
    "setup_port": 8766,     # http://<laptop>:8766/  (one-time iPhone certificate page)
    "days": 14,             # how many days to download
    "refresh_minutes": 30,  # how often `serve` downloads again
}
SCOPES = "offline read:recovery read:cycles read:sleep read:workout"
PAYLOAD_APP = "daily-planner-whoop"
PAYLOAD_VERSION = 1


class SyncError(Exception):
    """A problem with a plain-English message for Jad."""


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# =============================================================== files

def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path, obj):
    """Write to a temporary file, then swap it in, so a crash never leaves half a file."""
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_config():
    cfg = read_json(CONFIG_FILE)
    if not cfg or not cfg.get("client_id") or not cfg.get("client_secret"):
        raise SyncError("Not set up yet. Run:  python sync/whoop_sync.py setup")
    for k, what in (("client_id", "Client ID"), ("client_secret", "Client Secret")):
        try:
            clean_key_text(cfg[k], what)
        except SyncError as err:
            raise SyncError(str(err).replace("Run setup again", "Run  python sync/whoop_sync.py setup  again"))
    if not cfg.get("sync_key"):
        cfg["sync_key"] = new_sync_key()
        write_json(CONFIG_FILE, cfg)
    return dict(DEFAULTS, **cfg)


def redirect_uri(cfg):
    return "http://localhost:%d/callback" % cfg["login_port"]


def new_sync_key():
    # 12 easy-to-type characters (no 0/O or 1/I/L), shown as XXXX-XXXX-XXXX
    alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
    raw = "".join(secrets.choice(alphabet) for _ in range(12))
    return raw[:4] + "-" + raw[4:8] + "-" + raw[8:]


def normalize_key(k):
    return "".join(ch for ch in str(k or "").upper() if ch.isalnum())


# =============================================================== HTTP (one place, so tests can fake it)

def http_request(method, url, headers=None, form=None, timeout=20):
    """Returns (status code, parsed JSON or None). Never raises for HTTP errors."""
    data = urllib.parse.urlencode(form).encode() if form is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=dict(headers or {}))
    if form is not None:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "daily-planner-whoop-sync/1")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            status = resp.status
    except urllib.error.HTTPError as err:
        body = err.read()
        status = err.code
    except (urllib.error.URLError, socket.timeout, OSError) as err:
        raise SyncError("Can't reach Whoop (%s). Is the laptop online?" % getattr(err, "reason", err))
    try:
        return status, json.loads(body.decode("utf-8")) if body else None
    except ValueError:
        return status, None


# =============================================================== login + tokens

def save_tokens(resp, now):
    if not resp or "access_token" not in resp:
        raise SyncError("Whoop didn't send a login token back.")
    tokens = {
        "access_token": resp["access_token"],
        "refresh_token": resp.get("refresh_token"),
        "expires_at": now + int(resp.get("expires_in", 3600)),
        "saved_at": dt.datetime.fromtimestamp(now).isoformat(timespec="seconds"),
    }
    write_json(TOKENS_FILE, tokens)
    return tokens


class Tokens:
    """Gives a valid access token, renewing it automatically when it runs out.

    Whoop hands out a NEW refresh token on every renewal and the old one stops
    working, so the new one is saved straight away, and only one renewal runs
    at a time (the lock).
    """

    def __init__(self, cfg, http=None, clock=time.time):
        self.cfg = cfg
        self.http = http or http_request
        self.clock = clock
        self.lock = threading.Lock()

    def _load(self):
        t = read_json(TOKENS_FILE)
        if not t or not t.get("access_token"):
            raise SyncError("Not logged in to Whoop. Run:  python sync/whoop_sync.py login")
        return t

    def access_token(self, force_refresh=False):
        with self.lock:
            t = self._load()
            if not force_refresh and t.get("expires_at", 0) - 120 > self.clock():
                return t["access_token"]
            return self._refresh(t)["access_token"]

    def _refresh(self, t):
        if not t.get("refresh_token"):
            raise SyncError("Whoop login has expired. Run:  python sync/whoop_sync.py login")
        status, resp = self.http("POST", TOKEN_URL, form={
            "grant_type": "refresh_token",
            "refresh_token": t["refresh_token"],
            "client_id": self.cfg["client_id"],
            "client_secret": self.cfg["client_secret"],
            "scope": "offline",
        })
        if status in (400, 401):
            raise SyncError("Whoop refused to renew the login (it may have been revoked). "
                            "Run:  python sync/whoop_sync.py login")
        if status != 200:
            raise SyncError("Whoop's login server had a problem (HTTP %s). Will try again later." % status)
        log("Whoop login renewed.")
        return save_tokens(resp, self.clock())


def login(cfg, open_browser=True):
    """The one-time 'Allow access?' step. Opens Whoop in the browser and waits
    for Whoop to send the browser back to http://localhost:<login_port>/callback."""
    state = secrets.token_hex(4)  # Whoop wants exactly 8 characters
    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "response_type": "code",
        "client_id": cfg["client_id"],
        "redirect_uri": redirect_uri(cfg),
        "scope": SCOPES,
        "state": state,
    })
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if not self.path.startswith("/callback"):
                self.send_response(404)
                self.end_headers()
                return
            if q.get("state", [""])[0] != state:
                result["error"] = "Security check failed (state didn't match). Try again."
            elif "error" in q:
                result["error"] = "Whoop said: " + q.get("error_description", q["error"])[0]
            else:
                result["code"] = q.get("code", [""])[0]
            ok = "code" in result
            page = ("<h2>Done! Whoop is connected.</h2><p>You can close this tab and go back to the terminal.</p>"
                    if ok else "<h2>Login didn't work</h2><p>%s</p>" % result.get("error", ""))
            body = ("<!doctype html><meta charset=utf-8><body style='font-family:sans-serif;margin:40px'>" + page).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)

    try:
        server = http.server.HTTPServer(("127.0.0.1", cfg["login_port"]), Handler)
    except OSError:
        raise SyncError("Port %d is busy. Close other sync windows and try again." % cfg["login_port"])
    server.timeout = 1
    print("\nOpening Whoop in your browser. Log in and press 'Allow'.")
    print("If no browser opens, copy this address into one:\n\n  " + url + "\n")
    if open_browser:
        webbrowser.open(url)
    deadline = time.time() + 300
    while not result and time.time() < deadline:
        server.handle_request()
    server.server_close()
    if "error" in result:
        raise SyncError(result["error"])
    if not result.get("code"):
        raise SyncError("Gave up waiting for the Whoop login (5 minutes).")

    status, resp = http_request("POST", TOKEN_URL, form={
        "grant_type": "authorization_code",
        "code": result["code"],
        "redirect_uri": redirect_uri(cfg),
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
    })
    if status != 200:
        raise SyncError("Whoop didn't accept the login (HTTP %s: %s). Check the client id/secret "
                        "and that the redirect URL in the Whoop dashboard is exactly %s"
                        % (status, (resp or {}).get("error_description", resp), redirect_uri(cfg)))
    save_tokens(resp, time.time())
    if not resp.get("refresh_token"):
        print("Note: Whoop sent no refresh token, so you'd have to log in again every hour.")
    print("Logged in to Whoop. Tokens saved in sync/tokens.json (private, not in git).")


# =============================================================== downloading

class WhoopClient:
    def __init__(self, cfg, tokens, http=None):
        self.cfg = cfg
        self.tokens = tokens
        self.http = http or http_request

    def _get(self, path, params):
        url = self.cfg["api_base"].rstrip("/") + path + "?" + urllib.parse.urlencode(params)
        for attempt in (1, 2):
            token = self.tokens.access_token(force_refresh=(attempt == 2))
            status, body = self.http("GET", url, headers={"Authorization": "Bearer " + token})
            if status == 401 and attempt == 1:
                continue  # token no longer valid: renew once and retry
            if status == 429:
                raise SyncError("Whoop says: too many requests. Will try again later.")
            if status != 200:
                raise SyncError("Whoop API error on %s (HTTP %s)." % (path, status))
            return body or {}
        raise SyncError("Whoop keeps refusing the login. Run:  python sync/whoop_sync.py login")

    def collection(self, path, start, end, max_pages=20):
        """All records between start and end (Whoop sends max 25 per page)."""
        records, token = [], None
        for _ in range(max_pages):
            params = {"start": iso_z(start), "end": iso_z(end), "limit": 25}
            if token:
                params["nextToken"] = token
            body = self._get(path, params)
            records.extend(body.get("records") or [])
            token = body.get("next_token") or body.get("nextToken")
            if not token:
                break
        return records


def iso_z(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def parse_time(s):
    return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))


def local_date(timestamp, offset=None):
    """The calendar day of a Whoop time, in the time zone it was recorded in
    (e.g. '+01:00'), or in the laptop's time zone if Whoop didn't say."""
    t = parse_time(timestamp)
    if offset:
        sign = -1 if offset.startswith("-") else 1
        hh, mm = offset.lstrip("+-").split(":")[:2]
        tz = dt.timezone(sign * dt.timedelta(hours=int(hh), minutes=int(mm)))
        return t.astimezone(tz).date().isoformat()
    return t.astimezone().date().isoformat()


def _num(x, lo, hi, digits=0):
    """Rounded number if it's in a sensible range, else None (same limits as the app)."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    if not lo <= x <= hi:
        return None
    return int(round(x)) if digits == 0 else round(float(x), digits)


def build_payload(recoveries, sleeps, workouts, now=None):
    """Turns Whoop's records into one small file for the app:
    { days: { "2026-11-26": { recovery, hrv, rhr, sleepHours, sleepPerf } }, workouts: [...] }

    Which day is a recovery for? The morning you woke up: the end of the
    night's sleep, in local time. (Falls back to when Whoop scored it.)
    """
    now = now or dt.datetime.now(dt.timezone.utc)
    days = {}

    def day(d):
        return days.setdefault(d, {"recovery": None, "hrv": None, "rhr": None,
                                   "sleepHours": None, "sleepPerf": None})

    sleep_day = {}
    for s in sorted(sleeps, key=lambda s: s.get("end") or ""):
        if s.get("nap") or s.get("score_state") != "SCORED" or not s.get("end"):
            continue
        d = local_date(s["end"], s.get("timezone_offset"))
        sleep_day[str(s.get("id"))] = d
        score = s.get("score") or {}
        st = score.get("stage_summary") or {}
        asleep_ms = (st.get("total_in_bed_time_milli") or 0) - (st.get("total_awake_time_milli") or 0) \
            - (st.get("total_no_data_time_milli") or 0)
        entry = day(d)
        if asleep_ms > 0:
            entry["sleepHours"] = _num(asleep_ms / 3600000, 0, 24, 1)
        entry["sleepPerf"] = _num(score.get("sleep_performance_percentage"), 0, 100)

    for r in sorted(recoveries, key=lambda r: r.get("updated_at") or r.get("created_at") or ""):
        if r.get("score_state") != "SCORED":
            continue  # still being calculated, or Whoop couldn't score it
        d = sleep_day.get(str(r.get("sleep_id")))
        if not d and r.get("created_at"):
            d = local_date(r["created_at"])
        if not d:
            continue
        sc = r.get("score") or {}
        entry = day(d)
        entry["recovery"] = _num(sc.get("recovery_score"), 0, 100)
        entry["hrv"] = _num(sc.get("hrv_rmssd_milli"), 1, 300, 1)
        entry["rhr"] = _num(sc.get("resting_heart_rate"), 25, 150)

    out_workouts = []
    for w in workouts:
        if not w.get("start") or not w.get("end"):
            continue
        sc = w.get("score") or {}
        minutes = (parse_time(w["end"]) - parse_time(w["start"])).total_seconds() / 60
        out_workouts.append({
            "date": local_date(w["start"], w.get("timezone_offset")),
            "sport": w.get("sport_name") or ("sport %s" % w.get("sport_id")),
            "minutes": int(round(minutes)),
            "distanceKm": _num((sc.get("distance_meter") or 0) / 1000, 0.01, 1000, 2),
            "strain": _num(sc.get("strain"), 0, 21, 1),
        })
    out_workouts.sort(key=lambda w: w["date"])

    return {
        "app": PAYLOAD_APP,
        "version": PAYLOAD_VERSION,
        "generatedAt": iso_z(now),
        "days": dict(sorted(days.items())),
        "workouts": out_workouts,
    }


def fetch(cfg, http=None, now=None):
    """Downloads from Whoop, saves sync/whoop-data.json and returns it."""
    now = now or dt.datetime.now(dt.timezone.utc)
    client = WhoopClient(cfg, Tokens(cfg, http=http), http=http)
    start = now - dt.timedelta(days=int(cfg["days"]) + 1)
    recoveries = client.collection("/v2/recovery", start, now)
    sleeps = client.collection("/v2/activity/sleep", start, now)
    workouts = client.collection("/v2/activity/workout", start, now)
    payload = build_payload(recoveries, sleeps, workouts, now)
    write_json(DATA_FILE, payload)
    return payload


def print_payload(p):
    print("\nDay          Recovery  HRV    Rest HR  Sleep")
    for d, v in p["days"].items():
        f = lambda x, u="": "-" if x is None else "%s%s" % (x, u)  # noqa: E731
        print("%-12s %-9s %-6s %-8s %s" % (d, f(v["recovery"], "%"), f(v["hrv"]), f(v["rhr"]),
                                          f(v["sleepHours"], " h")))
    print("\n%d workouts. Saved in sync/whoop-data.json" % len(p["workouts"]))


# =============================================================== certificates

def lan_addresses():
    """The laptop's addresses on the home Wi-Fi (e.g. 192.168.1.23)."""
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # sends nothing; just picks the outgoing network
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except OSError:
        pass
    return [ip for ip in ips if not ip.startswith("127.")]


def ensure_certs(ips, now=None):
    """Makes the CA once, and a server certificate covering the laptop's
    current addresses (made again if the address changed or it's nearly expired)."""
    CERT_DIR.mkdir(exist_ok=True)
    ca_crt, ca_key = CERT_DIR / "ca.crt", CERT_DIR / "ca.key"
    srv_crt, srv_key, srv_info = CERT_DIR / "server.crt", CERT_DIR / "server.key", CERT_DIR / "server.json"
    now = now or dt.datetime.now(dt.timezone.utc)

    if not ca_crt.exists() or not ca_key.exists():
        log("Making the home certificate authority (once)...")
        key = localcert.generate_rsa_key()
        ca_key.write_text(localcert.key_pem(key), encoding="ascii")
        ca_crt.write_text(localcert.cert_pem(localcert.make_ca(key, now=now)), encoding="ascii")
        if srv_info.exists():
            srv_info.unlink()
    ca = localcert.read_key_pem(ca_key.read_text(encoding="ascii"))

    want = sorted(set(ips) | {"127.0.0.1"})
    host = socket.gethostname().lower()
    names = sorted({"localhost", host, host + ".local"})
    info = read_json(srv_info, {})
    expires = info.get("expires")
    fresh = expires and parse_time(expires) - now > dt.timedelta(days=30)
    if not (srv_crt.exists() and srv_key.exists() and fresh and set(want) <= set(info.get("ips", []))):
        log("Making the laptop's https certificate for %s ..." % ", ".join(want))
        key = localcert.generate_rsa_key()
        der = localcert.make_server_cert(key, ca, want, names, days=397, now=now)
        srv_key.write_text(localcert.key_pem(key), encoding="ascii")
        srv_crt.write_text(localcert.cert_pem(der), encoding="ascii")
        write_json(srv_info, {"ips": want, "names": names,
                              "expires": iso_z(now + dt.timedelta(days=397))})
    return srv_crt, srv_key, ca_crt


def update_cert_if_address_changed(ctx, known_ips, port, lan_fn=None, now=None):
    """Called every minute by serve(). If the laptop got a new Wi-Fi address
    (started before Wi-Fi was up, router restart, other network), makes a
    certificate that covers it and switches to it without restarting.
    Returns the addresses the current certificate covers."""
    ips = (lan_fn or lan_addresses)()
    if not ips or set(ips) <= set(known_ips):
        return known_ips
    srv_crt, srv_key, _ = ensure_certs(ips, now=now)
    ctx.load_cert_chain(str(srv_crt), str(srv_key))
    for ip in ips:
        log("Laptop address is now %s:%d (if the app can't reach the laptop, use this in its Settings)." % (ip, port))
    return ips


# =============================================================== the sync server

class SyncState:
    """Keeps the latest download in memory and refreshes it when it gets old."""

    def __init__(self, cfg, fetch_fn=None, clock=time.time):
        self.cfg = cfg
        self.fetch_fn = fetch_fn or (lambda: fetch(cfg))
        self.clock = clock
        self.lock = threading.Lock()
        self.payload = read_json(DATA_FILE)
        self.fetched_at = 0
        self.last_error = None

    def refresh_if_old(self, max_age_s):
        with self.lock:
            if self.payload and self.clock() - self.fetched_at < max_age_s:
                return
            try:
                self.payload = self.fetch_fn()
                self.fetched_at = self.clock()
                self.last_error = None
                log("Downloaded from Whoop: %d days." % len(self.payload.get("days", {})))
            except SyncError as err:
                self.last_error = str(err)
                self.fetched_at = self.clock() - max_age_s + 300  # don't retry for 5 minutes
                log("Whoop download failed: %s" % err)

    def response(self):
        p = dict(self.payload or {"app": PAYLOAD_APP, "version": PAYLOAD_VERSION, "days": {}, "workouts": []})
        p["laptopError"] = self.last_error
        return p


def make_handler(state, sync_key):
    want = normalize_key(sync_key)

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status, obj):
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):  # browsers may ask first ("preflight")
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.end_headers()

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            if u.path == "/":
                return self._send(200, {"ok": True, "app": PAYLOAD_APP,
                                        "hint": "The planner app asks /whoop.json?key=..."})
            if u.path != "/whoop.json":
                return self._send(404, {"error": "not found"})
            key = urllib.parse.parse_qs(u.query).get("key", [""])[0]
            if not hmac.compare_digest(normalize_key(key), want):
                log("Refused a request with a wrong sync key from %s" % self.client_address[0])
                return self._send(403, {"error": "Wrong sync key. Check it in the app's Settings."})
            # Old data (laptop was asleep, etc.)? Download first; it takes a few seconds.
            state.refresh_if_old(20 * 60)
            log("Sent Whoop data to %s" % self.client_address[0])
            return self._send(200, state.response())

    return Handler


class QuietServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # e.g. an iPhone that doesn't trust the certificate yet: one line, not a wall of text
        err = sys.exc_info()[1]
        log("Connection from %s failed: %s" % (client_address[0], err.__class__.__name__ + (": %s" % err if str(err) else "")))
        if isinstance(err, ssl.SSLError):
            log("  (If that's the iPhone: is the certificate installed AND trusted? See sync/README.md step 3.)")


def serve(cfg):
    ips = lan_addresses()
    srv_crt, srv_key, _ = ensure_certs(ips)
    state = SyncState(cfg)
    state.refresh_if_old(0)

    try:
        server = QuietServer(("0.0.0.0", cfg["sync_port"]), make_handler(state, cfg["sync_key"]))
    except OSError:
        raise SyncError("Port %d is busy. Is the sync already running in another window?" % cfg["sync_port"])
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(str(srv_crt), str(srv_key))
    # Handshake in each request's own thread, so one slow phone can't block the others.
    server.socket = ctx.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)

    def background():
        known = ips
        while True:
            time.sleep(60)
            try:
                known = update_cert_if_address_changed(ctx, known, cfg["sync_port"])
            except Exception as err:  # never let this stop the Whoop downloads
                log("Couldn't update the certificate for a new address: %s" % err)
            state.refresh_if_old(int(cfg["refresh_minutes"]) * 60)

    threading.Thread(target=background, daemon=True).start()
    print("\nWhoop sync is running. Leave this window open (minimised is fine).")
    print("In the planner app > Settings > Laptop sync, use:")
    for ip in ips or ["(no Wi-Fi address found: is the laptop on Wi-Fi?)"]:
        print("   Laptop address:  %s:%d" % (ip, cfg["sync_port"]))
    print("   Sync key:        %s" % cfg["sync_key"])
    print("Press Ctrl+C to stop.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


# =============================================================== one-time iPhone page

def phone_setup(cfg):
    ips = lan_addresses()
    _, _, ca_crt = ensure_certs(ips)
    ip = ips[0] if ips else "<laptop address>"
    page = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">
<title>Planner sync setup</title>
<body style="font-family:-apple-system,sans-serif;margin:20px;line-height:1.5">
<h2>Planner: laptop sync setup</h2>
<p><b>Do this in Safari</b> (not Chrome).</p>
<ol>
<li><a href="/ca.crt" style="font-size:1.2em">Tap here to download the certificate</a>.
 Tap <b>Allow</b>, then <b>Close</b>.</li>
<li>Open <b>Settings</b> &rarr; tap <b>Profile Downloaded</b> (near the top) &rarr; <b>Install</b>
 (enter your passcode) &rarr; <b>Install</b> &rarr; <b>Done</b>.</li>
<li>Open <b>Settings &rarr; General &rarr; About &rarr; Certificate Trust Settings</b> (at the very bottom)
 and switch ON <b>Daily Planner home sync CA</b>.</li>
<li>In the planner app: <b>Settings &rarr; Laptop sync</b>, type<br>
 Laptop address: <b>%s:%d</b><br>Sync key: <b>%s</b><br>and tap <b>Save &amp; test</b>.</li>
</ol>
<p style="color:#666">This certificate only lets your iPhone check it's really talking to your laptop.
It was made on your laptop and works only for it.</p>
""" % (ip, cfg["sync_port"], cfg["sync_key"])

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path.startswith("/ca.crt"):
                body = ca_crt.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-x509-ca-cert")
                self.send_header("Content-Disposition", 'attachment; filename="planner-home-ca.crt"')
            else:
                body = page.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            log("iPhone setup page: sent %s to %s" % (self.path, self.client_address[0]))

    try:
        server = QuietServer(("0.0.0.0", cfg["setup_port"]), Handler)
    except OSError:
        raise SyncError("Port %d is busy. Is phone-setup already running in another window?" % cfg["setup_port"])
    print("\nOn the iPhone (same Wi-Fi), open Safari and go to:\n")
    print("   http://%s:%d\n" % (ip, cfg["setup_port"]))
    print("Follow the steps on that page. Press Ctrl+C here when you're done.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


# =============================================================== setup + status

def clean_key_text(text, what):
    """Client ID / Secret as typed or pasted: spaces trimmed. Invisible control
    characters (which some terminals add when pasting) are refused with a clear message."""
    t = (text or "").strip()
    bad = [ch for ch in t if not ch.isprintable() or ch.isspace()]
    if bad:
        raise SyncError("The %s has %d invisible or space character(s) in it, so it got mangled while pasting. "
                        "Run setup again and paste it once (right-click paste), then press Enter." % (what, len(bad)))
    return t


def setup():
    print("Whoop sync setup. You need the Client ID and Client Secret from")
    print("https://developer-dashboard.whoop.com (see sync/README.md, step 1).\n")
    cfg = dict(DEFAULTS, **(read_json(CONFIG_FILE) or {}))
    cid = clean_key_text(input("Client ID%s: " % (" [Enter = keep current]" if cfg.get("client_id") else "")), "Client ID")
    if cid:
        cfg["client_id"] = cid
    # Shown while typing on purpose: hidden input on Windows can silently add
    # invisible characters (e.g. from Ctrl+V or Backspace), which breaks the login.
    print("Paste the Client Secret (right-click or Ctrl+V), then press Enter. It's only saved on this laptop.")
    secret = clean_key_text(input("Client Secret%s: " % (" [Enter = keep current]" if cfg.get("client_secret") else "")),
                            "Client Secret")
    if secret:
        cfg["client_secret"] = secret
    if not cfg.get("client_id") or not cfg.get("client_secret"):
        raise SyncError("Both Client ID and Client Secret are needed.")
    cfg.setdefault("sync_key", new_sync_key())
    write_json(CONFIG_FILE, cfg)
    print("Saved in sync/config.json (private, not in git).")
    print("Redirect URL that must be in the Whoop dashboard:  " + redirect_uri(cfg))
    login(cfg)
    payload = fetch(cfg)
    print_payload(payload)
    print("\nNext: python sync/whoop_sync.py phone-setup   (one-time iPhone step)")


def status():
    cfg = read_json(CONFIG_FILE) or {}
    t = read_json(TOKENS_FILE) or {}
    p = read_json(DATA_FILE) or {}
    print("Whoop app keys:   %s" % ("saved" if cfg.get("client_id") else "missing (run setup)"))
    print("Whoop login:      %s" % ("yes, saved %s" % t.get("saved_at") if t.get("refresh_token") else "no (run login)"))
    print("Last download:    %s (%d days)" % (p.get("generatedAt", "never"), len(p.get("days", {}))))
    print("Laptop address:   %s" % ", ".join("%s:%s" % (ip, cfg.get("sync_port", DEFAULTS["sync_port"]))
                                              for ip in lan_addresses()))
    print("Sync key:         %s" % cfg.get("sync_key", "-"))
    print("iPhone cert made: %s" % ("yes" if (CERT_DIR / "ca.crt").exists() else "no (run phone-setup)"))


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "help"
    try:
        if cmd == "setup":
            setup()
        elif cmd == "login":
            login(load_config())
        elif cmd == "fetch":
            print_payload(fetch(load_config()))
        elif cmd == "serve":
            serve(load_config())
        elif cmd == "phone-setup":
            phone_setup(load_config())
        elif cmd == "status":
            status()
        else:
            print(__doc__)
            return 0 if cmd in ("help", "-h", "--help") else 2
    except SyncError as err:
        print("\nProblem: %s" % err)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
