"""Fetch the FFmpeg that Cap's Windows installer ships, and verify it.

Downloads one pinned, immutable LGPL build from BtbN/FFmpeg-Builds (the
Windows builds linked from ffmpeg.org), checks its SHA-256, and extracts
only ffmpeg.exe and the licence. Nothing downloaded is run.

    python -I scripts/desktop/fetch-windows-ffmpeg.py

Writes (git-ignored):
    apps/desktop/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe
    apps/desktop/src-tauri/resources/ffmpeg/LICENSE.txt
    apps/desktop/src-tauri/resources/ffmpeg/NOTICE.txt
"""

import hashlib
import pathlib
import sys
import urllib.request
import zipfile

# Month-end autobuilds are kept long term. Update all four values together.
RELEASE = "autobuild-2026-10-31-12-59"
BUILD = "ffmpeg-n8.1.3-27-g8dca1586f4-win64-lgpl-8.1"
SHA256 = "d4c2a42673917b4a97104a3e9f082729a9730796b98664e37c0b7eba6c6c613d"
SOURCE_COMMIT = "8dca1586f4"  # FFmpeg n8.1.3-27-g8dca1586f4

URL = f"https://github.com/BtbN/FFmpeg-Builds/releases/download/{RELEASE}/{BUILD}.zip"
MAX_ZIP_BYTES = 400 * 1024 * 1024
MAX_EXE_BYTES = 300 * 1024 * 1024

ROOT = pathlib.Path(__file__).resolve().parents[2]
TAURI = ROOT / "apps" / "desktop" / "src-tauri"
EXE = TAURI / "binaries" / "ffmpeg-x86_64-pc-windows-msvc.exe"
LICENCE_DIR = TAURI / "resources" / "ffmpeg"


def fail(message: str) -> None:
    print(f"fetch-windows-ffmpeg: {message}", file=sys.stderr)
    sys.exit(1)


def download(dest: pathlib.Path) -> None:
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(URL, timeout=120) as response, dest.open("wb") as out:
        if response.geturl().split("/")[2] not in ("github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"):
            fail(f"unexpected download host {response.geturl()}")
        while chunk := response.read(1 << 20):
            size += len(chunk)
            if size > MAX_ZIP_BYTES:
                fail("download is larger than expected")
            digest.update(chunk)
            out.write(chunk)
    if digest.hexdigest() != SHA256:
        fail(f"SHA-256 mismatch: got {digest.hexdigest()}, want {SHA256}")


def member(archive: zipfile.ZipFile, name: str, limit: int) -> bytes:
    # Read named members only: no extraction of archive-chosen paths.
    info = archive.getinfo(f"{BUILD}/{name}")
    if info.file_size > limit or info.is_dir():
        fail(f"{name} is not what was expected")
    return archive.read(info)


def main() -> None:
    zip_path = TAURI / "binaries" / f"{BUILD}.zip"
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    if not zip_path.exists() or hashlib.sha256(zip_path.read_bytes()).hexdigest() != SHA256:
        tmp = zip_path.with_suffix(".part")
        download(tmp)
        tmp.replace(zip_path)
    with zipfile.ZipFile(zip_path) as archive:
        exe = member(archive, "bin/ffmpeg.exe", MAX_EXE_BYTES)
        licence = member(archive, "LICENSE.txt", 1 << 20)
    if exe[:2] != b"MZ":
        fail("ffmpeg.exe is not a Windows executable")
    EXE.write_bytes(exe)
    LICENCE_DIR.mkdir(parents=True, exist_ok=True)
    (LICENCE_DIR / "LICENSE.txt").write_bytes(licence)
    (LICENCE_DIR / "NOTICE.txt").write_text(
        "Cap for Windows includes FFmpeg (https://ffmpeg.org), licensed under the\n"
        "GNU Lesser General Public License version 3 (see LICENSE.txt), built with\n"
        "libopus and libvpx. Cap runs it as a separate program.\n\n"
        f"Binary: {BUILD} from https://github.com/BtbN/FFmpeg-Builds/releases/tag/{RELEASE}\n"
        f"SHA-256 of the build archive: {SHA256}\n"
        f"Source: https://github.com/FFmpeg/FFmpeg/commit/{SOURCE_COMMIT}\n"
        "Build scripts: https://github.com/BtbN/FFmpeg-Builds\n",
        encoding="ascii",
    )
    print(f"{EXE.relative_to(ROOT)} ({len(exe)} bytes) from {BUILD}")


if __name__ == "__main__":
    main()
