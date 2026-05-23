# deploy.ps1
# Naia OS 릴리즈 배포 스크립트
#
# 릴리즈 워크플로우:
#   1. 개발
#   2. 검수용 빌드 (build-windows.ps1)
#   3. 유저 검수완료
#   4. 릴리즈 노트 작성 (CHANGELOG.md)
#   5. 릴리즈 허가 → echo approved > .agents\release-approved
#   6. 이 스크립트 실행
#
# 사용법:
#   .\scripts\deploy.ps1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# ── 1. 승인 플래그 확인 ──────────────────────────────────────────────────
$FlagFile = Join-Path $RepoRoot ".agents\release-approved"
if (-not (Test-Path $FlagFile)) {
    Write-Host ""
    Write-Host "[deploy] 릴리즈 승인 플래그가 없습니다." -ForegroundColor Red
    Write-Host ""
    Write-Host "릴리즈 전 다음 단계를 완료해야 합니다:"
    Write-Host "  1. build-windows.ps1 으로 검수용 빌드 생성"
    Write-Host "  2. 다른 PC에서 설치/동작 확인"
    Write-Host "  3. CHANGELOG.md 릴리즈 노트 작성"
    Write-Host "  4. 승인 플래그 생성:"
    Write-Host '     echo approved > .agents\release-approved' -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# ── 2. 버전 확인 ─────────────────────────────────────────────────────────
$PkgJson = Get-Content (Join-Path $RepoRoot "shell\package.json") | ConvertFrom-Json
$Version = $PkgJson.version
$Tag     = "v$Version"

Write-Host ""
Write-Host "[deploy] 버전: $Tag" -ForegroundColor Cyan
Write-Host "[deploy] 이 버전으로 릴리즈를 진행합니다."
$Confirm = Read-Host "계속할까요? (y/N)"
if ($Confirm -ne "y" -and $Confirm -ne "Y") {
    Write-Host "[deploy] 취소됨." -ForegroundColor Yellow
    exit 0
}

# ── 3. 이미 태그가 있는지 확인 ───────────────────────────────────────────
$ExistingTag = git tag -l $Tag
if ($ExistingTag) {
    Write-Host "[deploy] 태그 $Tag 가 이미 존재합니다." -ForegroundColor Red
    Write-Host "         버전을 올린 후 다시 실행하세요."
    exit 1
}

# ── 4. 승인 플래그 삭제 (일회용) ─────────────────────────────────────────
Remove-Item $FlagFile -Force
Write-Host "[deploy] 승인 플래그 삭제됨."

# ── 5. 태그 생성 및 푸시 (CI 릴리즈 빌드 트리거) ─────────────────────────
Write-Host "[deploy] 태그 생성: $Tag"
git tag $Tag
git push origin $Tag

Write-Host ""
Write-Host "[deploy] 완료!" -ForegroundColor Green
Write-Host "  CI 빌드가 시작되었습니다."
Write-Host "  진행 상황: https://github.com/nextain/naia-os/actions"
Write-Host "  릴리즈:    https://github.com/nextain/naia-os/releases/tag/$Tag"
