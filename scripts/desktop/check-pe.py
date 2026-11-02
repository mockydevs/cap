"""Check a Windows program's PE header.

    python -I scripts/desktop/check-pe.py FILE              # must be x86-64 (PE32+, AMD64)
    python -I scripts/desktop/check-pe.py --installer FILE

--installer accepts the NSIS setup stub, which is a 32-bit (i386, PE32)
program even when it installs a 64-bit app; the installed app and its
FFmpeg are then checked separately without --installer.
"""

import struct
import sys

args = sys.argv[1:]
installer = args[:1] == ["--installer"]
path = args[-1]
with open(path, "rb") as f:
    head = f.read(4096)
if head[:2] != b"MZ":
    sys.exit(f"{path}: not a Windows program")
pe = struct.unpack_from("<I", head, 0x3C)[0]
if head[pe : pe + 4] != b"PE\0\0":
    sys.exit(f"{path}: no PE header")
machine = struct.unpack_from("<H", head, pe + 4)[0]
magic = struct.unpack_from("<H", head, pe + 24)[0]
if machine == 0x8664 and magic == 0x20B:
    print(f"{path}: PE32+ x86-64")
elif installer and machine == 0x14C and magic == 0x10B:
    print(f"{path}: PE32 i386 setup stub (NSIS)")
else:
    want = "an i386 or AMD64 Windows program" if installer else "AMD64 PE32+"
    sys.exit(f"{path}: machine {machine:#x}, optional header {magic:#x}; want {want}")
