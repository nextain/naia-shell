<#
.SYNOPSIS
    Quick test: resolve pnpm junctions and verify agent can find better-sqlite3.
    Run from: projects/naia-os/shell/
    Usage:    .\test-junction-fix.ps1
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$agentDir = Resolve-Path (Join-Path $PSScriptRoot "../agent")

# ── Step 1: Check current junction status ──────────────────────────────────────
Write-Host "`n[1/4] Checking junctions in agent/node_modules ..." -ForegroundColor Cyan
$junctions = Get-ChildItem -LiteralPath "$agentDir/node_modules" -Directory |
    Where-Object { $_.LinkType -eq 'Junction' }

if ($junctions.Count -eq 0) {
    Write-Host "  No junctions found (already resolved or npm install)." -ForegroundColor Green
} else {
    Write-Host "  Found $($junctions.Count) junctions:" -ForegroundColor Yellow
    $junctions | ForEach-Object { Write-Host "    - $($_.Name)" -ForegroundColor DarkGray }
}

# ── Step 2: Resolve junctions ─────────────────────────────────────────────────
if ($junctions.Count -gt 0) {
    Write-Host "`n[2/4] Resolving junctions ..." -ForegroundColor Cyan
    foreach ($j in $junctions) {
        $targetPath = if ($j.Target -is [array]) { $j.Target[0] } else { $j.Target }
        if (-not (Test-Path $targetPath)) {
            Write-Host "  SKIP (target missing): $($j.Name)" -ForegroundColor Red
            continue
        }
        $dest = $j.FullName
        Remove-Item -LiteralPath $dest -Force -Recurse
        # robocopy exit codes: 0-7 are success, 8+ are errors
        robocopy $targetPath $dest /E /R:0 /W:0 /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
        if ($LASTEXITCODE -ge 8) {
            Write-Host "  FAIL: $($j.Name) (robocopy exit $LASTEXITCODE)" -ForegroundColor Red
        } else {
            Write-Host "  OK: $($j.Name)" -ForegroundColor Green
        }
    }

    # Verify no junctions remain
    $remaining = Get-ChildItem -LiteralPath "$agentDir/node_modules" -Directory |
        Where-Object { $_.LinkType -eq 'Junction' }
    if ($remaining.Count -gt 0) {
        Write-Host "  WARNING: $($remaining.Count) junctions remain!" -ForegroundColor Red
    } else {
        Write-Host "  All junctions resolved." -ForegroundColor Green
    }
} else {
    Write-Host "`n[2/4] Skipping (no junctions to resolve)." -ForegroundColor DarkGray
}

# ── Step 3: Verify better-sqlite3 is real directory ───────────────────────────
Write-Host "`n[3/4] Verifying better-sqlite3 ..." -ForegroundColor Cyan
$bs3 = Get-Item -LiteralPath "$agentDir/node_modules/better-sqlite3" -ErrorAction SilentlyContinue
if (-not $bs3) {
    Write-Host "  FAIL: better-sqlite3 not found in node_modules!" -ForegroundColor Red
    exit 1
}
if ($bs3.LinkType) {
    Write-Host "  FAIL: still a $($bs3.LinkType)!" -ForegroundColor Red
    exit 1
}
$nativeDll = Get-ChildItem -LiteralPath "$agentDir/node_modules/better-sqlite3" -Recurse -Filter "*.node" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($nativeDll) {
    Write-Host "  OK: real directory, native binary found ($($nativeDll.FullName.Replace($agentDir.Path, '...')))" -ForegroundColor Green
} else {
    Write-Host "  FAIL: no .node binary found (run 'cd agent && pnpm install' to compile)" -ForegroundColor Red
    exit 1
}

# ── Step 4: Simulate production agent startup ─────────────────────────────────
Write-Host "`n[4/4] Simulating agent startup (10s timeout) ..." -ForegroundColor Cyan
$agentScript = "$agentDir/dist/index.js"
if (-not (Test-Path $agentScript)) {
    Write-Host "  FAIL: $agentScript not found. Run 'cd agent && pnpm run build' first." -ForegroundColor Red
    exit 1
}

$testDir = Join-Path $env:TEMP "naia-agent-test-$(Get-Random)"
New-Item -ItemType Directory -Path $testDir -Force | Out-Null

# Use pipe to keep stdin open, then close after delay
$proc = Start-Process -FilePath "node" `
    -ArgumentList $agentScript, "--stdio" `
    -WorkingDirectory $testDir `
    -RedirectStandardOutput "$testDir/stdout" `
    -RedirectStandardError "$testDir/stderr" `
    -NoNewWindow -PassThru

# Give it 10 seconds to start (or crash from missing module)
Start-Sleep -Seconds 10

if ($proc.HasExited) {
    $exitCode = $proc.ExitCode
    $stderr = Get-Content "$testDir/stderr" -ErrorAction SilentlyContinue
    $crashLine = $stderr | Where-Object { $_ -match "ERR_MODULE_NOT_FOUND|Error \[|Cannot find" } | Select-Object -First 5
    if ($crashLine) {
        Write-Host "  FAIL: agent crashed (exit $exitCode)" -ForegroundColor Red
        $crashLine | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        exit 1
    }
    # No crash errors = likely stdin EOF normal exit
    Write-Host "  OK: agent started without module errors (exit $exitCode, stdin EOF)" -ForegroundColor Green
} else {
    Write-Host "  OK: agent running (PID $($proc.Id))" -ForegroundColor Green
    $proc.Kill()
}

# Cleanup
Remove-Item -LiteralPath $testDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "`n=== All checks passed ===" -ForegroundColor Green
