#!/usr/bin/env python3
"""End-to-end check of the Rust meeting pipeline with real speech recognition.

Runs the cap-server Docker image (local Whisper) against the test Postgres and
LocalStack S3+KMS from docker-compose.test.yml, plays Calari's part with a
local receiver that verifies every signature, and asserts that synthetic
speech comes back as text. No real meeting, client or Calari system is used.

  python3 tests/rust-e2e/meeting_e2e.py --audio-dir DIR --model PATH
"""
import argparse, base64, hashlib, hmac, http.server, json, os, secrets, subprocess, threading, time, urllib.request, uuid, wave

ap = argparse.ArgumentParser()
ap.add_argument("--audio-dir", required=True)
ap.add_argument("--model", required=True)
ap.add_argument("--image", default="cap-server:dev")
args = ap.parse_args()

SECRET = secrets.token_bytes(32)
KEY_ID = "calari-e2e"
TENANT = "00000000-0000-4000-8000-000000000001"
CLIENT = str(uuid.uuid4())
RECEIPT = str(uuid.uuid4())
PORT, RECV_PORT = 8788, 9911
BASE = f"http://127.0.0.1:{PORT}"
received = []


def sign(purpose, ts, nonce, body):
    msg = f"cap.v1.{purpose}\n{ts}\n{nonce}\n".encode() + body
    return "sha256=" + hmac.new(SECRET, msg, hashlib.sha256).hexdigest()


class Receiver(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["content-length"]))
        h = self.headers
        ok = hmac.compare_digest(sign("delivery", h["x-cap-timestamp"], h["x-cap-nonce"], body), h["x-cap-signature-256"])
        ok = ok and abs(time.time() - int(h["x-cap-timestamp"])) <= 300
        ok = ok and h["x-cap-content-sha256"] == hashlib.sha256(body).hexdigest()
        received.append({"verified": ok, "body": json.loads(body), "delivery_id": h["x-cap-delivery-id"]})
        self.send_response(200 if ok else 401)
        self.end_headers()
        self.wfile.write(json.dumps({"receipt_id": "e2e-receipt-1", "status": "accepted"}).encode())

    def log_message(self, *a):
        pass


def sh(*cmd, check=True):
    return subprocess.run(cmd, check=check, capture_output=True, text=True).stdout.strip()


def req(method, path, body=None, token=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    if token:
        r.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=30) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


aws = ["docker", "run", "--rm", "--network", "host", "-e", "AWS_ACCESS_KEY_ID=test", "-e", "AWS_SECRET_ACCESS_KEY=test",
       "-e", "AWS_DEFAULT_REGION=us-east-1", "amazon/aws-cli:2.17.0", "--endpoint-url", "http://127.0.0.1:4566"]
print("== setup")
sh("docker", "exec", "cap-postgres-test-1", "psql", "-U", "cap", "-d", "cap_test", "-c", "DROP DATABASE IF EXISTS cap_e2e WITH (FORCE)")
sh("docker", "exec", "cap-postgres-test-1", "psql", "-U", "cap", "-d", "cap_test", "-c", "CREATE DATABASE cap_e2e")
sh(*aws, "s3", "mb", "s3://cap-e2e", check=False)
kms_arn = json.loads(sh(*aws, "kms", "create-key"))["KeyMetadata"]["Arn"]

threading.Thread(target=http.server.HTTPServer(("127.0.0.1", RECV_PORT), Receiver).serve_forever, daemon=True).start()
integrations = json.dumps([{ "key_id": KEY_ID, "tenant_id": TENANT,
    "secret": base64.urlsafe_b64encode(SECRET).rstrip(b"=").decode(), "delivery_url": f"http://127.0.0.1:{RECV_PORT}/deliver" }])
sh("docker", "rm", "-f", "cap-server-e2e", check=False)
sh("docker", "run", "-d", "--name", "cap-server-e2e", "--network", "host",
   "-v", f"{os.path.abspath(args.model)}:/models/{os.path.basename(args.model)}:ro",
   "-e", f"CAP_SERVER_BIND=127.0.0.1:{PORT}", "-e", "DATABASE_URL=postgres://cap:cap@127.0.0.1:5433/cap_e2e",
   "-e", "AWS_S3_BUCKET_NAME=cap-e2e", "-e", "AWS_REGION=us-east-1", "-e", "AWS_S3_ENDPOINT=http://127.0.0.1:4566",
   "-e", f"AWS_KMS_KEY_ARN={kms_arn}", "-e", "AWS_ACCESS_KEY_ID=test", "-e", "AWS_SECRET_ACCESS_KEY=test",
   "-e", f"CAP_MEETING_INTEGRATIONS={integrations}", "-e", "MEETING_TRANSCRIPTION_PROVIDER=local-whisper",
   "-e", f"MEETING_WHISPER_MODEL_PATH=/models/{os.path.basename(args.model)}", "-e", "MEETING_WHISPER_THREADS=4", "-e", "MEETING_WHISPER_LANGUAGE=en",
   args.image)
try:
    for _ in range(60):
        try:
            s, h = req("GET", "/healthz")
            if s == 200:
                break
        except Exception:
            pass
        time.sleep(1)
    print("health:", h)
    assert h["database"] and h["transcription"] == "local-whisper"

    print("== pairing (Calari side, signed)")
    body = json.dumps({"request_id": str(uuid.uuid4()), "tenant_id": TENANT, "pairing_kind": "client_intake",
                       "client_id": CLIENT, "intake_receipt_id": RECEIPT, "client_display_name": "E2E Synthetic Client",
                       "ttl_seconds": 300}).encode()
    ts, nonce = str(int(time.time())), secrets.token_urlsafe(18)
    s, pairing = req("POST", "/v1/pairings", raw=body, headers={"x-cap-key-id": KEY_ID, "x-cap-timestamp": ts,
                     "x-cap-nonce": nonce, "x-cap-signature-256": sign("pairing", ts, nonce, body)})
    assert s == 201, (s, pairing)
    print("pairing code issued:", pairing["code"][:2] + "**-****")

    s, dev = req("POST", "/v1/pairings/redeem", {"code": pairing["code"], "device_name": "e2e", "device_kind": "desktop"})
    assert s == 200, (s, dev)
    token = dev["device_token"]
    s, m = req("POST", "/v1/meetings", {"title": "E2E synthetic meeting", "idempotency_key": "e2e-1",
               "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 60)),
               "meeting_url": "https://meet.google.com/aaa-bbbb-ccc", "capture_mode": "audio"}, token)
    assert s == 201, (s, m)
    mid = m["id"]

    print("== upload two speech chunks")
    offset = 0
    for seq, name in enumerate(["a", "b"]):
        with wave.open(os.path.join(args.audio_dir, f"{name}.wav")) as w:
            dur = int(w.getnframes() * 1000 / w.getframerate())
        data = open(os.path.join(args.audio_dir, f"{name}.ogg"), "rb").read()
        s, r = req("PUT", f"/v1/meetings/{mid}/chunks/{seq}", raw=data, token=token, headers={
            "content-type": "audio/ogg", "x-chunk-sha256": hashlib.sha256(data).hexdigest(),
            "x-chunk-start-ms": str(offset), "x-chunk-duration-ms": str(dur)})
        assert s == 201, (s, r)
        offset += dur
    s, f = req("POST", f"/v1/meetings/{mid}/finalize", {"last_seq": 1, "stop_reason": "meeting_ended",
               "ended_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, token)
    assert s == 202, (s, f)

    print("== wait for transcription and signed delivery")
    t0 = time.time()
    while not received and time.time() - t0 < 300:
        time.sleep(1)
    assert received, "no delivery within 5 minutes"
    d = received[0]
    p = d["body"]
    print(f"delivered in {time.time() - t0:.1f}s, signature verified: {d['verified']}")
    print("transcript provider/model:", p["transcript"]["provider"], p["transcript"]["model"])
    for seg in p["transcript"]["segments"]:
        print(f"  [{seg['start_ms']:>6} - {seg['end_ms']:>6} ms] {seg['text']}")
    text = p["transcript"]["text"].lower()
    assert d["verified"]
    assert p["client_id"] == CLIENT and p["intake_receipt_id"] == RECEIPT
    assert "launch plan" in text and "photos" in text and "friday" in text, text
    assert all(s["end_ms"] <= offset for s in p["transcript"]["segments"]), "segments end inside the audio"
    assert p["transcript"]["model"].startswith("ggml-")
    s, v = req("GET", f"/v1/meetings/{mid}", token=token)
    assert v["state"] == "delivered" and v["delivery"]["receipt_id"] == "e2e-receipt-1", v

    print("== stored audio is SSE-KMS encrypted")
    keys = json.loads(sh(*aws, "s3api", "list-objects-v2", "--bucket", "cap-e2e"))["Contents"]
    for k in keys:
        head = json.loads(sh(*aws, "s3api", "head-object", "--bucket", "cap-e2e", "--key", k["Key"]))
        print(" ", k["Key"].split("/")[-1], head.get("ServerSideEncryption"))
        assert head.get("ServerSideEncryption") == "aws:kms"
    print("PASS")
finally:
    logs = sh("docker", "logs", "cap-server-e2e", check=False)
    print("== server log lines:", len(logs.splitlines()))
    sh("docker", "rm", "-f", "cap-server-e2e", check=False)
