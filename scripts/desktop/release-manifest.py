"""Write the desktop download manifest, updater index and checksums.

    python -I scripts/desktop/release-manifest.py --dir DIR --version V \
        --commit SHA --download-base https://meetings.calari.tech/downloads/ \
        [--linux available|pending] [--windows available|pending]

DIR holds the installers the release workflow built and checked in this run
(and their .sig files). Only files listed here can be marked "available";
macOS stays "signing_pending" until signing exists. Writes into DIR:
  cap-desktop-manifest.json  (download hub contract, schema_version 1)
  latest.json                (Tauri updater index; only available, signed files)
  SHA256SUMS
"""

import argparse
import datetime
import hashlib
import json
import pathlib
import re
import stat
import sys

VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")

# platform -> (installer suffix, updater platform key)
PLATFORMS = {
    "linux-x86_64": ("linux-x86_64.deb", "linux-x86_64-deb"),
    "windows-x86_64": ("windows-x86_64-setup.exe", "windows-x86_64-nsis"),
    "macos-aarch64": ("macos-aarch64.dmg", None),
    "macos-x86_64": ("macos-x86_64.dmg", None),
}


def fail(message: str) -> None:
    print(f"release-manifest: {message}", file=sys.stderr)
    sys.exit(1)


def regular_file(path: pathlib.Path) -> bool:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return False
    return stat.S_ISREG(mode)


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, type=pathlib.Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--download-base", required=True)
    parser.add_argument("--linux", choices=["available", "pending"], default="pending")
    parser.add_argument("--windows", choices=["available", "pending"], default="pending")
    args = parser.parse_args()

    if not VERSION_RE.match(args.version):
        fail(f"bad version {args.version!r}")
    if not COMMIT_RE.match(args.commit):
        fail("commit must be a full 40-character SHA")
    base = args.download_base
    if not re.match(r"^https://[A-Za-z0-9.-]+(:[0-9]+)?/([A-Za-z0-9._/-]*/)?$", base):
        fail("download base must be an https URL ending in /")

    wanted = {"linux-x86_64": args.linux, "windows-x86_64": args.windows}
    artifacts, updater, sums = [], {}, []
    for platform, (suffix, updater_key) in PLATFORMS.items():
        filename = f"cap-desktop_{args.version}_{suffix}"
        status = wanted.get(platform, "signing_pending")
        entry = {"platform": platform, "version": args.version, "filename": None,
                 "bytes": None, "sha256": None, "status": status}
        if status == "available":
            path = args.dir / filename
            sig = args.dir / f"{filename}.sig"
            if not regular_file(path) or path.stat().st_size == 0:
                fail(f"{filename} is missing or not a regular file")
            if not regular_file(sig):
                fail(f"{filename}.sig is missing: updater signing is required")
            digest = sha256(path)
            entry.update(filename=filename, bytes=path.stat().st_size, sha256=digest)
            sums.append(f"{digest}  {filename}")
            updater[updater_key] = {
                "signature": sig.read_text(encoding="ascii").strip(),
                "url": f"{base}{filename}",
            }
        artifacts.append(entry)

    manifest = {"schema_version": 1, "version": args.version, "commit": args.commit,
                "artifacts": artifacts}
    (args.dir / "cap-desktop-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="ascii")
    (args.dir / "SHA256SUMS").write_text("\n".join(sums) + ("\n" if sums else ""),
                                         encoding="ascii")
    if updater:
        latest = {
            "version": args.version,
            "notes": f"Cap {args.version}",
            "pub_date": datetime.datetime.now(datetime.timezone.utc)
            .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "platforms": updater,
        }
        (args.dir / "latest.json").write_text(json.dumps(latest, indent=2) + "\n",
                                              encoding="ascii")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
