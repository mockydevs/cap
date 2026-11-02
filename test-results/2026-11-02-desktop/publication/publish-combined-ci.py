#!/usr/bin/env python3
"""Publish the combined CI desktop installers into the live download directory.

Root release owner only. Runs ON the host. Dry run by default; --apply writes.
It never restarts anything: the Cap service restart is a separate, explicit step
(see RUNBOOK-combined-ci.md).

    python3 -I publish-combined-ci.py \
        --stage /data/cap/downloads/.release-41383982100 \
        --live  /data/cap/downloads \
        --expect-current-sha <sha256 of the live manifest.json>   [--apply]

Takes an exclusive lock (<live>/.publish.lock) so two runs never overlap, and refuses unless the
live manifest.json exists, is exactly the one the operator expects (--expect-current-sha) AND is
either a catalog with nothing available (all pending / signing_pending) or byte-identical to this
release (idempotent re-run). A missing live manifest is refused. Any live catalog that already offers a download and is not this exact
release is refused before any file or manifest is touched.

What --apply does, in order (stops at the first problem, before any change):
  1. Checks the staged manifest is strict hub v1 and lists exactly the expected
     installers, and that each staged file is a regular non-symlink file whose
     size and SHA-256 match both the manifest and the pinned CI values below.
  2. Refuses if a live file with the same name exists with different bytes.
  3. Backs up the current live manifest.json to manifest.json.bak-<UTC time>
     (never overwrites an existing backup).
  4. Copies each missing installer to a temp name, fsyncs, re-hashes, sets 0644,
     then hard-links it into place (fails instead of overwriting), removes temp.
  5. Writes the new manifest to a temp file, fsyncs, sets 0644, re-validates it
     against the live directory, then atomically renames it over manifest.json
     and fsyncs the directory.
"""

import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

# Pinned from CI run 41383982100 (source 0caf020 = runtime 553db6b + production CSS).
# Pinned from the downloaded CI 41383982100 artifacts (SHA256SUMS verified, receipt commit 0caf020).
# The script refuses to run if any value is a placeholder.
RUN_ID = "41383982100"
EXPECTED = {
    "linux-x86_64": (
        "cap-desktop_0.2.0-beta.6_linux-x86_64.deb",
        7935440,
        "e39cd10aa8dccb8d9325a56ee570425b3b8ff98c98dbb21ee744c53dd80e6fa6",
    ),
    "windows-x86_64": (
        "cap-desktop_0.2.0-beta.6_windows-x86_64-setup.exe",
        44976241,
        "f76fba04b4cb93e407a69523d580b2cc1f8a42a73e2fbba2cc71ab522f684906",
    ),
}
VERSION = "0.2.0-beta.6"
PLATFORMS = {"linux-x86_64": ".deb", "windows-x86_64": ".exe", "macos-aarch64": ".dmg", "macos-x86_64": ".dmg"}
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
MAX_MANIFEST = 64 * 1024


def fail(msg: str) -> None:
    print(f"REFUSED: {msg}", file=sys.stderr)
    sys.exit(1)


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def regular(path: pathlib.Path) -> bool:
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except FileNotFoundError:
        return False


def fsync_dir(d: pathlib.Path) -> None:
    fd = os.open(d, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def snapshot(path: pathlib.Path):
    """(sha256, bytes) of a regular non-symlink manifest, or ("absent", None)."""
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return "absent", None
    if not stat.S_ISREG(mode):
        fail(f"{path} is not a regular file (symlink or other)")
    data = path.read_bytes()
    return hashlib.sha256(data).hexdigest(), data


def validate_manifest(raw: bytes, where: pathlib.Path) -> dict:
    """Same rules as the hub: strict keys, one entry per platform, safe names, real files."""
    if not raw or len(raw) > MAX_MANIFEST:
        fail(f"manifest in {where} is empty or larger than 64 KiB")
    try:
        m = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        fail(f"manifest in {where} is not valid UTF-8 JSON")
    if not isinstance(m, dict) or set(m) != {"schema_version", "artifacts"} or m["schema_version"] != 1:
        fail(f"manifest in {where}: top level must be exactly schema_version=1 and artifacts")
    if not isinstance(m["artifacts"], list) or not all(isinstance(a, dict) for a in m["artifacts"]):
        fail(f"manifest in {where}: artifacts must be a list of objects")
    seen = set()
    for a in m["artifacts"]:
        p = a.get("platform")
        if p not in PLATFORMS or p in seen:
            fail(f"unknown or duplicate platform {p!r}")
        seen.add(p)
        st = a.get("status")
        if st == "available":
            if set(a) != {"platform", "version", "status", "filename", "bytes", "sha256"}:
                fail(f"{p}: available entry has wrong fields")
            name = a["filename"]
            if not NAME_RE.match(name) or ".." in name or not name.endswith(PLATFORMS[p]):
                fail(f"{p}: unsafe filename {name!r}")
            f = where / name
            if not regular(f):
                fail(f"{p}: {f} is missing or not a regular file")
            if f.stat().st_size != a["bytes"] or not (0 < a["bytes"] <= 2 << 30):
                fail(f"{p}: size mismatch for {name}")
            if sha256(f) != a["sha256"]:
                fail(f"{p}: SHA-256 mismatch for {name}")
        elif st in ("pending", "signing_pending"):
            if set(a) != {"platform", "status"}:
                fail(f"{p}: pending entry must contain only platform/status")
            if st == "signing_pending" and not p.startswith("macos-"):
                fail(f"{p}: signing_pending is macOS only")
        else:
            fail(f"{p}: bad status {st!r}")
    return m


def require_exact_platforms(m: dict, label: str = "staged") -> None:
    """Exactly the four platforms, each once; both macOS entries signing_pending."""
    by = {a["platform"]: a for a in m["artifacts"]}
    if set(by) != set(PLATFORMS) or len(m["artifacts"]) != len(PLATFORMS):
        fail(f"{label} manifest must list exactly the four platforms")
    for mac in ("macos-aarch64", "macos-x86_64"):
        if by[mac] != {"platform": mac, "status": "signing_pending"}:
            fail(f"{label} {mac} must be exactly signing_pending")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, type=pathlib.Path)
    ap.add_argument("--live", required=True, type=pathlib.Path)
    ap.add_argument("--expect-current-sha", required=True,
                    help="sha256 of the live manifest.json the operator expects")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    for p, (_, size, digest) in EXPECTED.items():
        if size <= 0 or not re.fullmatch(r"[0-9a-f]{64}", digest):
            fail(f"{p}: pins are still placeholders; fill them from the audited CI {RUN_ID} artifacts")
    stage, live = args.stage.resolve(), args.live.resolve()
    if stage.name != f".release-{RUN_ID}":
        fail(f"stage directory must be named .release-{RUN_ID}")
    if stage.parent != live:
        fail("stage must be a directory inside the live download directory (same filesystem)")
    expect = args.expect_current_sha
    if not re.fullmatch(r"[0-9a-f]{64}", expect):
        fail("--expect-current-sha must be the sha256 of the live manifest.json")

    # Exclusive lock for the whole run (released when the process exits).
    lock_fd = os.open(live / ".publish.lock", os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fail("another publication run holds the lock")

    current = live / "manifest.json"
    current_sha, current_raw = snapshot(current)
    if current_raw is None:
        fail("live manifest.json is missing; this release only replaces the known pending catalog")
    if current_sha != expect:
        fail(f"live manifest is {current_sha}, operator expected {expect}")
    print("live manifest matches the expected state:", current_sha)

    # 1. Staged release.
    staged_sha, staged_raw = snapshot(stage / "manifest.json")
    if staged_raw is None:
        fail("staged manifest.json is missing")
    staged = validate_manifest(staged_raw, stage)
    require_exact_platforms(staged)

    # Only a not-yet-published catalog, or this same release, may be replaced.
    if current_raw != staged_raw:
        # Same strict rules as the hub, then: nothing may be available yet.
        live_catalog = validate_manifest(current_raw, live)
        require_exact_platforms(live_catalog, "live")
        offered = [a["platform"] for a in live_catalog["artifacts"] if a["status"] == "available"]
        if offered:
            fail(f"live catalog already offers {offered} and is not this release; refusing (no rollback or overwrite)")
        print("live catalog is the known pending-only catalog: may be replaced")
    else:
        print("live catalog is this exact release")
    available = {a["platform"]: a for a in staged["artifacts"] if a["status"] == "available"}
    if set(available) != set(EXPECTED):
        fail(f"staged manifest must list exactly {sorted(EXPECTED)} as available")
    for p, (name, size, digest) in EXPECTED.items():
        a = available[p]
        if (a["filename"], a["bytes"], a["sha256"], a["version"]) != (name, size, digest, VERSION):
            fail(f"{p}: staged manifest differs from the pinned CI artifact")
    for a in staged["artifacts"]:
        if a["platform"].startswith("macos-") and a["status"] != "signing_pending":
            fail("macOS must stay signing_pending")
    print("staged release OK:", ", ".join(f"{p} {EXPECTED[p][0]}" for p in EXPECTED))

    # 2. Live conflicts.
    to_copy = []
    for p, (name, size, digest) in EXPECTED.items():
        target = live / name
        if target.exists() or target.is_symlink():
            if not regular(target) or target.stat().st_size != size or sha256(target) != digest:
                fail(f"live {name} exists with different bytes; never overwrite a live installer")
            print(f"live {name}: already present with identical bytes, kept")
        else:
            to_copy.append((stage / name, target, digest))
            print(f"live {name}: will be added")
    if not to_copy and current_raw == staged_raw:
        print("already published: live files and manifest match this release; nothing to do")
        return
    print("live manifest: present -> will be backed up")

    if not args.apply:
        print("DRY RUN: nothing changed. Re-run with --apply.")
        return

    # 3. Backup (of the exact snapshot that was checked).
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = live / f"manifest.json.bak-{stamp}-{os.getpid()}"
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "wb") as out:
        out.write(current_raw)
        out.flush()
        os.fsync(out.fileno())
    print("backed up live manifest to", backup.name)

    # 4. Installers.
    for src, target, digest in to_copy:
        tmp = live / f".{target.name}.tmp-{os.getpid()}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as out, src.open("rb") as inp:
            while chunk := inp.read(1 << 20):
                out.write(chunk)
            out.flush()
            os.fsync(out.fileno())
        if sha256(tmp) != digest:
            tmp.unlink()
            fail(f"copy of {target.name} does not match; nothing published")
        os.chmod(tmp, 0o644)
        os.link(tmp, target)  # fails rather than overwrite
        tmp.unlink()
        print("added", target.name)
    fsync_dir(live)

    # 5. Manifest, atomically.
    tmp = live / f".manifest.json.tmp-{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "wb") as out:
        out.write(staged_raw)
        out.flush()
        os.fsync(out.fileno())
    os.chmod(tmp, 0o644)
    validate_manifest(tmp.read_bytes(), live)
    # Nothing may have changed the live manifest since the checked snapshot.
    if snapshot(current)[0] != current_sha:
        tmp.unlink()
        fail("live manifest changed during publication; nothing replaced")
    os.replace(tmp, current)
    fsync_dir(live)
    print("manifest.json replaced atomically (0644). Now restart ONLY the cap-server container (runbook step 4).")


if __name__ == "__main__":
    main()
