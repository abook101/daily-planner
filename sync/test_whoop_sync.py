"""Tests for the Whoop sync. No Whoop account or internet needed: every call to
Whoop is answered by a fake, and files go to a temporary folder.

Run (in the project folder):   python sync/test_whoop_sync.py
"""

import datetime as dt
import hashlib
import json
import shutil
import ssl
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import localcert  # noqa: E402
import whoop_sync as W  # noqa: E402

NOW = dt.datetime(2026, 11, 26, 9, 0, tzinfo=dt.timezone.utc)
CFG = dict(W.DEFAULTS, client_id="cid", client_secret="secret", sync_key="ABCD-EFGH-JKMN")


def sleep_rec(id_, end, offset="+01:00", nap=False, state="SCORED", perf=91):
    return {"id": id_, "nap": nap, "score_state": state, "start": "2026-11-25T23:00:00.000Z", "end": end,
            "timezone_offset": offset,
            "score": {"sleep_performance_percentage": perf,
                      "stage_summary": {"total_in_bed_time_milli": 8 * 3600000,
                                        "total_awake_time_milli": 30 * 60000,
                                        "total_no_data_time_milli": 0}}}


def recovery_rec(sleep_id, score=72, hrv=64.37, rhr=51.4, state="SCORED", created="2026-11-26T07:00:00.000Z"):
    return {"cycle_id": 1, "sleep_id": sleep_id, "score_state": state, "created_at": created,
            "updated_at": created,
            "score": {"user_calibrating": False, "recovery_score": score, "resting_heart_rate": rhr,
                      "hrv_rmssd_milli": hrv, "spo2_percentage": 96, "skin_temp_celsius": 33.1}}


class TempFiles(unittest.TestCase):
    """Points all the sync's files at a fresh temporary folder."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self._saved = (W.CONFIG_FILE, W.TOKENS_FILE, W.DATA_FILE, W.CERT_DIR)
        W.CONFIG_FILE = self.dir / "config.json"
        W.TOKENS_FILE = self.dir / "tokens.json"
        W.DATA_FILE = self.dir / "whoop-data.json"
        W.CERT_DIR = self.dir / "certs"
        W.log = lambda msg: None

    def tearDown(self):
        W.CONFIG_FILE, W.TOKENS_FILE, W.DATA_FILE, W.CERT_DIR = self._saved
        shutil.rmtree(self.dir, ignore_errors=True)


class FakeWhoop:
    """Answers like Whoop's API. Records every call."""

    def __init__(self, recoveries=(), sleeps=(), workouts=(), page_size=25):
        self.data = {"/v2/recovery": list(recoveries), "/v2/activity/sleep": list(sleeps),
                     "/v2/activity/workout": list(workouts)}
        self.page_size = page_size
        self.calls = []
        self.valid_token = "access-1"
        self.refresh_token = "refresh-1"
        self.refresh_status = 200
        self.n = 1

    def __call__(self, method, url, headers=None, form=None, timeout=20):
        self.calls.append((method, url, form))
        if url == W.TOKEN_URL:
            if self.refresh_status != 200:
                return self.refresh_status, {"error": "invalid_grant"}
            if form["refresh_token"] != self.refresh_token:
                return 400, {"error": "invalid_grant"}
            self.n += 1
            self.valid_token, self.refresh_token = "access-%d" % self.n, "refresh-%d" % self.n
            return 200, {"access_token": self.valid_token, "refresh_token": self.refresh_token,
                         "expires_in": 3600, "token_type": "bearer"}
        if (headers or {}).get("Authorization") != "Bearer " + self.valid_token:
            return 401, {"error": "unauthorized"}
        u = urllib.parse.urlparse(url)
        path = u.path.replace("/developer", "")
        q = urllib.parse.parse_qs(u.query)
        records = self.data[path]
        start = int(q.get("nextToken", ["0"])[0])
        page = records[start:start + self.page_size]
        nxt = str(start + self.page_size) if start + self.page_size < len(records) else None
        return 200, {"records": page, "next_token": nxt}



def save_tokens(access="access-1", refresh="refresh-1", expires_at=None):
    W.write_json(W.TOKENS_FILE, {"access_token": access, "refresh_token": refresh,
                                 "expires_at": expires_at if expires_at is not None else 10 ** 12})


class TestPayload(unittest.TestCase):
    def test_recovery_goes_on_the_day_you_woke_up_in_local_time(self):
        p = W.build_payload([recovery_rec("s1")], [sleep_rec("s1", "2026-11-26T06:30:00.000Z")], [], NOW)
        self.assertEqual(p["app"], "daily-planner-whoop")
        self.assertEqual(p["days"]["2026-11-26"],
                         {"recovery": 72, "hrv": 64.4, "rhr": 51, "sleepHours": 7.5, "sleepPerf": 91})

    def test_time_zone_offset_moves_the_day(self):
        # 23:30 UTC on the 26th is 00:30 on the 27th in +01:00 (Germany in winter)
        p = W.build_payload([recovery_rec("s1")], [sleep_rec("s1", "2026-11-26T23:30:00.000Z")], [], NOW)
        self.assertEqual(list(p["days"]), ["2026-11-27"])

    def test_pending_scores_and_naps_are_skipped(self):
        p = W.build_payload(
            [recovery_rec("s1", state="PENDING_SCORE")],
            [sleep_rec("s1", "2026-11-26T06:30:00.000Z"), sleep_rec("nap", "2026-11-26T14:00:00.000Z", nap=True)],
            [], NOW)
        day = p["days"]["2026-11-26"]
        self.assertIsNone(day["recovery"])
        self.assertEqual(day["sleepHours"], 7.5)  # the night's sleep, not the nap
        self.assertEqual(len(p["days"]), 1)

    def test_strange_numbers_are_dropped_not_sent(self):
        p = W.build_payload([recovery_rec("s1", score=140, hrv=0, rhr=51)],
                            [sleep_rec("s1", "2026-11-26T06:30:00.000Z")], [], NOW)
        d = p["days"]["2026-11-26"]
        self.assertEqual((d["recovery"], d["hrv"], d["rhr"]), (None, None, 51))

    def test_recovery_without_its_sleep_uses_when_it_was_scored(self):
        p = W.build_payload([recovery_rec("missing", created="2026-11-25T07:00:00.000Z")], [], [], NOW)
        self.assertIn("2026-11-25", p["days"])

    def test_workouts_are_summarised(self):
        w = {"start": "2026-11-25T17:00:00.000Z", "end": "2026-11-25T17:32:00.000Z", "timezone_offset": "+01:00",
             "sport_name": "running", "score": {"distance_meter": 5230, "strain": 9.87}}
        p = W.build_payload([], [], [w], NOW)
        self.assertEqual(p["workouts"], [{"date": "2026-11-25", "sport": "running", "minutes": 32,
                                          "distanceKm": 5.23, "strain": 9.9}])


class TestTokens(TempFiles):
    def test_valid_token_is_used_without_renewing(self):
        save_tokens(expires_at=10 ** 12)
        fake = FakeWhoop()
        self.assertEqual(W.Tokens(CFG, http=fake).access_token(), "access-1")
        self.assertEqual(fake.calls, [])

    def test_expired_token_is_renewed_and_the_new_refresh_token_saved(self):
        save_tokens(expires_at=0)
        fake = FakeWhoop()
        tokens = W.Tokens(CFG, http=fake, clock=lambda: 1000)
        self.assertEqual(tokens.access_token(), "access-2")
        saved = W.read_json(W.TOKENS_FILE)
        self.assertEqual(saved["refresh_token"], "refresh-2")  # Whoop rotates it: must keep the new one
        self.assertEqual(saved["expires_at"], 1000 + 3600)
        form = fake.calls[0][2]
        self.assertEqual((form["grant_type"], form["scope"]), ("refresh_token", "offline"))

    def test_revoked_login_gives_a_clear_message(self):
        save_tokens(expires_at=0)
        fake = FakeWhoop()
        fake.refresh_status = 400
        with self.assertRaises(W.SyncError) as e:
            W.Tokens(CFG, http=fake).access_token()
        self.assertIn("whoop_sync.py login", str(e.exception))

    def test_no_tokens_yet(self):
        with self.assertRaises(W.SyncError) as e:
            W.Tokens(CFG, http=FakeWhoop()).access_token()
        self.assertIn("login", str(e.exception))


class TestFetch(TempFiles):
    def test_401_renews_once_and_retries(self):
        save_tokens(access="stale", expires_at=10 ** 12)  # looks valid, Whoop says no
        fake = FakeWhoop(recoveries=[recovery_rec("s1")])
        client = W.WhoopClient(CFG, W.Tokens(CFG, http=fake), http=fake)
        recs = client.collection("/v2/recovery", NOW - dt.timedelta(days=14), NOW)
        self.assertEqual(len(recs), 1)
        self.assertEqual(W.read_json(W.TOKENS_FILE)["refresh_token"], "refresh-2")

    def test_reads_every_page(self):
        save_tokens()
        sleeps = [sleep_rec("s%d" % i, "2026-11-%02dT06:30:00.000Z" % (i + 1)) for i in range(12)]
        fake = FakeWhoop(sleeps=sleeps, page_size=5)
        client = W.WhoopClient(CFG, W.Tokens(CFG, http=fake), http=fake)
        self.assertEqual(len(client.collection("/v2/activity/sleep", NOW - dt.timedelta(days=30), NOW)), 12)
        self.assertEqual(len(fake.calls), 3)

    def test_fetch_saves_the_file_for_the_phone(self):
        save_tokens()
        fake = FakeWhoop(recoveries=[recovery_rec("s1")], sleeps=[sleep_rec("s1", "2026-11-26T06:30:00.000Z")])
        p = W.fetch(CFG, http=fake, now=NOW)
        self.assertEqual(W.read_json(W.DATA_FILE), p)
        self.assertEqual(p["days"]["2026-11-26"]["recovery"], 72)
        url = fake.calls[0][1]
        self.assertTrue(url.startswith("https://api.prod.whoop.com/developer/v2/recovery?"))
        self.assertIn("start=2026-11-11T09", url)


class TestCertsAndServer(TempFiles):
    def test_new_address_gets_a_new_server_certificate_but_the_same_ca(self):
        W.ensure_certs(["192.168.1.23"], now=NOW)
        ca_before = (W.CERT_DIR / "ca.crt").read_text()
        srv_before = (W.CERT_DIR / "server.crt").read_text()
        W.ensure_certs(["192.168.1.23"], now=NOW)
        self.assertEqual((W.CERT_DIR / "server.crt").read_text(), srv_before, "same address: keep it")
        W.ensure_certs(["192.168.1.40"], now=NOW)
        self.assertEqual((W.CERT_DIR / "ca.crt").read_text(), ca_before, "iPhone keeps trusting the same CA")
        self.assertNotEqual((W.CERT_DIR / "server.crt").read_text(), srv_before)
        self.assertIn("192.168.1.40", W.read_json(W.CERT_DIR / "server.json")["ips"])

    def test_phone_request_over_https_with_key(self):
        srv_crt, srv_key, ca_crt = W.ensure_certs([])
        payload = {"app": "daily-planner-whoop", "version": 1, "days": {"2026-11-26": {"recovery": 72}}, "workouts": []}
        state = W.SyncState(CFG, fetch_fn=lambda: payload)
        server = W.QuietServer(("127.0.0.1", 0), W.make_handler(state, CFG["sync_key"]))
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(srv_crt), str(srv_key))
        server.socket = ctx.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            client_ctx = ssl.create_default_context(cafile=str(ca_crt))  # like an iPhone that trusts our CA

            def get(key):
                url = "https://localhost:%d/whoop.json?key=%s" % (port, key)
                try:
                    with urllib.request.urlopen(url, context=client_ctx, timeout=10) as r:
                        return r.status, dict(r.headers), json.loads(r.read())
                except urllib.error.HTTPError as e:
                    return e.code, dict(e.headers), json.loads(e.read())

            status, _, body = get("WRONG")
            self.assertEqual(status, 403)
            status, headers, body = get("abcd-efgh%20jkmn")  # spaces / lower case are fine
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
            self.assertEqual(body["days"]["2026-11-26"]["recovery"], 72)
            self.assertIsNone(body["laptopError"])
        finally:
            server.shutdown()
            server.server_close()

    def test_failed_download_keeps_old_data_and_reports_it(self):
        def boom():
            raise W.SyncError("Can't reach Whoop")
        state = W.SyncState(CFG, fetch_fn=boom)
        state.payload = {"app": "daily-planner-whoop", "version": 1, "days": {"2026-11-25": {"recovery": 50}}}
        state.refresh_if_old(0)
        r = state.response()
        self.assertEqual(r["days"]["2026-11-25"]["recovery"], 50)
        self.assertIn("Can't reach Whoop", r["laptopError"])


class TestLogin(TempFiles):
    def test_browser_login_saves_tokens(self):
        import socket
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        cfg = dict(CFG, login_port=port)
        sent = {}

        def fake_http(method, url, headers=None, form=None, timeout=20):
            sent.update(form)
            return 200, {"access_token": "a1", "refresh_token": "r1", "expires_in": 3600}

        old = (W.http_request, W.secrets.token_hex)
        W.http_request, W.secrets.token_hex = fake_http, (lambda n: "abcd1234")
        try:
            t = threading.Thread(target=W.login, args=(cfg, False))
            t.start()
            for _ in range(50):  # wait for the little login server to start
                try:
                    url = "http://127.0.0.1:%d/callback?code=THE-CODE&state=abcd1234" % port
                    with urllib.request.urlopen(url, timeout=5) as r:
                        self.assertIn("Whoop is connected", r.read().decode())
                    break
                except urllib.error.URLError:
                    threading.Event().wait(0.1)
            t.join(10)
        finally:
            W.http_request, W.secrets.token_hex = old
        self.assertEqual(sent["grant_type"], "authorization_code")
        self.assertEqual(sent["code"], "THE-CODE")
        self.assertEqual(sent["redirect_uri"], "http://localhost:%d/callback" % port)
        self.assertEqual(W.read_json(W.TOKENS_FILE)["refresh_token"], "r1")


class TestSmallThings(unittest.TestCase):
    def test_sync_key_is_easy_to_type(self):
        k = W.new_sync_key()
        self.assertRegex(k, r"^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$")
        self.assertEqual(W.normalize_key(" abcd-efgh jkmn "), "ABCDEFGHJKMN")

    def test_signature_checks_out(self):
        key = localcert.generate_rsa_key(1024)
        sig = int.from_bytes(localcert.rsa_sign_sha256(key, b"hello"), "big")
        em = pow(sig, key["e"], key["n"]).to_bytes(128, "big")
        self.assertTrue(em.startswith(b"\x00\x01\xff"))
        self.assertTrue(em.endswith(hashlib.sha256(b"hello").digest()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
