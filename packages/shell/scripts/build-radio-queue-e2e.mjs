import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const shellDir = resolve(import.meta.dirname, "..");
const agent = "D:/alpha-adk/projects/naia-agent-worktrees/codex-job-terminal";
const script = resolve(agent, "scripts/builds/agent-stdio-entry.mjs");
const proto = resolve(agent, "src/main/adapters/grpc");
const workspaceRoot = resolve(shellDir, "..", "..");
const sidecar = resolve(shellDir, "..", "bgm-sidecar");
const manifest = resolve(shellDir, "src-tauri/Cargo.toml");
const config = resolve(shellDir, "src-tauri/tauri.e2e.conf.json");
const target = process.env.NAIA_E2E_TARGET_DIR ?? "C:/tmp/naia-radio-queue-e2e";
if (![script, resolve(proto, "naia_agent.proto"), config].every(existsSync)) throw new Error("isolated E2E inputs are unavailable");
if (!existsSync(resolve(sidecar, "node_modules"))) {
 const install = spawnSync("pnpm", ["install", "--offline", "--frozen-lockfile", "--filter", "@naia/bgm-sidecar"], { cwd: workspaceRoot, stdio: "inherit", shell: process.platform === "win32" });
 if (install.status !== 0) throw new Error("cannot materialize the owned BGM sidecar dependencies");
}
const sidecarBuild = spawnSync("pnpm", ["run", "build"], { cwd: sidecar, stdio: "inherit", shell: process.platform === "win32" });
if (sidecarBuild.status !== 0 || !existsSync(resolve(sidecar, "dist", "bgm-server-bin.js"))) throw new Error("owned BGM sidecar build did not produce an executable entrypoint");
const result = spawnSync(process.platform === "win32" ? "cargo.exe" : "cargo", ["build", "--manifest-path", manifest, "--features", "webdriver-e2e"], {
 cwd: shellDir, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: target, TAURI_CONFIG: readFileSync(config, "utf8"), NAIA_AGENT_SCRIPT: script, NAIA_AGENT_PROTO_DIR: proto },
});
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.platform === "win32") {
 const source = resolve(shellDir, "src-tauri", "target", "debug");
 const destination = resolve(target, "debug");
 if (existsSync(source)) for (const file of readdirSync(source).filter((name) => name.toLowerCase().endsWith(".dll"))) copyFileSync(resolve(source, file), resolve(destination, file));
}