"""Deterministic reference oracle for conform-scan (contract <-> code drift).

Anchors the definition of "drift" OUTSIDE any LLM loop, mirroring naia-144's
conform-scan — which is exactly the daf35d0 false-success root cause:
  - contract-declared scenario_* never implemented   (contract-only)
  - scene_handle_key declared int(int) but coded GameKey(GameKey)  (signature-drift)
  - battle/dialog/world implemented with no contract  (code-only)

Drift taxonomy = a pure function of two symbol tables (contract + code):
  signature-drift : symbol in BOTH, signatures differ
  contract-only   : declared in contract, ABSENT in code (unimplemented)
  code-only       : present in code, ABSENT from contract (undocumented)

The dataset plants drift by construction intent; this oracle re-derives it from
the raw symbol tables, so the self-test cross-checks two independent code paths.
The scoring evaluator compares the model's predicted drift map against the
planted one — no LLM in scoring (generation != judging).

Contract version: 1.
"""
from __future__ import annotations

ORACLE_CONTRACT_VERSION = 1

DRIFT_TYPES = ("signature-drift", "contract-only", "code-only")


def _norm_sig(sig: str) -> str:
    """Whitespace-insensitive signature normalization (real diffs only)."""
    return " ".join(str(sig).split())


def drift_set(contract: list[dict], code: list[dict]) -> dict:
    """contract/code = [{"name": str, "sig": str}]. Return {name: drift_type}.

    Symbols present-and-matching in both tables are NOT in the result (no drift).
    """
    cmap = {f["name"]: f["sig"] for f in contract}
    kmap = {f["name"]: f["sig"] for f in code}
    drift: dict[str, str] = {}
    for name in set(cmap) | set(kmap):
        in_c = name in cmap
        in_k = name in kmap
        if in_c and in_k:
            if _norm_sig(cmap[name]) != _norm_sig(kmap[name]):
                drift[name] = "signature-drift"
        elif in_c:
            drift[name] = "contract-only"
        else:
            drift[name] = "code-only"
    return drift


def naive_name_only_set(contract: list[dict], code: list[dict]) -> dict:
    """Baseline that ignores signatures (name-presence only) — misses every
    signature-drift, quantifying the headroom a real conform skill must close.
    """
    cnames = {f["name"] for f in contract}
    knames = {f["name"] for f in code}
    out: dict[str, str] = {}
    for n in cnames - knames:
        out[n] = "contract-only"
    for n in knames - cnames:
        out[n] = "code-only"
    return out


# ---------------------------------------------------------------------------
# v2 — type-level signature equality (the harder, realistic conformance notion)
#
# v1 (_norm_sig above) flagged ANY whitespace-collapsed string difference as
# signature-drift, so on a strong model (Qwen3.6) every drift was trivially
# obvious and the gate saturated at 1.0. v2 anchors drift to the *type-level*
# signature: parameter NAMES and whitespace are NOT part of a C function's type,
# so renaming a parameter or reflowing whitespace is conformant (must NOT be
# flagged), while a changed type / const-qualifier / return type IS drift (must
# be flagged). This creates headroom in both directions a real conform skill has
# to learn: precision (ignore cosmetic) and recall (catch subtle real drift).
# ---------------------------------------------------------------------------
import re as _re  # noqa: E402

_WS_RE = _re.compile(r"\s+")
_TRAILING_IDENT_RE = _re.compile(r"\b[A-Za-z_]\w*\s*$")
_SIG_RE = _re.compile(r"^(.*?)\b[A-Za-z_]\w*\s*\((.*)\)\s*$")


def _strip_param_name(p: str) -> str:
    """`const char *path` -> `const char*`; `int keycode` -> `int`; `void` -> `void`."""
    p = _WS_RE.sub(" ", p).strip()
    if p in ("", "void"):
        return p
    p = _TRAILING_IDENT_RE.sub("", p).strip()  # drop the variable name, keep the type
    p = p.replace(" *", "*")
    return _WS_RE.sub(" ", p).strip()


def normalize_sig_typelevel(sig: str) -> str:
    """Type-level normal form: return type + parameter TYPES only (function name,
    parameter names, and whitespace dropped)."""
    s = _WS_RE.sub(" ", str(sig)).strip()
    m = _SIG_RE.match(s)
    if not m:
        return s
    ret = m.group(1).strip()
    params = m.group(2).strip()
    if params in ("", "void"):
        plist = ["void"] if params == "void" else []
    else:
        plist = [x for x in (_strip_param_name(p) for p in params.split(",")) if x != ""]
    return f"{ret}(" + ",".join(plist) + ")"


def drift_set_typelevel(contract: list[dict], code: list[dict]) -> dict:
    """Like drift_set but signature equality is type-level (cosmetic diffs ignored)."""
    cmap = {f["name"]: f["sig"] for f in contract}
    kmap = {f["name"]: f["sig"] for f in code}
    drift: dict[str, str] = {}
    for name in set(cmap) | set(kmap):
        in_c, in_k = name in cmap, name in kmap
        if in_c and in_k:
            if normalize_sig_typelevel(cmap[name]) != normalize_sig_typelevel(kmap[name]):
                drift[name] = "signature-drift"
        elif in_c:
            drift[name] = "contract-only"
        else:
            drift[name] = "code-only"
    return drift


def naive_raw_sig_set(contract: list[dict], code: list[dict]) -> dict:
    """Baseline that flags ANY whitespace-collapsed string difference as drift —
    OVER-flags cosmetic (param-rename / whitespace) diffs as false positives,
    quantifying the *precision* headroom a real conform skill must close."""
    cmap = {f["name"]: f["sig"] for f in contract}
    kmap = {f["name"]: f["sig"] for f in code}
    drift: dict[str, str] = {}
    for name in set(cmap) | set(kmap):
        in_c, in_k = name in cmap, name in kmap
        if in_c and in_k:
            if _norm_sig(cmap[name]) != _norm_sig(kmap[name]):
                drift[name] = "signature-drift"
        elif in_c:
            drift[name] = "contract-only"
        else:
            drift[name] = "code-only"
    return drift
