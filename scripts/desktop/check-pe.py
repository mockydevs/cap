"""Exit 0 only if the file is a 64-bit x86 Windows program (PE32+, AMD64).

    python -I scripts/desktop/check-pe.py FILE
"""

import struct
import sys

path = sys.argv[1]
with open(path, "rb") as f:
    head = f.read(4096)
if head[:2] != b"MZ":
    sys.exit(f"{path}: not a Windows program")
pe = struct.unpack_from("<I", head, 0x3C)[0]
if head[pe : pe + 4] != b"PE\0\0":
    sys.exit(f"{path}: no PE header")
machine = struct.unpack_from("<H", head, pe + 4)[0]
magic = struct.unpack_from("<H", head, pe + 24)[0]
if machine != 0x8664 or magic != 0x20B:
    sys.exit(f"{path}: machine {machine:#x}, optional header {magic:#x}; want AMD64 PE32+")
print(f"{path}: PE32+ x86-64")
