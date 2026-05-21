"""Prune agent/node_modules/.pnpm of long-path files before NSIS bundling.
Also stages Windows runtime DLLs into agent/dist/ for NSIS packaging.
Also materializes Windows NTFS junctions in node_modules/ so NSIS can copy them.
"""
import ctypes
import os
import pathlib
import shutil
import sys

root = pathlib.Path(__file__).parent.parent
nm_dir = root / "agent" / "node_modules"
pnpm_dir = nm_dir / ".pnpm"

if not pnpm_dir.exists():
    print("pnpm dir not found, skipping")
    sys.exit(0)

# ── 1. Materialize NTFS junctions so NSIS can copy them ──────────────────────
# NSIS skips Windows reparse points (junctions/symlinks) by default.
# pnpm uses junctions for top-level node_modules/ entries on Windows.
# This step replaces each junction with a real directory copy of its target.

def is_junction(path: str) -> bool:
    """Return True if the path is an NTFS junction (reparse point)."""
    if sys.platform != "win32":
        return False
    FILE_ATTRIBUTE_REPARSE_POINT = 0x400
    attrs = ctypes.windll.kernel32.GetFileAttributesW(path)
    return attrs != 0xFFFFFFFF and bool(attrs & FILE_ATTRIBUTE_REPARSE_POINT)

materialized = 0
if sys.platform == "win32":
    for entry in os.scandir(nm_dir):
        if not entry.is_dir(follow_symlinks=False):
            continue
        if not is_junction(entry.path):
            continue
        try:
            target = os.readlink(entry.path)
            tmp = entry.path + "__nsis_tmp"
            shutil.copytree(target, tmp, symlinks=False, dirs_exist_ok=False)
            # Remove junction (rmdir removes just the reparse point, not the target)
            os.rmdir(entry.path)
            os.rename(tmp, entry.path)
            materialized += 1
        except Exception as e:
            print(f"  Warning: could not materialize {entry.name}: {e}")
    print(f"Materialized {materialized} junctions in {nm_dir}")

# ── 2. Prune long-path source maps from .pnpm ─────────────────────────────────
exts = {".js.map", ".cjs.map", ".mjs.map", ".d.ts.map", ".d.cts.map", ".d.mts.map"}
removed = 0
for f in pnpm_dir.rglob("*"):
    if not f.is_file():
        continue
    name = f.name
    for ext in exts:
        if name.endswith(ext):
            f.unlink()
            removed += 1
            break

# Remove dist/node_modules (nested)
for d in pnpm_dir.rglob("dist/node_modules"):
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)
        removed += 1

print(f"Pruned {removed} items from {pnpm_dir}")

# ── 3. Stage Windows runtime DLLs into agent/dist/ ───────────────────────────
# NSIS nsis-hooks.nsh NSIS_HOOK_POSTINSTALL will move them to $INSTDIR.
dll_src = root / "shell" / "src-tauri" / "resources"
dll_dst = root / "agent" / "dist"
dlls = ["libvosk.dll", "libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll"]
if dll_src.exists() and dll_dst.exists():
    for dll in dlls:
        src = dll_src / dll
        if src.exists():
            shutil.copy2(src, dll_dst / dll)
    print(f"Staged {len(dlls)} DLLs into {dll_dst}")
