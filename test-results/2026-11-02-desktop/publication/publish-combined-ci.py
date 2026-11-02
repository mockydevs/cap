#!/usr/bin/env python3
"""Publish the combined CI desktop installers into the live download directory.

Root release owner only. Runs ON the host. Dry run by default; --apply writes.
It never restarts anything: the Cap service restart is a separate, explicit step
(see RUNBOOK-combined-ci.md).

    python3 -I publish-combined-ci.py \
        --stage /data/cap/downloads/.release-41379816245 \
        --live  /data/cap/downloads            [--apply]

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
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

# Pinned from CI run 41379816245 (source 49c), independently audited.
EXPECTED = {
    "linux-x86_64": (
        "cap-desktop_0.2.0-beta.6_linux-x86_64.deb",
        7935324,
        "d9cd5661f4f6177612508e39a0f406cdf402bf00104edc5cfa8def548bcce909",
    ),
    "windows-x86_64": (
        "cap-desktop_0.2.0-beta.6_windows-x86_64-setup.exe",
        44995608,
        "3b7cf4448c88a125fda1185f4a9f363074a28e2b6d17fa4b58027a5e32e5ff95",
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


def validate_manifest(raw: bytes, where: pathlib.Path) -> dict:
    """Same rules as the hub: strict keys, one entry per platform, safe names, real files."""
    if len(raw) > MAX_MANIFEST:
        fail("manifest larger than 64 KiB")
    m = json.loads(raw.decode("utf-8"))
    if set(m) != {"schema_version", "artifacts"} or m["schema_version"] != 1:
        fail("manifest top level must be exactly schema_version=1 and artifacts")
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, type=pathlib.Path)
    ap.add_argument("--live", required=True, type=pathlib.Path)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    stage, live = args.stage.resolve(), args.live.resolve()
    if stage.parent != live:
        fail("stage must be a directory inside the live download directory (same filesystem)")

    # 1. Staged release.
    staged_raw = (stage / "manifest.json").read_bytes()
    staged = validate_manifest(staged_raw, stage)
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
    current = live / "manifest.json"
    if not to_copy and current.exists() and current.read_bytes() == staged_raw:
        print("already published: live files and manifest match this release; nothing to do")
        return
    print("live manifest:", "present" if current.exists() else "absent", "-> will be backed up" if current.exists() else "")

    if not args.apply:
        print("DRY RUN: nothing changed. Re-run with --apply.")
        return

    # 3. Backup.
    if current.exists():
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        backup = live / f"manifest.json.bak-{stamp}-{os.getpid()}"
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "wb") as out:
            out.write(current.read_bytes())
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
    os.replace(tmp, current)
    fsync_dir(live)
    print("manifest.json replaced atomically (0644). Now restart ONLY the Cap service (runbook step 4).")


if __name__ == "__main__":
    main()
