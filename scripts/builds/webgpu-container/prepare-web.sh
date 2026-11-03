#!/usr/bin/env bash
# Prepare a reviewable source artifact without merging the unrelated desktop work in #824.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
: "${TMPDIR:?Use the run directory tmp/}"
: "${NAIA_WEB_AGENT_DIR:?Pinned browser agent checkout required (cc2acfa0)}"
: "${NAIA_WEB_ADK_REPO:?Pinned ADK repository required (13ea427991542965091f2f3211b9325a36dbd522)}"
[[ "$TMPDIR" = /* ]] || exit 2
export NAIA_WEB_AGENT_DIR NAIA_WEB_ADK_REPO
# Freeze the overlay before a potentially long install/build. Concurrent edits
# must not make the provenance describe a different patch than the one applied.
patch_file="$(mktemp "$TMPDIR/container-overlay.XXXXXX.patch")"
cp "$here/local-container.patch" "$patch_file"
patch_sha="$(sha256sum "$patch_file" | cut -d' ' -f1)"
web_revision=313c706996e5ab0c17add59a7144c0d9a5ba7bc4
agent_revision=cc2acfa0d496a73e7f9d0cb3052145d1caeda433
agent_source="$(mktemp -d "$TMPDIR/container-agent-source.XXXXXX")"
git -C "$NAIA_WEB_AGENT_DIR" archive "$agent_revision" | tar -x -C "$agent_source"
export NAIA_WEB_AGENT_DIR="$agent_source"
source_dir="$(mktemp -d "$TMPDIR/container-web-source.XXXXXX")"
git -C "$repo" archive "$web_revision" | tar -x -C "$source_dir"
(cd "$source_dir"; git apply --check "$patch_file")
(cd "$source_dir"; git apply "$patch_file")
# Dependency installation is explicit. An existing compatible dependency checkout can be reused.
if [[ -n "${NAIA_WEB_DEPS_DIR:-}" ]]; then
  ln -s "$NAIA_WEB_DEPS_DIR/node_modules" "$source_dir/node_modules"
  for dependency_dir in "$NAIA_WEB_DEPS_DIR"/packages/*/node_modules; do
    package_name="$(basename "$(dirname "$dependency_dir")")"
    [[ ! -d "$source_dir/packages/$package_name" ]] || ln -s "$dependency_dir" "$source_dir/packages/$package_name/node_modules"
  done
else
  (cd "$source_dir"; pnpm install --frozen-lockfile)
fi
(cd "$source_dir"; pnpm build)
(cd "$source_dir/packages/shell"; VITE_NAIA_WEB_LOGIN_REQUIRED=0 pnpm build:web)
printf '{"webRevision":"%s","containerPatchSha256":"%s","loginRequired":false}\n' "$web_revision" "$patch_sha" > "$source_dir/packages/shell/dist-web/container-build.json"
echo "NAIA_WEB_DIR=$source_dir/packages/shell/dist-web"
echo "NAIA_WEB_REVISION=$web_revision+patch-$patch_sha"
