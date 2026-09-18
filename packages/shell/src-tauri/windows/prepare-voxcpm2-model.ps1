param(
  [Parameter(Mandatory=$true)][string]$BundleRoot,
  [Parameter(Mandatory=$true)][string]$RuntimeRoot
)

$ErrorActionPreference = "Stop"

function ConvertFrom-VerbatimPath([string]$Path) {
  if ($Path.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { return '\\' + $Path.Substring(8) }
  if ($Path.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) { return $Path.Substring(4) }
  return $Path
}

function Invoke-Runtime([string[]]$Arguments, [string]$Failure) {
  & $script:Python @Arguments
  if ($LASTEXITCODE -ne 0) { throw $Failure }
}

function Test-Runtime([string[]]$Arguments) {
  # PowerShell 5 turns native stderr into a terminating NativeCommandError
  # when ErrorActionPreference is Stop. Verification probes intentionally
  # fail before first install, so observe only their process exit code.
  $PriorErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $script:Python @Arguments *> $null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $PriorErrorActionPreference
  }
}

function Write-InstallProgress([string]$Step, [string]$Label, [int]$Percent) {
  $Progress = [ordered]@{ phase = "install"; step = $Step; label = $Label; percent = $Percent }
  Write-Output ("VOXCPM2_PROGRESS " + ($Progress | ConvertTo-Json -Compress))
}

function Test-ReferenceVoice([string]$Path, [object]$Contract) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $Item = Get-Item -LiteralPath $Path
  if ($Item.Length -ne [long]$Contract.bytes) { return $false }
  $ActualSha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualSha256 -ne ([string]$Contract.sha256).ToLowerInvariant()) { return $false }
  $Stream = [IO.File]::OpenRead($Path)
  try {
    $Header = New-Object byte[] 12
    if ($Stream.Read($Header, 0, $Header.Length) -ne $Header.Length) { return $false }
    return [Text.Encoding]::ASCII.GetString($Header, 0, 4) -eq "RIFF" -and [Text.Encoding]::ASCII.GetString($Header, 8, 4) -eq "WAVE"
  } finally {
    $Stream.Dispose()
  }
}

$BundleRoot = ConvertFrom-VerbatimPath $BundleRoot
$RuntimeRoot = ConvertFrom-VerbatimPath $RuntimeRoot
$ArtifactRoot = Join-Path $BundleRoot "artifact"
$ManifestPath = Join-Path $ArtifactRoot "runtime-manifest.json"
$ArtifactManifestPath = Join-Path $ArtifactRoot "artifact-manifest.json"
$InstallerPackageLockPath = Join-Path $ArtifactRoot "installer-package-lock.json"
$ActivationContractPath = Join-Path $BundleRoot "voxcpm2-activation-contract.json"
$script:Python = Join-Path $ArtifactRoot "python\python.exe"
if (-not (Test-Path -LiteralPath $script:Python -PathType Leaf)) { throw "Bundled VoxCPM2 TensorRT Python runtime is missing" }
if (-not (Test-Path -LiteralPath $ActivationContractPath -PathType Leaf)) { throw "Naia Host activation contract is missing" }

$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$ArtifactManifest = Get-Content -LiteralPath $ArtifactManifestPath -Raw | ConvertFrom-Json
$InstallerPackageLock = Get-Content -LiteralPath $InstallerPackageLockPath -Raw | ConvertFrom-Json
$ActivationContract = Get-Content -LiteralPath $ActivationContractPath -Raw | ConvertFrom-Json
if ($Manifest.schemaVersion -ne 3 -or $Manifest.profile -ne "windows_trt_6g") { throw "Unsupported VoxCPM2 runtime manifest" }
if ($InstallerPackageLock.schemaVersion -ne 1 -or $InstallerPackageLock.policy -ne "automatic-installer-only") { throw "Unsupported VoxCPM2 installer package lock" }
# The activation contract is one file for every operating system (schema 2):
# OS-specific layout lives under `platforms`, the reference-voice palette is
# shared under `runtime`. Schema 1 (one OS, `profile` at the root) is accepted
# for bundles staged before the split.
$ContractSupported = $false
if ($ActivationContract.schemaVersion -eq 2) {
  $ContractSupported = ($null -ne $ActivationContract.platforms) -and ($null -ne $ActivationContract.platforms.windows)
} elseif ($ActivationContract.schemaVersion -eq 1) {
  $ContractSupported = ($ActivationContract.profile -eq "windows_trt_6g")
}
if (-not $ContractSupported) { throw "Unsupported Naia Host activation contract" }
$ReferenceVoices = @($ActivationContract.runtime.referenceVoices)
$DefaultVoices = @($ReferenceVoices | Where-Object { $_.default -eq $true })
if ($ReferenceVoices.Count -lt 1) { throw "Naia Host activation contract must declare reference voices" }
if ($DefaultVoices.Count -ne 1) { throw "Naia Host activation contract must declare exactly one default reference voice" }
$DefaultVoice = $DefaultVoices[0]
$DefaultVoiceId = [string]$DefaultVoice.id
$SeenVoiceIds = @{}
foreach ($Voice in $ReferenceVoices) {
  $VoiceId = [string]$Voice.id
  $VoiceUrl = [string]$Voice.url
  $VoiceSha256 = [string]$Voice.sha256
  $VoiceBytes = [long]$Voice.bytes
  if ([IO.Path]::GetFileName($VoiceId) -ne $VoiceId -or -not $VoiceId.EndsWith(".wav", [StringComparison]::OrdinalIgnoreCase)) { throw "Naia Host reference voice id is invalid" }
  if ($SeenVoiceIds.ContainsKey($VoiceId.ToLowerInvariant())) { throw "Naia Host reference voice id is duplicated" }
  $SeenVoiceIds[$VoiceId.ToLowerInvariant()] = $true
  if (-not $VoiceUrl.StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) { throw "Naia Host reference voice URL must use HTTPS" }
  if (-not ($VoiceSha256 -match '^[a-fA-F0-9]{64}$') -or $VoiceBytes -le 0) { throw "Naia Host reference voice digest contract is invalid" }
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
$env:HF_HOME = Join-Path $RuntimeRoot "hf-cache"
$env:HF_HUB_DISABLE_XET = "1"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONDONTWRITEBYTECODE = "1"
$env:NUMBA_CACHE_DIR = Join-Path $RuntimeRoot "state\cache\numba"
New-Item -ItemType Directory -Force -Path $env:NUMBA_CACHE_DIR | Out-Null
$env:NAIA_VOXCPM2_ARTIFACT_ROOT = $ArtifactRoot

Invoke-Runtime @("-B", "-I", "-c", "import os; from voxcpm2_tensorrt.artifact import verify_artifact; verify_artifact(os.environ['NAIA_VOXCPM2_ARTIFACT_ROOT'])") "Bundled VoxCPM2 artifact verification failed"

# The Shell preview streams approved WAVs directly from Azure, while local
# synthesis passes only the selected id. Materialize the complete immutable
# palette in the user-writable runtime so every preview choice is resolvable by
# synthesis. Missing non-default voices must fail the install instead of being
# hidden by the synthesis layer's safety fallback to the default voice.
Write-InstallProgress "reference-voice" "Preparing the host voice palette" 35
$VoicesRoot = Join-Path $RuntimeRoot "voices"
New-Item -ItemType Directory -Force -Path $VoicesRoot | Out-Null
for ($VoiceIndex = 0; $VoiceIndex -lt $ReferenceVoices.Count; $VoiceIndex++) {
  $Voice = $ReferenceVoices[$VoiceIndex]
  $VoiceId = [string]$Voice.id
  $VoicePath = Join-Path $VoicesRoot $VoiceId
  $VoicePending = "$VoicePath.pending"
  $VoiceBackup = "$VoicePath.backup"
  $VoiceProgress = 35 + [int](($VoiceIndex / $ReferenceVoices.Count) * 5)
  Write-InstallProgress "reference-voice" "Preparing host voice $($VoiceIndex + 1)/$($ReferenceVoices.Count)" $VoiceProgress
  if (-not (Test-ReferenceVoice $VoicePath $Voice)) {
    if (Test-Path -LiteralPath $VoicePending) { Remove-Item -LiteralPath $VoicePending -Force }
    try {
      Invoke-WebRequest -UseBasicParsing -Uri ([string]$Voice.url) -OutFile $VoicePending
      if (-not (Test-ReferenceVoice $VoicePending $Voice)) { throw "Downloaded host voice failed SHA-256, size, or WAV verification: $VoiceId" }
      if (Test-Path -LiteralPath $VoiceBackup) { Remove-Item -LiteralPath $VoiceBackup -Force }
      if (Test-Path -LiteralPath $VoicePath) { Move-Item -LiteralPath $VoicePath -Destination $VoiceBackup }
      try { Move-Item -LiteralPath $VoicePending -Destination $VoicePath }
      catch {
        if ((-not (Test-Path -LiteralPath $VoicePath)) -and (Test-Path -LiteralPath $VoiceBackup)) { Move-Item -LiteralPath $VoiceBackup -Destination $VoicePath }
        throw
      }
      if (Test-Path -LiteralPath $VoiceBackup) { Remove-Item -LiteralPath $VoiceBackup -Force }
    } finally {
      if (Test-Path -LiteralPath $VoicePending) { Remove-Item -LiteralPath $VoicePending -Force }
    }
  }
  if (-not (Test-ReferenceVoice $VoicePath $Voice)) { throw "Verified host voice is not installed: $VoiceId" }
}
Write-InstallProgress "reference-voice" "Host voice palette ready" 40

Write-InstallProgress "nvidia" "Acquiring pinned NVIDIA TensorRT and CUDA packages" 42

# TensorRT's Python/runtime distributions are acquired automatically from the
# NVIDIA-controlled index during this explicit online installer transaction.
# They are staged outside the immutable product artifact, verified by exact
# version, and recorded with pip's URL/archive-hash reports.
$NvidiaRoot = Join-Path $RuntimeRoot "python-packages"
$NvidiaPending = Join-Path $RuntimeRoot "python-packages.pending"
$NvidiaBackup = Join-Path $RuntimeRoot "python-packages.backup"
$NvidiaReceipt = Join-Path $NvidiaRoot "naia-nvidia-package-receipt.json"
$InstallerLockSha256 = (Get-FileHash -LiteralPath $InstallerPackageLockPath -Algorithm SHA256).Hash.ToLowerInvariant()
$VerifyNvidia = "import importlib.metadata as m, tensorrt; assert m.version('tensorrt-cu12') == '$($InstallerPackageLock.packages.'tensorrt-cu12')'; assert m.version('tensorrt-cu12-bindings') == '$($InstallerPackageLock.packages.'tensorrt-cu12-bindings')'; assert m.version('tensorrt-cu12-libs') == '$($InstallerPackageLock.packages.'tensorrt-cu12-libs')'; assert m.version('nvidia-cuda-runtime-cu12') == '$($InstallerPackageLock.packages.'nvidia-cuda-runtime-cu12')'"
$NvidiaReady = $false
if (Test-Path -LiteralPath $NvidiaReceipt -PathType Leaf) {
  try {
    $Receipt = Get-Content -LiteralPath $NvidiaReceipt -Raw | ConvertFrom-Json
    if ($Receipt.installerPackageLockSha256 -eq $InstallerLockSha256) {
      $env:PYTHONPATH = $NvidiaRoot
      $NvidiaReady = Test-Runtime @("-B", "-s", "-c", $VerifyNvidia)
    }
  } catch { $NvidiaReady = $false }
}
if (-not $NvidiaReady) {
  if (Test-Path -LiteralPath $NvidiaPending) { Remove-Item -LiteralPath $NvidiaPending -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $NvidiaPending | Out-Null
  $NvidiaReport = Join-Path $NvidiaPending "pip-report-nvidia.json"
  $PyPiReport = Join-Path $NvidiaPending "pip-report-pypi.json"
  Invoke-Runtime @(
    "-B", "-I", "-m", "pip", "install", "--disable-pip-version-check",
    "--no-deps", "--target", $NvidiaPending, "--report", $NvidiaReport,
    "--index-url", "https://pypi.nvidia.com",
    "tensorrt-cu12_bindings==$($InstallerPackageLock.packages.'tensorrt-cu12-bindings')",
    "tensorrt-cu12_libs==$($InstallerPackageLock.packages.'tensorrt-cu12-libs')",
    "nvidia-cuda-runtime-cu12==$($InstallerPackageLock.packages.'nvidia-cuda-runtime-cu12')"
  ) "Pinned NVIDIA runtime acquisition failed"
  Invoke-Runtime @(
    "-B", "-I", "-m", "pip", "install", "--disable-pip-version-check",
    "--no-deps", "--target", $NvidiaPending, "--report", $PyPiReport,
    "--index-url", "https://pypi.org/simple",
    "tensorrt-cu12==$($InstallerPackageLock.packages.'tensorrt-cu12')"
  ) "Pinned TensorRT Python package acquisition failed"
  $env:PYTHONPATH = $NvidiaPending
  Invoke-Runtime @("-B", "-s", "-c", $VerifyNvidia) "Acquired TensorRT package verification failed"
  $Receipt = [ordered]@{
    schemaVersion = 1
    installerPackageLockSha256 = $InstallerLockSha256
    sources = $InstallerPackageLock.sources
    nvidiaReportSha256 = (Get-FileHash -LiteralPath $NvidiaReport -Algorithm SHA256).Hash.ToLowerInvariant()
    pypiReportSha256 = (Get-FileHash -LiteralPath $PyPiReport -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  [IO.File]::WriteAllText(
    (Join-Path $NvidiaPending "naia-nvidia-package-receipt.json"),
    (($Receipt | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )
  if (Test-Path -LiteralPath $NvidiaBackup) { Remove-Item -LiteralPath $NvidiaBackup -Recurse -Force }
  if (Test-Path -LiteralPath $NvidiaRoot) { Move-Item -LiteralPath $NvidiaRoot -Destination $NvidiaBackup }
  try { Move-Item -LiteralPath $NvidiaPending -Destination $NvidiaRoot }
  catch {
    if ((-not (Test-Path -LiteralPath $NvidiaRoot)) -and (Test-Path -LiteralPath $NvidiaBackup)) { Move-Item -LiteralPath $NvidiaBackup -Destination $NvidiaRoot }
    throw
  }
  if (Test-Path -LiteralPath $NvidiaBackup) { Remove-Item -LiteralPath $NvidiaBackup -Recurse -Force }
}
Write-InstallProgress "nvidia" "NVIDIA TensorRT and CUDA packages ready" 50
$env:PYTHONPATH = $NvidiaRoot
Invoke-Runtime @("-B", "-s", "-c", "import torch,voxcpm,soundfile,tensorrt,onnx; import voxcpm2_tensorrt.http_server; assert torch.cuda.is_available()") "Bundled VoxCPM2 TensorRT runtime verification failed"

$ModelDir = Join-Path $RuntimeRoot "models\VoxCPM2"
$ModelArgs = @("-B", "-s", "-c", "from voxcpm2_tensorrt.materialize_voxcpm2_model import main; main()", "--repo", [string]$Manifest.model.id, "--revision", [string]$Manifest.model.revision, "--model-dir", $ModelDir)
Write-InstallProgress "model" "Preparing the voice model" 55
if (-not (Test-Runtime @($ModelArgs + "--verify-only"))) {
  Write-Output "VOXCPM2_MODEL_PREPARE_REQUIRED"
  Write-InstallProgress "model" "Downloading the voice model" 56
  Invoke-Runtime $ModelArgs "Pinned VoxCPM2 model materialization failed"
}
Write-InstallProgress "model" "Voice model ready" 70

$Checkpoints = Join-Path $RuntimeRoot "checkpoints"
$Engine = Join-Path $Checkpoints "voxcpm2_trt"
$Pending = Join-Path $Checkpoints "voxcpm2_trt.pending"
$Backup = Join-Path $Checkpoints "voxcpm2_trt.backup"
$env:NAIA_VOXCPM2_ENGINE_DIR = $Engine
$env:NAIA_VOXCPM2_MODEL_DIR = $ModelDir
$env:NAIA_VOXCPM2_MODEL_ID = [string]$Manifest.model.id
$env:NAIA_VOXCPM2_MODEL_REVISION = [string]$Manifest.model.revision
$VerifyEngine = "import os; from pathlib import Path; from voxcpm2_tensorrt.model_contract import MODEL_RECEIPT_NAME,sha256_file; from voxcpm2_tensorrt.voxcpm2_trt import TensorRTLocDiT,load_engine_manifest; m=load_engine_manifest(os.environ['NAIA_VOXCPM2_ENGINE_DIR'],model_id=os.environ['NAIA_VOXCPM2_MODEL_ID']); assert m.data['model_revision']==os.environ['NAIA_VOXCPM2_MODEL_REVISION'].lower(); assert m.data['model_receipt_sha256']==sha256_file(Path(os.environ['NAIA_VOXCPM2_MODEL_DIR'])/MODEL_RECEIPT_NAME); TensorRTLocDiT(m)"
if (-not (Test-Runtime @("-B", "-s", "-c", $VerifyEngine))) {
  Write-Output "VOXCPM2_ENGINE_PREPARE_REQUIRED"
  Write-InstallProgress "engine" "Building the GPU engine" 75
  if (Test-Path -LiteralPath $Pending) { Remove-Item -LiteralPath $Pending -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Pending | Out-Null
  Invoke-Runtime @("-B", "-s", "-c", "from voxcpm2_tensorrt.build_voxcpm2_trt import main; main()", "--model", [string]$Manifest.model.id, "--revision", [string]$Manifest.model.revision, "--model-dir", $ModelDir, "--output-dir", $Pending, "--workspace-gib", "1.0") "VoxCPM2 TensorRT engine preparation failed"
  if (Test-Path -LiteralPath $Backup) { Remove-Item -LiteralPath $Backup -Recurse -Force }
  if (Test-Path -LiteralPath $Engine) { Move-Item -LiteralPath $Engine -Destination $Backup }
  try {
    Move-Item -LiteralPath $Pending -Destination $Engine
  } catch {
    if ((-not (Test-Path -LiteralPath $Engine)) -and (Test-Path -LiteralPath $Backup)) { Move-Item -LiteralPath $Backup -Destination $Engine }
    throw
  }
  if (Test-Path -LiteralPath $Backup) { Remove-Item -LiteralPath $Backup -Recurse -Force }
  Invoke-Runtime @("-B", "-s", "-c", $VerifyEngine) "Prepared VoxCPM2 TensorRT engine verification failed"
}
Write-InstallProgress "engine" "GPU engine ready" 95

$Ready = [ordered]@{
  schemaVersion = 1
  profile = "windows_trt_6g"
  artifactManifestSha256 = (Get-FileHash -LiteralPath $ArtifactManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  source = $ArtifactManifest.source
  model = $Manifest.model
  referenceVoices = @($ReferenceVoices | ForEach-Object {
    [ordered]@{
      id = [string]$_.id
      sha256 = ([string]$_.sha256).ToLowerInvariant()
      bytes = [long]$_.bytes
      default = [bool]$_.default
    }
  })
}
$ReadyPath = Join-Path $RuntimeRoot "voxcpm2-runtime-ready.json"
$ReadyPending = "$ReadyPath.pending"
[IO.File]::WriteAllText($ReadyPending, (($Ready | ConvertTo-Json -Depth 8) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $ReadyPending -Destination $ReadyPath -Force
Write-InstallProgress "done" "Local voice runtime ready" 100
Write-Output "VOXCPM2_MODEL_READY"
