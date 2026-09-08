#!/usr/bin/env python3
"""Make the Naia post-rootfs hook fail closed for one candidate image.

The image-layer hook is intentionally kept in its source repository.  This
helper creates a generated copy for the ISO build and binds the installer
metadata to the candidate tag and digest supplied by the workflow.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import stat
import sys


IMAGE_REF_RE = re.compile(r"^ghcr\.io/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=pathlib.Path)
    parser.add_argument("destination", type=pathlib.Path)
    parser.add_argument("image_ref")
    parser.add_argument("candidate_tag")
    parser.add_argument("candidate_digest")
    return parser.parse_args()


def shell_quote(value: str) -> str:
    # Inputs are constrained above to characters safe in a single-quoted
    # shell literal.  Keep this assertion next to the generated script.
    if not re.fullmatch(r"[A-Za-z0-9._:/-]+", value):
        raise ValueError(f"unsafe shell value: {value!r}")
    return value


def main() -> int:
    args = parse_args()
    if not IMAGE_REF_RE.fullmatch(args.image_ref):
        raise SystemExit(f"invalid candidate image ref: {args.image_ref!r}")
    if not TAG_RE.fullmatch(args.candidate_tag):
        raise SystemExit(f"invalid candidate tag: {args.candidate_tag!r}")
    if not DIGEST_RE.fullmatch(args.candidate_digest):
        raise SystemExit(f"invalid candidate digest: {args.candidate_digest!r}")

    source = args.source
    if not source.is_file():
        raise SystemExit(f"post-rootfs hook does not exist: {source}")
    text = source.read_text(encoding="utf-8")
    if not text.startswith("#!"):
        raise SystemExit("post-rootfs hook has no shebang")

    jq_prefix = (
        'jq --arg name "${NAIA_IMAGE_NAME}" '
        '--arg ref "ostree-image-signed:docker://${NAIA_IMAGE}" '
    )
    jq_needle = jq_prefix + "'"
    jq_replacement = (
        'jq --arg name "${NAIA_IMAGE_NAME}" '
        '--arg ref "ostree-image-signed:docker://${NAIA_IMAGE}" '
        '--arg tag "${NAIA_CANDIDATE_TAG}" '
        "'"
    )
    if text.count(jq_needle) != 1:
        raise SystemExit(
            "expected exactly one image-info jq update in the source hook"
        )
    text = text.replace(jq_needle, jq_replacement)

    replacements = {
        '.["image-tag"] = "latest"': '.["image-tag"] = $tag',
        '.["image-branch"] = "latest"': '.["image-branch"] = $tag',
        '${NAIA_IMAGE}:latest': '${NAIA_IMAGE}:${NAIA_CANDIDATE_TAG}',
    }
    for old, new in replacements.items():
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"hook replacement count for {old!r}: {count}")
        text = text.replace(old, new)

    image_name_marker = 'NAIA_IMAGE_NAME="${NAIA_IMAGE##*/}"'
    if text.count(image_name_marker) != 1:
        raise SystemExit("candidate image-name assertion marker is ambiguous")
    image_assertion = f'''{image_name_marker}
if [ "${{NAIA_IMAGE}}" != "${{NAIA_CANDIDATE_IMAGE}}" ]; then
    echo "[naia] FATAL: image ref ${{NAIA_IMAGE}} is not the BC250 candidate ${{NAIA_CANDIDATE_IMAGE}}" >&2
    exit 1
fi'''
    text = text.replace(image_name_marker, image_assertion)

    header_marker = "set -euo pipefail\n"
    if text.find(header_marker) < 0:
        raise SystemExit("post-rootfs hook has no set-euo header")
    header = header_marker + f'''\n# Candidate values are supplied by the immutable ISO workflow dispatch.
readonly NAIA_CANDIDATE_IMAGE='{shell_quote(args.image_ref)}'
readonly NAIA_CANDIDATE_TAG='{shell_quote(args.candidate_tag)}'
readonly NAIA_CANDIDATE_DIGEST='{shell_quote(args.candidate_digest)}'
'''
    text = text.replace(header_marker, header, 1)

    text += f'''

# ============================================================================
# BC250 candidate integrity checks.  Titanoboa embeds the candidate image
# before this hook runs; fail the build if the embedded storage or installer
# metadata points anywhere else.
# ============================================================================
echo "[naia] verifying embedded candidate ${{NAIA_CANDIDATE_IMAGE}}:${{NAIA_CANDIDATE_TAG}}"
candidate_ref="${{NAIA_CANDIDATE_IMAGE}}:${{NAIA_CANDIDATE_TAG}}"
embedded_refs="$(podman image inspect --format '{{{{range .RepoDigests}}}}{{{{println .}}}}{{{{end}}}}' \\
    "$candidate_ref" 2>/dev/null || true)"
if ! grep -Fqx "${{NAIA_CANDIDATE_IMAGE}}@${{NAIA_CANDIDATE_DIGEST}}" <<<"$embedded_refs"; then
    echo "[naia] FATAL: embedded candidate digest is not ${{NAIA_CANDIDATE_DIGEST}}" >&2
    printf '%s\\n' "$embedded_refs" >&2
    exit 1
fi

IMAGE_INFO="/usr/share/ublue-os/image-info.json"
test -f "$IMAGE_INFO" || {{ echo "[naia] FATAL: image-info.json disappeared" >&2; exit 1; }}
test "$(jq -r '."image-ref"' < "$IMAGE_INFO")" = \
    "ostree-image-signed:docker://${{NAIA_CANDIDATE_IMAGE}}"
test "$(jq -r '."image-tag"' < "$IMAGE_INFO")" = "$NAIA_CANDIDATE_TAG"
test "$(jq -r '."image-branch"' < "$IMAGE_INFO")" = "$NAIA_CANDIDATE_TAG"

grep -Fq "ostreecontainer --url=${{NAIA_CANDIDATE_IMAGE}}:${{NAIA_CANDIDATE_TAG}}" \\
    /usr/share/anaconda/interactive-defaults.ks
grep -Fq "container-image-reference=ostree-image-signed:docker://${{NAIA_CANDIDATE_IMAGE}}:${{NAIA_CANDIDATE_TAG}}" \\
    /usr/share/anaconda/post-scripts/install-configure-upgrade.ks
# Exercise the same image lookup transport as Anaconda, not only podman metadata.
command -v skopeo >/dev/null
skopeo inspect --raw "containers-storage:${{candidate_ref}}" >/dev/null
for unit in naia-bc250-governor naia-bc250-dp-audio; do
    test -x "/usr/libexec/${{unit}}"
    test -L "/etc/systemd/system/multi-user.target.wants/${{unit}}.service"
    grep -Fq 'ConditionKernelCommandLine=!nomodeset' "/usr/lib/systemd/system/${{unit}}.service"
done
echo "[naia] candidate image-info, embedded digest, and signed kickstart checks passed"
'''

    destination = args.destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(text, encoding="utf-8")
    source_mode = stat.S_IMODE(source.stat().st_mode)
    destination.chmod(source_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"::error::{exc}", file=sys.stderr)
        raise SystemExit(1) from exc
