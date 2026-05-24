# build-windows.ps1
# 검수용 Windows 설치 파일 로컬 빌드 스크립트
#
# 사용법:
#   .\scripts\build-windows.ps1
#
# 결과물:
#   shell\src-tauri\target\release\bundle\nsis\Naia_*_x64-setup.exe

param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$ShellDir  = Join-Path $RepoRoot "shell"
$KeyFile   = Join-Path $RepoRoot "..\..\data-private\key\naia-tauri.key"
$TauriConf = "src-tauri\tauri.conf.windows.json"

Write-Host "[build-windows] 시작" -ForegroundColor Cyan

# 버전 일치 확인 (SoT: Cargo.toml)
$CargoVersion = (Select-String -Path (Join-Path $ShellDir "src-tauri\Cargo.toml") -Pattern '^version\s*=\s*"(.+)"').Matches[0].Groups[1].Value
$PkgVersion   = (Get-Content (Join-Path $ShellDir "package.json") | ConvertFrom-Json).version
if ($CargoVersion -ne $PkgVersion) {
    Write-Host "[build-windows] 경고: 버전 불일치 — Cargo.toml=$CargoVersion, package.json=$PkgVersion" -ForegroundColor Red
    Write-Host "               package.json을 $CargoVersion 으로 맞춰주세요." -ForegroundColor Red
    exit 1
}
Write-Host "[build-windows] 버전: $CargoVersion" -ForegroundColor Cyan

# 서명 키 확인
if (-not (Test-Path $KeyFile)) {
    Write-Error "서명 키를 찾을 수 없습니다: $KeyFile"
    exit 1
}

$env:TAURI_SIGNING_PRIVATE_KEY_PATH     = $KeyFile
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

# 캐시 정리 (-Clean 스위치 지정 시에만)
if ($Clean) {
    Write-Host "[build-windows] 캐시 정리 중..." -ForegroundColor Yellow
    Set-Location $ShellDir
    $DistDir = Join-Path $ShellDir "dist"
    if (Test-Path $DistDir) { Remove-Item -Recurse -Force $DistDir }
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    cargo clean --manifest-path src-tauri\Cargo.toml 2>&1 | Out-Null
    $ErrorActionPreference = $prev
} else {
    Write-Host "[build-windows] 증분 빌드 (캐시 유지)" -ForegroundColor Cyan
}

# 프론트엔드 빌드 (agent → shell 순서)
Write-Host "[build-windows] agent 빌드 중..." -ForegroundColor Cyan
$AgentDir = Join-Path $RepoRoot "agent"
Set-Location $AgentDir
pnpm install --frozen-lockfile
pnpm run build

# Resolve pnpm junctions (broken when Tauri bundles agent/node_modules as resources)
$junctions = Get-ChildItem -LiteralPath "$AgentDir\node_modules" -Directory | Where-Object { $_.LinkType -eq 'Junction' }
if ($junctions.Count -gt 0) {
    Write-Host "[build-windows] pnpm Junction 해제 중... ($($junctions.Count)개)" -ForegroundColor Yellow
    foreach ($j in $junctions) {
        $targetPath = if ($j.Target -is [array]) { $j.Target[0] } else { $j.Target }
        if (-not (Test-Path $targetPath)) { continue }
        $dest = $j.FullName
        Remove-Item -LiteralPath $dest -Force -Recurse
        robocopy $targetPath $dest /E /R:0 /W:0 /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    }
}

Write-Host "[build-windows] shell 프론트엔드 빌드 중..." -ForegroundColor Cyan
Set-Location $ShellDir
pnpm build

# Tauri 빌드
Write-Host "[build-windows] Tauri 빌드 시작 (20~30분 소요)..." -ForegroundColor Cyan
pnpm run tauri build --config $TauriConf

# 결과물 경로 출력
$NsisDir = Join-Path $ShellDir "src-tauri\target\release\bundle\nsis"
$Exe     = Get-ChildItem $NsisDir -Filter "*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

if ($Exe) {
    Write-Host ""
    Write-Host "[build-windows] 완료:" -ForegroundColor Green
    Write-Host "  $($Exe.FullName)" -ForegroundColor White
    Write-Host "  크기: $([math]::Round($Exe.Length / 1MB, 1)) MB" -ForegroundColor Gray
} else {
    Write-Error "빌드 실패: 결과물을 찾을 수 없습니다."
    exit 1
}
