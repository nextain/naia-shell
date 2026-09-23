#!/usr/bin/env bash
# End-user install step for the Naia Host (VoxCPM2 TensorRT) bundle on Linux.
#
# The Shell has already downloaded and verified the runtime archive into
# <bundle-root>/artifact. This script finishes the install on the user's
# machine, mirroring the Windows installer phase for phase:
#
#   1. verify the bundled artifact against its own manifest;
#   2. materialize the reference-voice palette declared by the activation
#      contract into the cache slot asset root;
#   3. acquire the pinned NVIDIA packages (TensorRT and, on Linux, the CUDA
#      library wheels PyTorch loads) from NVIDIA-controlled distribution into
#      <asset-root>/python-packages, outside the immutable artifact;
#   4. download the pinned VoxCPM2 model revision (receipt-verified);
#   5. build and verify the GPU-local TensorRT LocDiT engine;
#   6. write the ready receipt the Shell's post-install probe reads.
#
# Every phase prints one `VOXCPM2_PROGRESS {json}` line for the Shell's live
# progress UX. Only the pip and model phases touch the network.
#
#   prepare-voxcpm2-model.sh --bundle-root DIR --asset-root DIR --engine-dir DIR --state-root DIR
set -euo pipefail

BUNDLE_ROOT=""
ASSET_ROOT=""
ENGINE_DIR=""
STATE_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle-root) BUNDLE_ROOT="$2"; shift 2 ;;
    --asset-root) ASSET_ROOT="$2"; shift 2 ;;
    --engine-dir) ENGINE_DIR="$2"; shift 2 ;;
    --state-root) STATE_ROOT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$BUNDLE_ROOT" ] && [ -n "$ASSET_ROOT" ] && [ -n "$ENGINE_DIR" ] && [ -n "$STATE_ROOT" ] || { echo "--bundle-root, --asset-root, --engine-dir, and --state-root are required" >&2; exit 2; }

progress() {
  # $1 step, $2 label, $3 percent
  printf 'VOXCPM2_PROGRESS {"phase":"install","step":"%s","label":"%s","percent":%d}\n' "$1" "$2" "$3"
}

ARTIFACT_ROOT="$BUNDLE_ROOT/artifact"
MANIFEST_PATH="$ARTIFACT_ROOT/runtime-manifest.json"
ARTIFACT_MANIFEST_PATH="$ARTIFACT_ROOT/artifact-manifest.json"
INSTALLER_LOCK_PATH="$ARTIFACT_ROOT/installer-package-lock.json"
ACTIVATION_CONTRACT_PATH="$BUNDLE_ROOT/voxcpm2-activation-contract.json"
PYTHON="$ARTIFACT_ROOT/python/bin/python3"
[ -f "$PYTHON" ] || { echo "Bundled VoxCPM2 TensorRT Python runtime is missing: $PYTHON" >&2; exit 1; }
[ -x "$PYTHON" ] || chmod 0755 "$PYTHON" "$ARTIFACT_ROOT"/python/bin/python3.* 2>/dev/null || true
[ -f "$ACTIVATION_CONTRACT_PATH" ] || { echo "Naia Host activation contract is missing" >&2; exit 1; }

# JSON reads go through the bundled interpreter so the script needs no jq.
jget() { "$PYTHON" -B -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval("d"+sys.argv[2]))' "$1" "$2"; }

[ "$(jget "$MANIFEST_PATH" "['schemaVersion']")" = "3" ] || { echo "Unsupported VoxCPM2 runtime manifest" >&2; exit 1; }
[ "$(jget "$MANIFEST_PATH" "['profile']")" = "linux_trt_6g" ] || { echo "Unsupported VoxCPM2 runtime profile for Linux" >&2; exit 1; }
[ "$(jget "$INSTALLER_LOCK_PATH" "['schemaVersion']")" = "1" ] || { echo "Unsupported VoxCPM2 installer package lock" >&2; exit 1; }
[ "$(jget "$INSTALLER_LOCK_PATH" "['policy']")" = "automatic-installer-only" ] || { echo "Unsupported VoxCPM2 installer package lock policy" >&2; exit 1; }
[ "$(jget "$ACTIVATION_CONTRACT_PATH" "['schemaVersion']")" = "2" ] || { echo "Unsupported Naia Host activation contract" >&2; exit 1; }
MODEL_ID="$(jget "$MANIFEST_PATH" "['model']['id']")"
MODEL_REVISION="$(jget "$MANIFEST_PATH" "['model']['revision']")"
WORKSPACE_GIB="$(jget "$MANIFEST_PATH" "['engine']['workspaceGiB']")"

mkdir -p "$ASSET_ROOT"
ASSET_ROOT="$(cd "$ASSET_ROOT" && pwd -P)"
mkdir -p "$STATE_ROOT"
STATE_ROOT="$(cd "$STATE_ROOT" && pwd -P)"
ENGINE_PARENT="$(dirname "$ENGINE_DIR")"
mkdir -p "$ENGINE_PARENT"
ENGINE_PARENT="$(cd "$ENGINE_PARENT" && pwd -P)"
ENGINE_DIR="$ENGINE_PARENT/$(basename "$ENGINE_DIR")"

export HF_HOME="$STATE_ROOT/hf-cache"
export HF_HUB_DISABLE_XET=1
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
export PYTHONDONTWRITEBYTECODE=1
export NUMBA_CACHE_DIR="$STATE_ROOT/state/cache/numba"
mkdir -p "$NUMBA_CACHE_DIR"

# Fail closed early if the asset volume lacks room: a fresh install needs the
# model (~4.7 GiB), the NVIDIA packages (~3 GiB on Linux) and the engine.
MODEL_DIR="$ASSET_ROOT/models/VoxCPM2"
REQUIRED_GIB=9
[ -f "$MODEL_DIR/model.safetensors" ] && REQUIRED_GIB=4
FREE_GIB="$(df -Pk "$ASSET_ROOT" | awk 'NR==2 {printf "%d", $4/1048576}')"
if [ "$FREE_GIB" -lt "$REQUIRED_GIB" ]; then
  progress "disk" "Not enough free disk space" 0
  echo "insufficient_disk_space: $ASSET_ROOT has ${FREE_GIB} GiB free but >= ${REQUIRED_GIB} GiB is required. Free space on that volume and try again." >&2
  exit 1
fi
progress "disk" "Disk space OK (${FREE_GIB} GiB free)" 3

run_python() { # $1 failure message, rest: python args
  local failure="$1"; shift
  if ! "$PYTHON" "$@"; then echo "$failure" >&2; exit 1; fi
}
try_python() { "$PYTHON" "$@" >/dev/null 2>&1; }

progress "verify" "Verifying the bundled runtime" 5
NAIA_VOXCPM2_ARTIFACT_ROOT="$ARTIFACT_ROOT" run_python "Bundled VoxCPM2 artifact verification failed" \
  -B -I -c "import os; from voxcpm2_tensorrt.artifact import verify_artifact; verify_artifact(os.environ['NAIA_VOXCPM2_ARTIFACT_ROOT'])"

# Reference voices: the activation contract declares an immutable palette
# (id, HTTPS url, sha256, bytes, default). Materialize every entry into the
# user-writable runtime so each preview choice is resolvable by synthesis.
progress "reference-voice" "Preparing the host voice palette" 35
VOICES_ROOT="$ASSET_ROOT/voices"
mkdir -p "$VOICES_ROOT"
VOICE_TABLE="$("$PYTHON" -B -I - "$ACTIVATION_CONTRACT_PATH" <<'PY'
import json, sys, os
contract = json.load(open(sys.argv[1]))
voices = contract["runtime"]["referenceVoices"]
if not voices:
    raise SystemExit("Naia Host activation contract must declare reference voices")
if sum(1 for v in voices if v.get("default") is True) != 1:
    raise SystemExit("Naia Host activation contract must declare exactly one default reference voice")
seen = set()
for v in voices:
    vid, url, sha, size = str(v["id"]), str(v["url"]), str(v["sha256"]).lower(), int(v["bytes"])
    if os.path.basename(vid) != vid or not vid.lower().endswith(".wav"):
        raise SystemExit("Naia Host reference voice id is invalid")
    if vid.lower() in seen:
        raise SystemExit("Naia Host reference voice id is duplicated")
    seen.add(vid.lower())
    if not url.lower().startswith("https://"):
        raise SystemExit("Naia Host reference voice URL must use HTTPS")
    if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha) or size <= 0:
        raise SystemExit("Naia Host reference voice digest contract is invalid")
    print(f"{vid}\t{url}\t{sha}\t{size}")
PY
)"
voice_ok() { # $1 path $2 sha $3 bytes
  [ -f "$1" ] || return 1
  [ "$(stat -c %s "$1")" = "$3" ] || return 1
  [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ] || return 1
  [ "$(head -c 4 "$1")" = "RIFF" ] && [ "$(dd if="$1" bs=1 skip=8 count=4 2>/dev/null)" = "WAVE" ]
}
VOICE_COUNT="$(printf '%s\n' "$VOICE_TABLE" | wc -l)"
VOICE_INDEX=0
while IFS=$'\t' read -r VOICE_ID VOICE_URL VOICE_SHA VOICE_BYTES; do
  [ -n "$VOICE_ID" ] || continue
  VOICE_PATH="$VOICES_ROOT/$VOICE_ID"
  progress "reference-voice" "Preparing host voice $((VOICE_INDEX + 1))/$VOICE_COUNT" $((35 + VOICE_INDEX * 5 / VOICE_COUNT))
  if ! voice_ok "$VOICE_PATH" "$VOICE_SHA" "$VOICE_BYTES"; then
    rm -f "$VOICE_PATH.pending"
    curl -fsSL --retry 3 --max-time 120 -o "$VOICE_PATH.pending" "$VOICE_URL"
    voice_ok "$VOICE_PATH.pending" "$VOICE_SHA" "$VOICE_BYTES" || { rm -f "$VOICE_PATH.pending"; echo "Downloaded host voice failed SHA-256, size, or WAV verification: $VOICE_ID" >&2; exit 1; }
    mv -f "$VOICE_PATH.pending" "$VOICE_PATH"
  fi
  voice_ok "$VOICE_PATH" "$VOICE_SHA" "$VOICE_BYTES" || { echo "Verified host voice is not installed: $VOICE_ID" >&2; exit 1; }
  VOICE_INDEX=$((VOICE_INDEX + 1))
done <<< "$VOICE_TABLE"
progress "reference-voice" "Host voice palette ready" 40

# NVIDIA packages: TensorRT, and on Linux the CUDA library wheels the PyTorch
# cu121 wheel loads at import. Acquired from NVIDIA-controlled distribution
# during this explicit online transaction, staged outside the immutable
# artifact, verified by exact version, and recorded with pip's reports.
NVIDIA_ROOT="$ASSET_ROOT/python-packages"
NVIDIA_PENDING="$ASSET_ROOT/python-packages.pending"
NVIDIA_BACKUP="$ASSET_ROOT/python-packages.backup"
NVIDIA_RECEIPT="$NVIDIA_ROOT/naia-nvidia-package-receipt.json"
INSTALLER_LOCK_SHA="$(sha256sum "$INSTALLER_LOCK_PATH" | cut -d' ' -f1)"
VERIFY_NVIDIA="$("$PYTHON" -B -I - "$INSTALLER_LOCK_PATH" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
checks = "; ".join(f"assert m.version({name!r}) == {version!r}" for name, version in lock["packages"].items())
print("import importlib.metadata as m, tensorrt; " + checks)
PY
)"
NVIDIA_READY=0
if [ -f "$NVIDIA_RECEIPT" ]; then
  if [ "$(jget "$NVIDIA_RECEIPT" "['installerPackageLockSha256']")" = "$INSTALLER_LOCK_SHA" ]; then
    if PYTHONPATH="$NVIDIA_ROOT" try_python -B -s -c "$VERIFY_NVIDIA"; then NVIDIA_READY=1; fi
  fi
fi
if [ "$NVIDIA_READY" -ne 1 ]; then
  progress "nvidia" "Acquiring pinned NVIDIA TensorRT and CUDA packages" 42
  rm -rf "$NVIDIA_PENDING"; mkdir -p "$NVIDIA_PENDING"
  NVIDIA_REPORT="$NVIDIA_PENDING/pip-report-nvidia.json"
  PYPI_REPORT="$NVIDIA_PENDING/pip-report-pypi.json"
  NVIDIA_REQ="$NVIDIA_PENDING/requirements-nvidia.txt"
  PYPI_REQ="$NVIDIA_PENDING/requirements-pypi.txt"
  "$PYTHON" -B -I - "$INSTALLER_LOCK_PATH" "$NVIDIA_REQ" "$PYPI_REQ" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
nvidia, pypi = [], []
for name, version in lock["packages"].items():
    (nvidia if lock["sources"][name].startswith("https://pypi.nvidia.com") else pypi).append(f"{name}=={version}")
open(sys.argv[2], "w").write("\n".join(nvidia) + "\n")
open(sys.argv[3], "w").write("\n".join(pypi) + "\n")
PY
  run_python "Pinned NVIDIA runtime acquisition failed" \
    -B -I -m pip install --disable-pip-version-check --no-deps --target "$NVIDIA_PENDING" \
    --report "$NVIDIA_REPORT" --index-url https://pypi.nvidia.com -r "$NVIDIA_REQ"
  # The tensorrt-cu12 metapackage's setup runs a nested pip install of the
  # bindings and libraries into the building interpreter, ignoring --target.
  # With the pending tree on PYTHONPATH it finds them satisfied and leaves
  # the immutable artifact untouched. `-I` would hide PYTHONPATH, so `-s`.
  PYTHONPATH="$NVIDIA_PENDING" run_python "Pinned TensorRT Python package acquisition failed" \
    -B -s -m pip install --disable-pip-version-check --no-deps --target "$NVIDIA_PENDING" \
    --report "$PYPI_REPORT" --index-url https://pypi.org/simple -r "$PYPI_REQ"
  PYTHONPATH="$NVIDIA_PENDING" run_python "Acquired TensorRT package verification failed" -B -s -c "$VERIFY_NVIDIA"
  "$PYTHON" -B -I - "$INSTALLER_LOCK_PATH" "$INSTALLER_LOCK_SHA" "$NVIDIA_REPORT" "$PYPI_REPORT" "$NVIDIA_PENDING/naia-nvidia-package-receipt.json" <<'PY'
import hashlib, json, sys
lock = json.load(open(sys.argv[1]))
def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()
receipt = {
    "schemaVersion": 1,
    "installerPackageLockSha256": sys.argv[2],
    "sources": lock["sources"],
    "nvidiaReportSha256": sha(sys.argv[3]),
    "pypiReportSha256": sha(sys.argv[4]),
}
open(sys.argv[5], "w", encoding="utf-8").write(json.dumps(receipt, indent=2) + "\n")
PY
  rm -rf "$NVIDIA_BACKUP"
  [ -d "$NVIDIA_ROOT" ] && mv "$NVIDIA_ROOT" "$NVIDIA_BACKUP"
  if ! mv "$NVIDIA_PENDING" "$NVIDIA_ROOT"; then
    [ -d "$NVIDIA_ROOT" ] || { [ -d "$NVIDIA_BACKUP" ] && mv "$NVIDIA_BACKUP" "$NVIDIA_ROOT"; }
    echo "Could not activate the acquired NVIDIA packages" >&2; exit 1
  fi
  rm -rf "$NVIDIA_BACKUP"
fi
export PYTHONPATH="$NVIDIA_ROOT"
progress "nvidia" "NVIDIA TensorRT and CUDA packages ready" 50
run_python "Bundled VoxCPM2 TensorRT runtime verification failed" \
  -B -s -c "import torch,voxcpm,soundfile,tensorrt,onnx; import voxcpm2_tensorrt.http_server; assert torch.cuda.is_available()"

# Pinned model: receipt-verified, downloaded once.
progress "model" "Preparing the voice model" 55
MODEL_ARGS=(-B -s -c "from voxcpm2_tensorrt.materialize_voxcpm2_model import main; main()" --repo "$MODEL_ID" --revision "$MODEL_REVISION" --model-dir "$MODEL_DIR")
if ! try_python "${MODEL_ARGS[@]}" --verify-only; then
  echo "VOXCPM2_MODEL_PREPARE_REQUIRED"
  progress "model" "Downloading the voice model" 56
  run_python "Pinned VoxCPM2 model materialization failed" "${MODEL_ARGS[@]}"
fi
progress "model" "Voice model ready" 70

# The Shell holds the cache slot's exclusive lock for the whole run of this script, and every running voice server holds the shared lock for its lifetime, so no process has EngineDir mapped while this runs. A different GPU, driver or TensorRT version is a different EngineDir (a new generation); an existing generation of another stamp is never touched.
ENGINE_PENDING="$ENGINE_DIR.pending"
ENGINE_BACKUP="$ENGINE_DIR.backup"
export NAIA_VOXCPM2_ENGINE_DIR="$ENGINE_DIR"
export NAIA_VOXCPM2_MODEL_DIR="$MODEL_DIR"
export NAIA_VOXCPM2_MODEL_ID="$MODEL_ID"
export NAIA_VOXCPM2_MODEL_REVISION="$MODEL_REVISION"
VERIFY_ENGINE="import os; from pathlib import Path; from voxcpm2_tensorrt.model_contract import MODEL_RECEIPT_NAME,sha256_file; from voxcpm2_tensorrt.voxcpm2_trt import TensorRTLocDiT,load_engine_manifest; m=load_engine_manifest(os.environ['NAIA_VOXCPM2_ENGINE_DIR'],model_id=os.environ['NAIA_VOXCPM2_MODEL_ID']); assert m.data['model_revision']==os.environ['NAIA_VOXCPM2_MODEL_REVISION'].lower(); assert m.data['model_receipt_sha256']==sha256_file(Path(os.environ['NAIA_VOXCPM2_MODEL_DIR'])/MODEL_RECEIPT_NAME); TensorRTLocDiT(m)"
if ! try_python -B -s -c "$VERIFY_ENGINE"; then
  echo "VOXCPM2_ENGINE_PREPARE_REQUIRED"
  progress "engine" "Building the GPU engine" 75
  rm -rf "$ENGINE_PENDING"; mkdir -p "$ENGINE_PENDING"
  run_python "VoxCPM2 TensorRT engine preparation failed" \
    -B -s -c "from voxcpm2_tensorrt.build_voxcpm2_trt import main; main()" \
    --model "$MODEL_ID" --revision "$MODEL_REVISION" --model-dir "$MODEL_DIR" \
    --output-dir "$ENGINE_PENDING" --workspace-gib "$WORKSPACE_GIB"
  rm -rf "$ENGINE_BACKUP"
  [ -d "$ENGINE_DIR" ] && mv "$ENGINE_DIR" "$ENGINE_BACKUP"
  if ! mv "$ENGINE_PENDING" "$ENGINE_DIR"; then
    [ -d "$ENGINE_DIR" ] || { [ -d "$ENGINE_BACKUP" ] && mv "$ENGINE_BACKUP" "$ENGINE_DIR"; }
    echo "Could not activate the prepared engine" >&2; exit 1
  fi
  rm -rf "$ENGINE_BACKUP"
  run_python "Prepared VoxCPM2 TensorRT engine verification failed" -B -s -c "$VERIFY_ENGINE"
fi
progress "engine" "GPU engine ready" 95

# Ready receipt: the Shell's post-install probe compares the model revision
# and the artifact manifest digest against the shipped bundle.
READY_PATH="$ASSET_ROOT/voxcpm2-runtime-ready.json"
"$PYTHON" -B -I - "$ARTIFACT_MANIFEST_PATH" "$MANIFEST_PATH" "$ACTIVATION_CONTRACT_PATH" "$READY_PATH.pending" <<'PY'
import hashlib, json, sys
artifact = json.load(open(sys.argv[1]))
manifest = json.load(open(sys.argv[2]))
contract = json.load(open(sys.argv[3]))
ready = {
    "schemaVersion": 1,
    "profile": manifest["profile"],
    "artifactManifestSha256": hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest(),
    "source": artifact.get("source"),
    "model": manifest["model"],
    "referenceVoices": [
        {"id": str(v["id"]), "sha256": str(v["sha256"]).lower(), "bytes": int(v["bytes"]), "default": bool(v.get("default"))}
        for v in contract["runtime"]["referenceVoices"]
    ],
}
open(sys.argv[4], "w", encoding="utf-8").write(json.dumps(ready, indent=2) + "\n")
PY
mv -f "$READY_PATH.pending" "$READY_PATH"
progress "done" "Local voice runtime ready" 100
echo "VOXCPM2_MODEL_READY"
