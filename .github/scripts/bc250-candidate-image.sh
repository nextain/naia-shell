#!/usr/bin/env bash
# Build and publish the bounded AMD/BC250 image candidate.
#
# This deliberately bypasses BlueBuild. BlueBuild's production recipe writes
# :latest and does not provide a staging tag, so a candidate must be built from
# the already published Naia AMD digest and moved through its own immutable
# tag. The ISO workflow consumes the digest recorded by this script.
set -Eeuo pipefail

die() {
  echo "::error::$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

: "${BASE_IMAGE:?BASE_IMAGE is required}"
: "${IMAGE_REF:?IMAGE_REF is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${RPM_URL:?RPM_URL is required}"
: "${RPM_SHA256:?RPM_SHA256 is required}"
: "${SOURCE_COMMIT:?SOURCE_COMMIT is required}"
: "${NAIA_VERSION:?NAIA_VERSION is required}"
: "${SOURCE_BUILD:?SOURCE_BUILD is required}"
: "${REGISTRY_TOKEN:?REGISTRY_TOKEN is required}"
: "${SIGNING_SECRET:?SIGNING_SECRET is required}"
: "${IMAGE_LAYER_DIR:?IMAGE_LAYER_DIR is required}"

readonly EXPECTED_IMAGE_REF="ghcr.io/nextain/naia-os-amd"
readonly EXPECTED_BASE_IMAGE="ghcr.io/nextain/naia-os-amd@sha256:5bf36115118aa8099aed8760b0b6bfd4dd9e1122a7a5f2e8e8b772a97a13c474"
readonly EXPECTED_IMAGE_TAG="candidate-bc250-0.2.3-13980895"
readonly EXPECTED_RPM_URL="https://github.com/nextain/naia-shell/releases/download/bc250-20260908-13980895/Naia-0.2.3-1.x86_64.rpm"
readonly EXPECTED_RPM_SHA256="1e912b1c87e84e1ae1094a1943e88c71e6688b010c19f3ded9b69a3c72f189ad"
readonly EXPECTED_SOURCE_COMMIT="1398089595ee1a7330f8ec1cfe387439f0807227"
readonly EXPECTED_NAIA_VERSION="0.2.3"
readonly EXPECTED_SOURCE_BUILD="0.2.3+13980895"
readonly EXPECTED_COSIGN_FINGERPRINT="54f58f952bf8d55bf008e49b9933be7e"

[[ "$IMAGE_REF" == "$EXPECTED_IMAGE_REF" ]] || die "candidate image ref is not the AMD Naia repository"
[[ "$IMAGE_TAG" == "$EXPECTED_IMAGE_TAG" ]] || die "candidate tag is not the bounded BC250 tag"
[[ "$RPM_URL" == "$EXPECTED_RPM_URL" ]] || die "RPM URL is not the verified 0.2.3 prerelease asset"
[[ "$RPM_SHA256" == "$EXPECTED_RPM_SHA256" ]] || die "RPM SHA-256 is not the verified 0.2.3 asset digest"
[[ "$SOURCE_COMMIT" == "$EXPECTED_SOURCE_COMMIT" ]] || die "source commit is not the bounded candidate commit"
[[ "$NAIA_VERSION" == "$EXPECTED_NAIA_VERSION" ]] || die "Naia version is not 0.2.3"
[[ "$SOURCE_BUILD" == "$EXPECTED_SOURCE_BUILD" ]] || die "source build is not the bounded 0.2.3+13980895 value"
base_image_ref="${BASE_IMAGE%%@*}"
base_image_digest="${BASE_IMAGE##*@}"
[[ "$BASE_IMAGE" == "$EXPECTED_BASE_IMAGE" ]] || \
  die "BASE_IMAGE is not the pinned nextain/naia-os-amd candidate base"
[[ "$base_image_ref" == "$EXPECTED_IMAGE_REF" ]] || \
  die "BASE_IMAGE must use the immutable nextain/naia-os-amd repository"
[[ "$base_image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || \
  die "BASE_IMAGE must use a valid immutable SHA-256 digest"
[[ "$RPM_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "RPM_SHA256 is not a lowercase SHA-256"
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "SOURCE_COMMIT is not a full Git SHA"
[[ -d "$IMAGE_LAYER_DIR" ]] || die "image layer checkout is missing: $IMAGE_LAYER_DIR"

require_command curl
require_command jq
require_command podman
require_command rpm
require_command sha256sum
require_command skopeo
require_command cosign

test -f "$IMAGE_LAYER_DIR/cosign.pub" || die "image layer has no cosign.pub"
actual_key_fingerprint="$(tr -d '[:space:]' < "$IMAGE_LAYER_DIR/cosign.pub" | md5sum | cut -c1-32)"
echo "cosign.pub fingerprint: $actual_key_fingerprint"
[[ "$actual_key_fingerprint" == "$EXPECTED_COSIGN_FINGERPRINT" ]] || \
  die "cosign.pub does not match the key trusted by installed Naia images"

run_id="${GITHUB_RUN_ID:-local}"
work_dir="${RUNNER_TEMP:-/tmp}/naia-bc250-image-${run_id}"
context_dir="$work_dir/context"
metadata_dir="$context_dir/metadata"
docker_config="$work_dir/docker"
mkdir -p "$metadata_dir" "$docker_config"
# Keep podman, skopeo and cosign on one private, per-run auth file. The default
# runner auth location is not guaranteed to be shared by all three clients.
export DOCKER_CONFIG="$docker_config"
export REGISTRY_AUTH_FILE="$docker_config/config.json"
printf '%s\n' '{"auths":{}}' > "$DOCKER_CONFIG/config.json"
chmod 600 "$DOCKER_CONFIG/config.json"
export COSIGN_PASSWORD=''
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

base_digest="${BASE_IMAGE##*@}"
resolved_base_digest="$(skopeo inspect --format '{{.Digest}}' "docker://${BASE_IMAGE}")" || \
  die "could not inspect immutable base image"
[[ "$resolved_base_digest" == "$base_digest" ]] || \
  die "base image digest changed while resolving it: expected $base_digest, got $resolved_base_digest"
echo "Base image: ${BASE_IMAGE}"

rpm_path="$context_dir/Naia-0.2.3-1.x86_64.rpm"
curl --fail --location --retry 3 --retry-delay 2 --silent --show-error \
  "$RPM_URL" -o "$rpm_path"
printf '%s  %s\n' "$RPM_SHA256" "$rpm_path" | sha256sum --check --status - || \
  die "downloaded RPM does not match the verified SHA-256"

rpm_identity="$(rpm -qp --qf '%{NAME} %{VERSION} %{RELEASE} %{ARCH}\n' "$rpm_path")"
[[ "$rpm_identity" == "naia 0.2.3 1 x86_64" ]] || \
  die "unexpected RPM identity: $rpm_identity"
rpm_roots="$(rpm -qp --list "$rpm_path" | awk 'NF { split($0, parts, "/"); print "/" parts[2] }' | sort -u)"
[[ "$rpm_roots" == "/usr" ]] || die "RPM installs outside /usr: $rpm_roots"
echo "RPM: $rpm_identity; SHA-256 verified"

printf '%s\n' "$NAIA_VERSION" > "$metadata_dir/naia-os-version"
printf '%s\n' "$SOURCE_BUILD" > "$metadata_dir/sourcebuildmanifest"
printf '%s\n' "$SOURCE_BUILD" > "$metadata_dir/source-build-manifest"
jq -n \
  --arg product "naia-os" \
  --arg variant "amd" \
  --arg version "$NAIA_VERSION" \
  --arg source "$SOURCE_COMMIT" \
  --arg build "$SOURCE_BUILD" \
  '{product: $product, variant: $variant, version: $version,
    source_commit: $source, source_build: $build,
    source: $source, build: $build}' \
  > "$metadata_dir/source-build-manifest.json"

cat > "$context_dir/Containerfile" <<'CONTAINERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG IMAGE_REF
ARG IMAGE_TAG
ARG NAIA_VERSION
ARG SOURCE_COMMIT
ARG SOURCE_BUILD

COPY Naia-0.2.3-1.x86_64.rpm /tmp/naia-shell.rpm
COPY metadata/ /tmp/naia-candidate-metadata/

RUN set -eux; \
    if rpm -q naia >/dev/null 2>&1; then \
      rpm-ostree override replace /tmp/naia-shell.rpm; \
    else \
      rpm-ostree install /tmp/naia-shell.rpm; \
    fi; \
    install -Dm0644 /tmp/naia-candidate-metadata/naia-os-version \
      /usr/share/naia/naia-os-version; \
    install -Dm0644 /tmp/naia-candidate-metadata/sourcebuildmanifest \
      /usr/share/naia/sourcebuildmanifest; \
    install -Dm0644 /tmp/naia-candidate-metadata/source-build-manifest \
      /usr/share/naia/source-build-manifest; \
    install -Dm0644 /tmp/naia-candidate-metadata/source-build-manifest.json \
      /usr/share/naia/source-build-manifest.json; \
    test -f /usr/share/ublue-os/image-info.json; \
    jq --arg ref "ostree-image-signed:docker://${IMAGE_REF}" \
      --arg tag "${IMAGE_TAG}" \
      '.["image-ref"] = $ref | .["image-tag"] = $tag | .["image-branch"] = $tag' \
      /usr/share/ublue-os/image-info.json > /tmp/image-info.json; \
    mv /tmp/image-info.json /usr/share/ublue-os/image-info.json; \
    test "$(cat /usr/share/naia/naia-os-version)" = "${NAIA_VERSION}"; \
    test "$(cat /usr/share/naia/sourcebuildmanifest)" = "${SOURCE_BUILD}"; \
    jq -e --arg source "${SOURCE_COMMIT}" --arg build "${SOURCE_BUILD}" \
      '.source_commit == $source and .source_build == $build and .source == $source and .build == $build' \
      /usr/share/naia/source-build-manifest.json; \
    jq -e --arg tag "${IMAGE_TAG}" \
      '.["image-tag"] == $tag and .["image-branch"] == $tag' \
      /usr/share/ublue-os/image-info.json; \
    rm -rf /tmp/naia-shell.rpm /tmp/naia-candidate-metadata /tmp/image-info.json

LABEL org.opencontainers.image.version="${NAIA_VERSION}" \
      io.nextain.source-commit="${SOURCE_COMMIT}" \
      io.nextain.source-build="${SOURCE_BUILD}" \
      io.nextain.candidate="true"

RUN /usr/libexec/naia-verify-image
CONTAINERFILE

latest_before=""
if latest_before="$(skopeo inspect --format '{{.Digest}}' "docker://${IMAGE_REF}:latest" 2>/dev/null)"; then
  echo "Production latest before candidate: $latest_before"
else
  echo "Production latest was not readable before candidate build"
fi

podman pull "$BASE_IMAGE"
build_ref="${IMAGE_REF}:${IMAGE_TAG}"
BUILDAH_ISOLATION=chroot podman build \
  --pull=never \
  --format=oci \
  --security-opt label=disable \
  --tag "$build_ref" \
  --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
  --build-arg "IMAGE_REF=${IMAGE_REF}" \
  --build-arg "IMAGE_TAG=${IMAGE_TAG}" \
  --build-arg "NAIA_VERSION=${NAIA_VERSION}" \
  --build-arg "SOURCE_COMMIT=${SOURCE_COMMIT}" \
  --build-arg "SOURCE_BUILD=${SOURCE_BUILD}" \
  "$context_dir"

printf '%s' "$REGISTRY_TOKEN" | podman login --authfile "$DOCKER_CONFIG/config.json" ghcr.io \
  --username "${GITHUB_ACTOR:-github-actions[bot]}" --password-stdin
podman push "$build_ref"
candidate_digest="$(skopeo inspect --format '{{.Digest}}' "docker://${build_ref}")" || \
  die "could not resolve the pushed candidate digest"
[[ "$candidate_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "candidate digest is invalid"
echo "Candidate image: ${IMAGE_REF}@${candidate_digest}"

# Sign the digest, never the mutable candidate tag. The transparency log is
# disabled because the existing installed-image policy is keyed to cosign.pub
# and this private candidate must not publish build metadata externally.
cosign sign --key env://SIGNING_SECRET --tlog-upload=false --yes \
  "${IMAGE_REF}@${candidate_digest}"
cosign verify --key "$IMAGE_LAYER_DIR/cosign.pub" --insecure-ignore-tlog \
  "${IMAGE_REF}@${candidate_digest}" > "$work_dir/cosign-verify.json"
jq -e 'length > 0' "$work_dir/cosign-verify.json" >/dev/null || \
  die "cosign verification returned no signatures"

cat > "$work_dir/verify-image.sh" <<'VERIFY'
#!/usr/bin/env bash
set -Eeuo pipefail
test "$(cat /usr/share/naia/naia-os-version)" = "$EXPECTED_NAIA_VERSION"
test "$(cat /usr/share/naia/sourcebuildmanifest)" = "$EXPECTED_SOURCE_BUILD"
test "$(rpm -q --qf '%{NAME} %{VERSION} %{RELEASE} %{ARCH}' naia)" = "naia 0.2.3 1 x86_64"
jq -e --arg source "$EXPECTED_SOURCE_COMMIT" --arg build "$EXPECTED_SOURCE_BUILD" \
  '.source_commit == $source and .source_build == $build and .source == $source and .build == $build' \
  /usr/share/naia/source-build-manifest.json >/dev/null
jq -e --arg tag "$EXPECTED_IMAGE_TAG" \
  '.["image-tag"] == $tag and .["image-branch"] == $tag' \
  /usr/share/ublue-os/image-info.json >/dev/null
/usr/libexec/naia-verify-image
VERIFY

podman run --rm -i --entrypoint /bin/bash \
  -e "EXPECTED_NAIA_VERSION=${NAIA_VERSION}" \
  -e "EXPECTED_SOURCE_BUILD=${SOURCE_BUILD}" \
  -e "EXPECTED_SOURCE_COMMIT=${SOURCE_COMMIT}" \
  -e "EXPECTED_IMAGE_TAG=${IMAGE_TAG}" \
  "${IMAGE_REF}@${candidate_digest}" -s < "$work_dir/verify-image.sh"

latest_after=""
if latest_after="$(skopeo inspect --format '{{.Digest}}' "docker://${IMAGE_REF}:latest" 2>/dev/null)"; then
  :
fi
[[ "$latest_after" == "$latest_before" ]] || \
  die "production :latest changed during candidate build (before=$latest_before after=$latest_after)"

receipt_path="${GITHUB_WORKSPACE:-.}/candidate-image-receipt.json"
jq -n \
  --arg product "naia-os" \
  --arg variant "amd" \
  --arg hardware "BC250/AMD candidate; hardware boot not validated" \
  --arg version "$NAIA_VERSION" \
  --arg source "$SOURCE_COMMIT" \
  --arg source_build "$SOURCE_BUILD" \
  --arg rpm_url "$RPM_URL" \
  --arg rpm_sha256 "$RPM_SHA256" \
  --arg base_image "$BASE_IMAGE" \
  --arg image_ref "$IMAGE_REF" \
  --arg image_tag "$IMAGE_TAG" \
  --arg image_digest "$candidate_digest" \
  --argjson signature_verified true \
  --argjson production_latest_unchanged true \
  --argjson candidate_only true \
  '{product: $product, variant: $variant, hardware_target: $hardware,
    version: $version, source_commit: $source, source_build: $source_build,
    rpm_url: $rpm_url, rpm_sha256: $rpm_sha256, base_image: $base_image,
    image_ref: $image_ref, image_tag: $image_tag, image_digest: $image_digest,
    signature_verified: $signature_verified,
    production_latest_unchanged: $production_latest_unchanged,
    candidate_only: $candidate_only}' > "$receipt_path"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "image_ref=${IMAGE_REF}"
    echo "image_tag=${IMAGE_TAG}"
    echo "image_digest=${candidate_digest}"
  } >> "$GITHUB_OUTPUT"
fi
echo "Candidate image and signature verified; production latest unchanged."
