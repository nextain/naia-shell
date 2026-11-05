#!/usr/bin/env python3
# Copyright 2026 Nextain Inc. All rights reserved.

"""Measure arm/body holes in NVA alpha clips by re-running the matting post-process on stored raw videos (CPU only).

Why: Luke reported holes in the arms of finished NVA clips (2026-10-06). This script re-runs the current
matting code (rembg u2net on CPU + plain-background refinement) on already generated raw videos
(Veo idle mp4, Ditto talking webm) so the hole rate can be re-measured without any new paid generation.

A hole is a connected component of alpha < 128 that does not touch the frame border and has an area of at
least HOLE_MIN_AREA pixels (same definition as the 2026-10-06 measurement). A clip counts as "bad" when any
frame has a hole, or when the matting step itself rejects the clip (MattingFailedError / refine hole guard).

Usage:
  PYTHONPATH=src python scripts/nva_matting_hole_measure.py --cache DIR --out result.json raw1.mp4 raw2.webm ...
Env: NVA_MATTING_MODEL_PATH (default ~/.u2net/u2net.onnx), HOLE_MIN_AREA (default 150).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from any_llm.gateway.services.studio_nva_matting import (
    HOLE_FAIL_MIN_AREA_PX,
    find_enclosed_holes,
)

HOLE_MIN_AREA = int(os.environ.get("HOLE_MIN_AREA", str(HOLE_FAIL_MIN_AREA_PX)))


def count_holes(
    alpha: np.ndarray,
    min_area: int = HOLE_MIN_AREA,
    rgb: np.ndarray | None = None,
) -> list[tuple[int, int, int, int, int]]:
    """Return (area, x, y, w, h) of every transparent component that is enclosed by the figure."""
    return find_enclosed_holes(alpha, min_area=min_area, rgb=rgb)


def cached_mask_fn(session: Any, cache_dir: Path) -> Any:
    from PIL import Image
    from rembg import remove

    cache_dir.mkdir(parents=True, exist_ok=True)

    def fn(rgb: np.ndarray) -> np.ndarray:
        key = hashlib.sha1(rgb.tobytes(), usedforsecurity=False).hexdigest()
        path = cache_dir / f"{key}.npy"
        if path.exists():
            try:
                return np.load(path)
            except (ValueError, OSError):
                path.unlink(missing_ok=True)
        out: Any = remove(Image.fromarray(rgb, "RGB"), session=session, only_mask=True, post_process_mask=False)
        mask = np.asarray(out.convert("L") if hasattr(out, "convert") else out, dtype=np.uint8)
        tmp = path.with_suffix(".tmp.npy")
        np.save(tmp, mask)
        os.replace(tmp, path)  # atomic: an interrupted run never leaves a truncated cache file
        return mask

    return fn


def measure_clip(path: Path, mask_fn: Any, dump_dir: Path | None) -> dict[str, Any]:
    from any_llm.gateway.services.studio_nva_matting import (
        MattingFailedError,
        count_enclosed_opaque_backdrop_pixels,
        crossfade_loop_tail,
        normalize_clip_to_frames,
        run_matting_on_frames,
    )

    started = time.time()
    frames = crossfade_loop_tail(normalize_clip_to_frames(path.read_bytes(), 720, 1280, 24))
    rec: dict[str, Any] = {"clip": path.name, "frames": len(frames)}
    try:
        out = run_matting_on_frames(frames, mask_fn=mask_fn, clip_name=path.stem)
    except MattingFailedError as exc:
        rec.update(status="rejected_by_matting", reason=str(exc)[:200], hole_frames=0, bad=True)
        rec["seconds"] = round(time.time() - started, 1)
        return rec
    bad_frames = []
    max_area = 0
    opaque_backdrop_frames = []
    max_opaque_backdrop_px = 0
    per_frame_opaque_backdrop_px = []
    for idx, (_, alpha) in enumerate(out):
        holes = count_holes(alpha, rgb=frames[idx])
        if holes:
            bad_frames.append(idx)
            max_area = max(max_area, *(h[0] for h in holes))
        opaque_px, _ = count_enclosed_opaque_backdrop_pixels(frames[idx], alpha)
        per_frame_opaque_backdrop_px.append(opaque_px)
        if opaque_px > 0:
            opaque_backdrop_frames.append(idx)
            max_opaque_backdrop_px = max(max_opaque_backdrop_px, opaque_px)
        if dump_dir is not None and idx in (0, len(out) // 2):
            dump_dir.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(dump_dir / f"{path.stem}_a{idx:03d}.png"), alpha)
    rec.update(
        status="measured",
        hole_frames=len(bad_frames),
        hole_frame_ratio=round(len(bad_frames) / len(out), 3),
        max_hole_area=max_area,
        first_bad_frames=bad_frames[:5],
        opaque_backdrop_frames=len(opaque_backdrop_frames),
        max_opaque_backdrop_px=max_opaque_backdrop_px,
        first_opaque_backdrop_frames=opaque_backdrop_frames[:5],
        per_frame_opaque_backdrop_px=per_frame_opaque_backdrop_px,
        bad=bool(bad_frames) or bool(opaque_backdrop_frames),
        seconds=round(time.time() - started, 1),
    )
    return rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("videos", nargs="+")
    ap.add_argument("--cache", required=True, help="directory for cached rembg masks (speeds up reruns)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--label", default="")
    ap.add_argument("--dump", default="", help="directory for alpha png dumps (first and middle frame)")
    args = ap.parse_args()

    os.environ.setdefault("NVA_MATTING_MODEL_PATH", os.path.expanduser("~/.u2net/u2net.onnx"))
    from any_llm.gateway.services.studio_nva_matting import get_matting_session

    mask_fn = cached_mask_fn(get_matting_session(), Path(args.cache))
    results = []
    for v in args.videos:
        rec = measure_clip(Path(v), mask_fn, Path(args.dump) if args.dump else None)
        print(json.dumps(rec, ensure_ascii=False), flush=True)
        results.append(rec)
    bad = sum(1 for r in results if r["bad"])
    summary = {
        "label": args.label,
        "clips": len(results),
        "bad_clips": bad,
        "bad_ratio": round(bad / len(results), 3),
        "hole_min_area": HOLE_MIN_AREA,
        "results": results,
    }
    Path(args.out).write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"SUMMARY {args.label}: bad {bad}/{len(results)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
