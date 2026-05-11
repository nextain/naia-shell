//! WSL2 management for Windows Tier 2.
//! This module is only compiled on Windows (gated by platform/mod.rs).

use std::process::Command;

/// Check if WSL2 is available and enabled.
/// Returns: Ok(true) = ready, Err(msg) = WSL not installed or not enabled.
///
/// Detection methods (in order):
/// 0. VirtualMachinePlatform feature enabled (PowerShell, no admin needed)
/// 1. `wsl --version` (fast, no VM boot, works on Win11+)
/// 2. `wsl echo ok` (slower — actually runs inside WSL)
/// If wsl.exe doesn't exist at all, returns Err.
pub(crate) fn check_wsl_status() -> Result<bool, String> {
    // Method 0: Check if VirtualMachinePlatform Windows feature is enabled.
    // wsl --version succeeds even when VMP is disabled (wsl.exe is always present),
    // but WSL2 distros cannot run without it.
    // Only block if we can CONFIRM the feature is disabled. If the check fails
    // (e.g. Get-WindowsOptionalFeature needs elevation in some app contexts),
    // fall through to HCS check instead of returning a false negative.
    match get_windows_feature_state("VirtualMachinePlatform") {
        Some(state) if state == "Disabled" => {
            return Err("VirtualMachinePlatform is not enabled".to_string());
        }
        _ => {} // Enabled, EnablePending, or check failed — continue
    }

    // Method 0b: Check if Hyper-V Compute Service (vmcompute) exists.
    // This is the definitive check — wsl --version always succeeds on Win11
    // even when features are disabled, but vmcompute only exists when VMP
    // is fully activated (after reboot).
    {
        let mut sc_cmd = Command::new("sc.exe");
        sc_cmd.args(["query", "vmcompute"]);
        super::hide_console(&mut sc_cmd);
        let sc_ok = sc_cmd.output().map(|o| o.status.success()).unwrap_or(false);
        if !sc_ok {
            return Err(
                "VirtualMachinePlatform is not active (vmcompute service missing)".to_string(),
            );
        }
    }

    // Method 1: wsl --version (fast, no VM boot, works on Win11+)
    let mut cmd = Command::new("wsl");
    cmd.arg("--version");
    super::hide_console(&mut cmd);
    match cmd.output() {
        Ok(o) if o.status.success() => return Ok(true),
        Err(_) => {
            return Err(
                "WSL is not installed. Install from Microsoft Store or run: wsl --install"
                    .to_string(),
            );
        }
        _ => {}
    }

    // Method 1b: wsl --version failed but wsl.exe exists (inbox version).
    // Check if WSL2 kernel is missing — wsl --status reports this.
    {
        let mut status_cmd = Command::new("wsl");
        status_cmd.arg("--status");
        super::hide_console(&mut status_cmd);
        if let Ok(o) = status_cmd.output() {
            let stderr = decode_utf16_lossy(&o.stderr);
            let stdout = decode_utf16_lossy(&o.stdout);
            let combined = format!("{}{}", stdout, stderr);
            // Korean: "커널 파일을 찾을 수 없습니다" / English: "kernel file is not found"
            if combined.contains("kernel") || combined.contains("커널") {
                return Err("WSL2 kernel not installed. Run: wsl --update".to_string());
            }
        }
    }

    // Method 2: wsl echo ok (slower — boots VM if needed, but works everywhere)
    let mut cmd2 = Command::new("wsl");
    cmd2.args(["echo", "ok"]);
    super::hide_console(&mut cmd2);
    match cmd2.output() {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            if stdout.trim().contains("ok") {
                return Ok(true);
            }
            // wsl echo failed — WSL installed but VM not ready
            let stderr = decode_utf16_lossy(&o.stderr);
            Err(format!("WSL not ready: {}", stderr.trim()))
        }
        Err(_) => Err("WSL is not installed".to_string()),
    }
}

/// Get the state of a Windows optional feature via PowerShell.
/// Returns Some("Enabled"), Some("Disabled"), Some("EnablePending"), etc.
/// Returns None if the check fails (e.g. elevation required in some contexts).
pub(crate) fn get_windows_feature_state(feature: &str) -> Option<String> {
    let script = format!(
        "(Get-WindowsOptionalFeature -Online -FeatureName {}).State",
        feature
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &script]);
    super::hide_console(&mut cmd);
    match cmd.output() {
        Ok(o) if o.status.success() => {
            let state = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if state.is_empty() {
                None
            } else {
                Some(state)
            }
        }
        _ => None,
    }
}

/// Check if WSL2 is available (simple bool wrapper).
pub(crate) fn is_wsl_available() -> bool {
    check_wsl_status().unwrap_or(false)
}

/// Check if a named distro is registered in WSL.
pub(crate) fn is_distro_registered(name: &str) -> bool {
    let mut cmd = Command::new("wsl");
    cmd.args(["-l", "-q"]);
    super::hide_console(&mut cmd);
    cmd.output()
        .map(|o| {
            let stdout = decode_utf16_lossy(&o.stdout);
            stdout.lines().any(|l| l.trim() == name)
        })
        .unwrap_or(false)
}

/// Decode potentially UTF-16LE output from wsl.exe.
/// Falls back to UTF-8 if the byte length is odd or decoding fails.
fn decode_utf16_lossy(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes.len() % 2 == 0 {
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        // Strip BOM if present
        let start = if u16s.first() == Some(&0xFEFF) { 1 } else { 0 };
        String::from_utf16_lossy(&u16s[start..])
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

/// Import a custom WSL2 distro from a tar.gz rootfs.
pub(crate) fn import_distro(name: &str, install_path: &str, tar_path: &str) -> Result<(), String> {
    let mut cmd = Command::new("wsl");
    cmd.args(["--import", name, install_path, tar_path, "--version", "2"]);
    super::hide_console(&mut cmd);
    let output = cmd.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        // WSL outputs errors in UTF-16LE — decode properly
        let stderr = decode_utf16_lossy(&output.stderr);
        if stderr.contains("HCS_E_SERVICE_NOT_AVAILABLE") || stderr.contains("0x80070422") {
            Err("WSL requires a system restart to finish setup. Please restart your computer and try again.".to_string())
        } else {
            Err(stderr.to_string())
        }
    }
}

/// Run a command inside a named WSL distro and return stdout.
#[allow(dead_code)]
pub(crate) fn run_in_distro(name: &str, command: &str) -> Result<String, String> {
    let mut cmd = Command::new("wsl");
    cmd.args(["-d", name, "--", "bash", "-lc", command]);
    super::hide_console(&mut cmd);
    let output = cmd.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Spawn Naia Gateway inside a WSL distro (returns a Child handle).
pub(crate) fn spawn_gateway_in_wsl(name: &str, port: u16) -> Result<std::process::Child, String> {
    let mut cmd = Command::new("wsl");
    cmd.args([
        "-d",
        name,
        "--",
        "node",
        "/opt/naia/openclaw/node_modules/openclaw/openclaw.mjs",
        "gateway",
        "run",
        "--bind",
        "loopback",
        "--port",
        &port.to_string(),
        "--allow-unconfigured",
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    super::hide_console(&mut cmd);
    cmd.spawn().map_err(|e| e.to_string())
}

/// Spawn Naia Node Host inside a WSL distro (returns a Child handle).
pub(crate) fn spawn_node_host_in_wsl(name: &str, port: u16) -> Result<std::process::Child, String> {
    let mut cmd = Command::new("wsl");
    cmd.args([
        "-d",
        name,
        "--",
        "node",
        "/opt/naia/openclaw/node_modules/openclaw/openclaw.mjs",
        "node",
        "run",
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--display-name",
        "NaiaLocal",
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    super::hide_console(&mut cmd);
    cmd.spawn().map_err(|e| e.to_string())
}

/// Auto-approve pending device pairing requests in the WSL Gateway.
/// Parses `naia devices list` CLI output to find pending request UUIDs,
/// then approves each one so the Agent can connect without manual intervention.
pub(crate) fn auto_approve_pending_devices(name: &str) {
    // Run device list with a timeout to prevent hanging restart_gateway.
    // WSL commands can hang if the gateway is still initializing.
    let mut cmd = Command::new("wsl");
    cmd.args([
        "-d",
        name,
        "--",
        "node",
        "/opt/naia/openclaw/node_modules/openclaw/openclaw.mjs",
        "devices",
        "list",
    ])
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    super::hide_console(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return,
    };
    // Poll with timeout (15s) — Child::wait() blocks forever if the WSL
    // process hangs, so we poll try_wait in a loop instead.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    crate::log_both(
                        "[Naia] auto_approve_pending_devices timed out (15s) — skipping",
                    );
                    let _ = child.kill();
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(_) => return,
        }
    }
    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(_) => return,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse pending section — extract UUIDs from table rows
    // Format: │ <uuid> │ <deviceId> │ ...
    let mut in_pending = false;
    let mut request_ids = Vec::new();

    for line in stdout.lines() {
        if line.contains("Pending") {
            in_pending = true;
            continue;
        }
        if line.contains("Paired") {
            in_pending = false;
            continue;
        }
        if in_pending {
            // Extract UUID (8-4-4-4-12 hex) from table cell
            let trimmed = line.trim().trim_start_matches('│').trim();
            if let Some(uuid) = extract_uuid(trimmed) {
                request_ids.push(uuid);
            }
        }
    }

    for request_id in &request_ids {
        crate::log_both(&format!(
            "[Naia] Auto-approving pending device: {}",
            request_id
        ));
        let mut approve_cmd = Command::new("wsl");
        approve_cmd.args([
            "-d",
            name,
            "--",
            "node",
            "/opt/naia/openclaw/node_modules/openclaw/openclaw.mjs",
            "devices",
            "approve",
            request_id,
        ]);
        super::hide_console(&mut approve_cmd);
        let _ = approve_cmd.output();
    }

    if !request_ids.is_empty() {
        crate::log_both(&format!(
            "[Naia] Auto-approved {} pending device(s)",
            request_ids.len()
        ));
    }
}

/// Extract a UUID (8-4-4-4-12 hex pattern) from a string.
fn extract_uuid(s: &str) -> Option<String> {
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (36 chars)
    let bytes = s.as_bytes();
    if bytes.len() < 36 {
        return None;
    }
    for start in 0..=bytes.len().saturating_sub(36) {
        let candidate = &s[start..start + 36];
        let parts: Vec<&str> = candidate.split('-').collect();
        if parts.len() == 5
            && parts[0].len() == 8
            && parts[1].len() == 4
            && parts[2].len() == 4
            && parts[3].len() == 4
            && parts[4].len() == 12
            && candidate.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Kill Naia Gateway processes (gateway + node host) running inside a WSL distro.
/// This ensures the `node` processes inside WSL are actually terminated,
/// not just the `wsl.exe` bridge on Windows.
pub(crate) fn kill_naia_processes(name: &str) {
    let mut cmd = Command::new("wsl");
    cmd.args(["-d", name, "--", "pkill", "-f", "naia-node"]);
    super::hide_console(&mut cmd);
    match cmd.output() {
        Ok(o) => {
            if o.status.success() {
                crate::log_verbose(&format!(
                    "[Naia] Killed Naia Gateway processes inside WSL distro '{}'",
                    name
                ));
            }
            // pkill returns 1 if no processes matched — that's fine
        }
        Err(e) => {
            crate::log_verbose(&format!(
                "[Naia] Failed to pkill inside WSL '{}': {}",
                name, e
            ));
        }
    }
}

/// Terminate a WSL distro.
#[allow(dead_code)]
pub(crate) fn terminate_distro(name: &str) {
    let mut cmd = Command::new("wsl");
    cmd.args(["--terminate", name]);
    super::hide_console(&mut cmd);
    let _ = cmd.output();
}

/// Check if a distro has Node.js + Naia Gateway provisioned.
pub(crate) fn is_provisioned(name: &str) -> bool {
    let mut cmd = Command::new("wsl");
    cmd.args([
        "-d",
        name,
        "--",
        "test",
        "-f",
        "/opt/naia/openclaw/node_modules/openclaw/openclaw.mjs",
    ]);
    super::hide_console(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// Emit provision progress to the frontend (if app_handle provided).
fn emit_provision_progress(app: Option<&tauri::AppHandle>, step: &str, detail: &str) {
    if let Some(app) = app {
        use tauri::Emitter;
        let payload = serde_json::json!({ "step": step, "detail": detail });
        let _ = app.emit("wsl-setup-progress", payload);
    }
}

/// Provision a distro with Node.js 22 + Naia Gateway.
/// Runs the equivalent of config/wsl/Dockerfile steps inside an existing distro.
pub(crate) fn provision_distro(name: &str, app: Option<&tauri::AppHandle>) -> Result<(), String> {
    // Step 1: Install Node.js 22
    emit_provision_progress(app, "provision_node", "Installing Node.js 22...");
    crate::log_both("[Naia] Installing Node.js 22 in WSL...");
    run_provision_step(
        name,
        concat!(
            "apt-get update -qq && ",
            "apt-get install -y -qq curl ca-certificates && ",
            "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && ",
            "apt-get install -y -qq nodejs && ",
            "node -v"
        ),
        "Node.js install",
    )?;

    // Step 2: Install Naia Gateway
    emit_provision_progress(app, "provision_gateway", "Installing Naia Gateway...");
    crate::log_both("[Naia] Installing Naia Gateway in WSL...");
    run_provision_step(
        name,
        concat!(
            "mkdir -p /opt/naia/openclaw && ",
            "cd /opt/naia/openclaw && ",
            "npm init -y --quiet 2>/dev/null && ",
            "npm install @naia/gateway@latest --quiet"
        ),
        "Naia Gateway install",
    )?;

    // Step 3: Configure PATH
    emit_provision_progress(app, "provision_config", "Configuring environment...");
    run_provision_step(name,
        "grep -q '/opt/naia/openclaw' /root/.bashrc || echo 'export PATH=\"/opt/naia/openclaw/node_modules/.bin:$PATH\"' >> /root/.bashrc",
        "PATH config"
    )?;

    // Step 4: Copy wsl.conf for systemd support
    let wsl_conf = "[boot]\nsystemd=true\n\n[interop]\nenabled=true\nappendWindowsPath=true\n\n[network]\ngenerateResolvConf=true\n";
    run_provision_step(
        name,
        &format!("cat > /etc/wsl.conf << 'WSLEOF'\n{}\nWSLEOF", wsl_conf),
        "wsl.conf",
    )?;

    // Step 5: Configure Naia Gateway mode=local
    crate::log_both("[Naia] Setting gateway.mode=local in Naia Gateway config...");
    run_provision_step(
        name,
        concat!(
            "node -e \"",
            "const fs=require('fs');",
            "const p='/root/.openclaw/openclaw.json';",
            "let c={};",
            "try{c=JSON.parse(fs.readFileSync(p,'utf8'))}catch{}",
            "c.gateway=c.gateway||{};",
            "c.gateway.mode='local';",
            "fs.mkdirSync('/root/.openclaw',{recursive:true});",
            "fs.writeFileSync(p,JSON.stringify(c,null,2));",
            "console.log('gateway.mode=local set');",
            "\""
        ),
        "gateway.mode config",
    )?;

    // Verify
    emit_provision_progress(app, "provision_verify", "Verifying installation...");
    if is_provisioned(name) {
        crate::log_both("[Naia] Provisioning verified — Naia Gateway available");
        Ok(())
    } else {
        Err("Provisioning completed but Naia Gateway not found at expected path".to_string())
    }
}

/// Run a single provisioning step inside WSL, with error reporting.
fn run_provision_step(name: &str, script: &str, step_name: &str) -> Result<(), String> {
    let mut cmd = Command::new("wsl");
    cmd.args(["-d", name, "--", "bash", "-lc", script]);
    super::hide_console(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("{} failed: {}", step_name, e))?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !stdout.trim().is_empty() {
            crate::log_verbose(&format!("[Naia] {}: {}", step_name, stdout.trim()));
        }
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("{} failed: {}", step_name, stderr.trim()))
    }
}
