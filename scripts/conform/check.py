#!/usr/bin/env python3
"""Deterministic contract<->code conformance gate (template — fill manifest.json).

Catches the "false success" class: code that passes surface gates while diverging
from its declared contract (signature-drift / contract-only / code-only). The
judge is a pure-Python oracle — no LLM, no tokens. An edit-time hook
(.agents/hooks/conform-gate.js) runs this after each edit so an uncommitted agent
cannot loop for hours on a drifted base; the signal comes from OUTSIDE its loop.

CONFIGURE: edit `manifest.json` with your contract<->code regions. With no
regions the gate is inert (safe default for a fresh project). The bundled
extractor parses C (.h prototypes = contract, non-static .c defs = code); for
another language, replace `extract()` below — the oracle, loop-state, and sanity
machinery are language-agnostic.

Modes:
  --all          check every region; report; exit 1 if drift/broken.
  --file <path>  check the region(s) that <path> belongs to; print JSON verdict
                 for the hook; update loop state.
"""
from __future__ import annotations

import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import oracle  # noqa: E402

MANIFEST = os.path.join(_HERE, "manifest.json")
HALT_N = 3                                         # consecutive drifted edits → halt


def _project_root() -> str:
    """Walk up from this script to the project root (dir holding .git or .agents)."""
    d = _HERE
    for _ in range(8):
        if os.path.isdir(os.path.join(d, ".git")) or os.path.isdir(os.path.join(d, ".agents")):
            return d
        nd = os.path.dirname(d)
        if nd == d:
            break
        d = nd
    return os.path.dirname(os.path.dirname(_HERE))   # fallback: scripts/conform → root


ROOT = _project_root()
STATE = os.path.join(ROOT, ".tmp", "conform-state.json")

_FUNC = re.compile(
    r"^[ \t]*(static\s+)?"
    r"([A-Za-z_][\w \t\*]*?[\w\*])[ \t]+"
    r"([A-Za-z_]\w*)[ \t]*"
    r"\(([^;{]*)\)[ \t]*"
    r"([;{])",
    re.MULTILINE,
)
_SKIP = {"if", "for", "while", "switch", "return", "sizeof", "typedef", "struct"}


def extract(path: str, want: str) -> list[dict]:
    """C extractor. want='proto' (header decls) | 'def_public' (non-static defs).
    Replace this for other languages; the rest of the file is language-agnostic."""
    out, seen = [], set()
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return out
    for m in _FUNC.finditer(text):
        is_static, ret, name, params, end = (
            m.group(1), m.group(2).strip(), m.group(3), m.group(4).strip(), m.group(5))
        if name in _SKIP:
            continue
        if want == "proto" and end != ";":
            continue
        if want == "def_public":
            if end != "{" or is_static:
                continue
        if name in seen:
            continue
        seen.add(name)
        out.append({"name": name, "sig": f"{ret} {name}({params})"})
    return out


def load_manifest() -> dict:
    try:
        with open(MANIFEST, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"regions": []}


def check_region(reg: dict) -> dict:
    contract = extract(os.path.join(ROOT, reg["header"]), "proto")
    code = extract(os.path.join(ROOT, reg["source"]), "def_public")
    found = {s["name"] for s in contract} | {s["name"] for s in code}
    broken = [e for e in reg.get("expect", []) if e not in found]
    drift = {} if broken else oracle.drift_set_typelevel(contract, code)
    return {"drift": drift, "broken": broken, "contract": contract, "code": code}


def regions_for_file(path: str, man: dict) -> list[dict]:
    b = os.path.basename(path)
    return [r for r in man.get("regions", [])
            if b in (os.path.basename(r.get("header", "")), os.path.basename(r.get("source", "")))]


def _load_state() -> dict:
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_state(st: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=1)


def mode_all() -> int:
    man = load_manifest()
    regs = man.get("regions", [])
    if not regs:
        print("conform gate — no regions configured (edit scripts/conform/manifest.json). inert.")
        return 0
    bad = 0
    print("conform gate — all regions")
    for reg in regs:
        r = check_region(reg)
        if r["broken"]:
            bad += 1
            print(f"  [BROKEN] {reg['name']}: extractor missed {r['broken']} — UNTRUSTWORTHY")
        elif r["drift"]:
            bad += 1
            print(f"  [DRIFT ] {reg['name']}: {r['drift']}")
        else:
            print(f"  [clean ] {reg['name']} ({len(r['contract'])} public fn)")
    print(f"=> {'FAIL' if bad else 'PASS'} ({bad} region(s) need attention)")
    return 1 if bad else 0


def mode_file(path: str) -> int:
    man = load_manifest()
    regs = regions_for_file(path, man)
    if not regs:
        print(json.dumps({"status": "skip"}))
        return 0
    st = _load_state()
    drifted, broken_regs, details = {}, [], {}
    for reg in regs:
        r = check_region(reg)
        if r["broken"]:
            broken_regs.append(reg["name"])
            st[reg["name"]] = st.get(reg["name"], 0) + 1
            details[reg["name"]] = {"broken": r["broken"]}
        elif r["drift"]:
            st[reg["name"]] = st.get(reg["name"], 0) + 1
            drifted[reg["name"]] = st[reg["name"]]
            details[reg["name"]] = r["drift"]
        else:
            st[reg["name"]] = 0
    _save_state(st)

    if not drifted and not broken_regs:
        print(json.dumps({"status": "clean"}))
        return 0
    maxcount = max([st[r] for r in list(drifted) + broken_regs], default=1)
    lines = [f"{n}: extractor BROKEN ({details[n]['broken']})" for n in broken_regs]
    lines += [f"{n}: {details[n]} (drifted for {c} edit(s))" for n, c in drifted.items()]
    body = "; ".join(lines)
    if maxcount >= HALT_N:
        msg = (f"[conform] HALT — contract<->code drift unresolved for {maxcount} edits: {body}. "
               f"STOP adding code. Reconcile the contract or escalate to a human BEFORE further "
               f"edits — you are looping on a drifted base.")
        print(json.dumps({"status": "halt", "message": msg, "regions": details}))
    else:
        msg = (f"[conform] DRIFT — {body}. Reconcile contract<->code before adding more "
               f"(the false-success class). Fix now, don't build on it.")
        print(json.dumps({"status": "drift", "message": msg, "regions": details}))
    return 0


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--all":
        return mode_all()
    if len(args) >= 2 and args[0] == "--file":
        return mode_file(args[1])
    print("usage: check.py --all | --file <path>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
