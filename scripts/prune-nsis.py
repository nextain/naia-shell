"""Prune agent/node_modules/.pnpm of long-path files before NSIS bundling.
Also stages Windows runtime DLLs into agent/dist/ for NSIS packaging.
"""
import os
import pathlib
import shutil

root = pathlib.Path(__file__).parent.parent
pnpm_dir = root / "agent" / "node_modules" / ".pnpm"

if not pnpm_dir.exists():
    print("pnpm dir not found, skipping")
    exit(0)

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

# Stage Windows runtime DLLs into agent/dist/ so NSIS can package them.
# NSIS postInstallSection will move them to $INSTDIR (next to exe).
dll_src = root / "shell" / "src-tauri" / "resources"
dll_dst = root / "agent" / "dist"
dlls = ["libvosk.dll", "libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll"]
if dll_src.exists() and dll_dst.exists():
    for dll in dlls:
        src = dll_src / dll
        if src.exists():
            shutil.copy2(src, dll_dst / dll)
    print(f"Staged {len(dlls)} DLLs into {dll_dst}")
