# packages/shell/scripts/sign-windows-binary.ps1
# Tauri bundle signCommand script for Azure Artifact Signing (#725)
# Invoked by tauri bundle to sign Windows PE binaries (naia-shell.exe after bundle type patch).

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FilePath
)

$ErrorActionPreference = "Stop"

# Only sign in CI when explicitly enabled (NAIA_WINDOWS_SIGN=1).
# Otherwise do nothing and succeed to avoid breaking local/dev/offline builds.
if ($env:NAIA_WINDOWS_SIGN -ne "1") {
  Write-Host "NAIA_WINDOWS_SIGN is not enabled ('$env:NAIA_WINDOWS_SIGN'). Skipping signing for $FilePath"
  exit 0
}

# 1. In Windows PowerShell 5.1, re-run this script in pwsh (Core).
if ($PSVersionTable.PSEdition -ne "Core") {
  # Reset PSModulePath to Windows PowerShell defaults (pwsh 7 parent contaminates PSModulePath in CI run 36581799412)
  $env:PSModulePath = "$([Environment]::GetFolderPath('MyDocuments'))\WindowsPowerShell\Modules;$env:ProgramFiles\WindowsPowerShell\Modules;$PSHOME\Modules"

  $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
  if (-not $pwsh) {
    throw "PowerShell 7 (pwsh) is required for Azure Artifact Signing (NAIA_WINDOWS_SIGN=1), but 'pwsh' was not found in PATH."
  }

  & $pwsh.Source -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath $FilePath
  exit $LASTEXITCODE
}

# 2. In pwsh (Core), handle signing directly.
Write-Host "Running in PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
  throw "File to sign not found: $FilePath"
}

$fullPath = (Resolve-Path -LiteralPath $FilePath).Path
$fileName = [System.IO.Path]::GetFileName($fullPath)

# Preserve 3rd-party binaries: never touch node.exe or MSVC runtimes
if ($fileName -match '^(node\.exe|vcruntime.*\.dll|msvcp.*\.dll)$') {
  Write-Host "Skipping known third-party binary: $fileName"
  exit 0
}

# If the binary is already validly signed, keep the existing signature
$sig = Get-AuthenticodeSignature -LiteralPath $fullPath
if ($sig.Status -eq "Valid") {
  Write-Host "Binary is already validly signed ($($sig.SignerCertificate.Subject)). Skipping: $fileName"
  exit 0
}

# If the binary has a signature from a known 3rd party (e.g. Microsoft, OpenJS), never overwrite
if ($sig.SignerCertificate -and ($sig.SignerCertificate.Subject -match 'O=Microsoft|O=OpenJS')) {
  Write-Host "Binary has third-party signer ($($sig.SignerCertificate.Subject)). Skipping: $fileName"
  exit 0
}

if (-not (Get-Module -ListAvailable -Name ArtifactSigning | Where-Object { $_.Version -eq [version]'0.1.8' })) {
  Write-Host "Installing ArtifactSigning module v0.1.8 in pwsh..."
  Install-Module -Name ArtifactSigning -RequiredVersion 0.1.8 -Force -Repository PSGallery -Scope CurrentUser
}
Import-Module ArtifactSigning -RequiredVersion 0.1.8

Write-Host "Signing $fileName via Azure Artifact Signing in pwsh..."
# Replace broken signature after Tauri bundle patch (AppendSignature would preserve the invalid HashMismatch signature)
$signParams = @{
  Endpoint               = "https://krc.codesigning.azure.net/"
  CodeSigningAccountName = "nextain-public-signing"
  CertificateProfileName = "naia-public-trust"
  Files                  = $fullPath
  FileDigest             = "SHA256"
  TimestampRfc3161       = "http://timestamp.acs.microsoft.com"
  TimestampDigest        = "SHA256"
}
Invoke-ArtifactSigning @signParams

$postSig = Get-AuthenticodeSignature -LiteralPath $fullPath
if ($postSig.Status -ne "Valid") {
  throw "Authenticode signature validation failed for $fullPath after signing: $($postSig.Status)"
}

Write-Host "Successfully signed and verified: $fullPath"
