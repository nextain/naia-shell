import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { applyHarnessXdg } from "./e2e-xdg.mjs";
import { stopHarnessHerdrSession } from "./herdr-session.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, resolve } from "node:path";
import { execPath } from "node:process";
import { resolveRequiredPairedAgent } from "./codex-e2e-environment.js";

export const shellDir = resolve(import.meta.dirname, "..");
export const e2ePort = Number(process.env.NAIA_E2E_WEBDRIVER_PORT ?? "4472");
const configuredVitePort = Number(process.env.NAIA_E2E_VITE_PORT ?? "1422");
if (configuredVitePort !== 1422) throw new Error("radio native E2E binary is fixed to Vite port 1422");
export const vitePort = 1422;
export const bgmPort = Number(process.env.NAIA_E2E_BGM_PORT ?? "18772");
export const oauthPort = Number(process.env.NAIA_E2E_OAUTH_CALLBACK_PORT ?? "18793");
const rootParent = process.platform === "win32" ? resolve("C:/tmp") : resolve(tmpdir());
export const root = resolve(rootParent, `naia-radio-queue-e2e-${e2ePort}`);
export const workspace = resolve(root, "workspace");
export const settings = resolve(workspace, "naia-settings");
export const runtime = resolve(root, "runtime");
export const webview = resolve(root, "webview2");
export const appData = resolve(root, "appdata");
export const target = resolve(
 process.env.NAIA_E2E_TARGET_DIR
  ?? (process.platform === "win32"
   ? "C:/tmp/naia-radio-queue-e2e"
   : resolve(tmpdir(), "naia-radio-queue-e2e")),
);
let vite: ChildProcess | undefined;
let app: ChildProcess | undefined;

function assertOwnedRoot(path: string) {
 const candidate = resolve(path);
 if (
  candidate !== root
  || dirname(candidate) !== rootParent
  || basename(candidate) !== `naia-radio-queue-e2e-${e2ePort}`
 ) throw new Error(`refusing non-owned E2E path: ${path}`);
}
function portOpen(port: number): Promise<boolean> {
 return new Promise((done) => { const socket = connect(port, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); done(true); }); socket.once("error", () => { socket.destroy(); done(false); }); });
}
async function requireFree(port: number) { if (await portOpen(port)) throw new Error(`port ${port} is already occupied; refusing to replace another process`); }
async function waitForPort(port: number, child: ChildProcess) {
 const deadline = Date.now() + 45_000;
 while (Date.now() < deadline) { if (await portOpen(port)) return; if (child.exitCode !== null) throw new Error(`owned process exited before port ${port} became ready`); await new Promise((r) => setTimeout(r, 250)); }
 throw new Error(`owned process did not listen on ${port}`);
}
function appEnvironment(): NodeJS.ProcessEnv {
 const environment = { ...process.env };
 if (process.platform !== "linux") return environment;
 const buildDir = resolve(target, "debug", "build");
 const voskDir = existsSync(buildDir)
  ? readdirSync(buildDir)
    .filter((name) => name.startsWith("tauri-plugin-stt-"))
    .map((name) => resolve(buildDir, name, "out", "vosk-lib"))
    .find((path) => existsSync(resolve(path, "libvosk.so")))
  : undefined;
 if (voskDir) {
  environment.LD_LIBRARY_PATH = [voskDir, environment.LD_LIBRARY_PATH]
   .filter(Boolean)
   .join(delimiter);
 }
 return environment;
}
export function configure() {
 process.env.CAFE_DEBUG_E2E = "1";
 process.env.NAIA_E2E_MODE = "1";
 process.env.NAIA_E2E_MOCK_CLONE = "1";
 process.env.NAIA_E2E_ADK_PATH = workspace;
 process.env.NAIA_E2E_RUNTIME_DIR = runtime;
 // 전용 설정은 기본 wdio.conf 의 훅을 상속하지 않는다 — 앱 프로필 격리를 여기서
 // 명시로 부른다(#569 상태 누수, herdr 세션이 사람 홈에 남던 것).
 applyHarnessXdg();
 process.env.WEBVIEW2_USER_DATA_FOLDER = webview;
 process.env.NAIA_BGM_PORT = String(bgmPort);
 process.env.NAIA_E2E_OAUTH_CALLBACK_PORT = String(oauthPort);
 process.env.NAIA_BGM_SCRIPT = resolve(shellDir, "..", "bgm-sidecar", "dist", "bgm-server-bin.js");
 process.env.APPDATA = resolve(appData, "roaming");
 process.env.LOCALAPPDATA = resolve(appData, "local");
 process.env.VITE_NAIA_BGM_BASE = `http://127.0.0.1:${bgmPort}`;
 const pairedAgent = resolveRequiredPairedAgent();
 process.env.NAIA_AGENT_SCRIPT = resolve(pairedAgent, "scripts/builds/agent-stdio-entry.mjs");
 process.env.NAIA_AGENT_PROTO_DIR = resolve(pairedAgent, "src/main/adapters/grpc");
}
export function reset() {
 assertOwnedRoot(root);
 stopHarnessHerdrSession(process.env.NAIA_E2E_RUNTIME_DIR, spawnSync); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
 for (const dir of [settings, runtime, webview, appData]) mkdirSync(dir, { recursive: true });
 // 실행 자리를 비운 뒤에 만든다 — 순서가 뒤집히면 방금 만든 자리를 rmSync 가 지운다.
 for (const dir of Object.values(applyHarnessXdg() ?? {})) mkdirSync(dir, { recursive: true });
 writeFileSync(resolve(settings, "config.json"), JSON.stringify({ provider: "ollama", model: "e2e", NAIA_MAIN_PROVIDER: "ollama", NAIA_MAIN_MODEL: "e2e", workspaceRoot: workspace, onboardingComplete: true }), { mode: 0o600 });
}
export async function start(binary: string) {
 for (const port of [vitePort, e2ePort, bgmPort, oauthPort]) await requireFree(port);
 vite = spawn(execPath, [resolve(shellDir, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(vitePort)], { cwd: shellDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BROWSER: "none", VITE_NAIA_E2E_MODE: "1", VITE_NAIA_E2E_ADK_PATH: workspace, VITE_NAIA_BGM_BASE: `http://127.0.0.1:${bgmPort}`, VITE_NAIA_E2E_BGM_IFRAME_URL: "/e2e/bgm-playback-fixture.html", VITE_NAIA_E2E_NO_AVATAR: "1" } });
 vite.stderr?.on("data", (data: Buffer) => process.stderr.write(`[radio-queue-e2e:vite] ${data.toString()}`));
 await waitForPort(vitePort, vite);
 app = spawn(binary, [], { cwd: shellDir, stdio: ["ignore", "pipe", "pipe"], env: { ...appEnvironment(), RUST_LOG: "tauri_plugin_wdio_webdriver=debug", TAURI_WEBDRIVER_PORT: String(e2ePort) } });
 app.stderr?.on("data", (data: Buffer) => process.stderr.write(`[radio-queue-e2e:app] ${data.toString()}`));
 const appExit = new Promise<never>((_, reject) => app?.once("exit", (code, signal) => reject(new Error(`owned Tauri E2E app exited before WebDriver was ready (code=${code}, signal=${signal})`))));
 await Promise.race([waitForPort(e2ePort, app), appExit]);
}
export async function stop() {
 const ownedApp = app;
 app = undefined;
 if (ownedApp && ownedApp.exitCode === null) {
  if (process.platform === "win32" && ownedApp.pid) {
   await new Promise<void>((done) => { const killer = spawn("taskkill.exe", ["/pid", String(ownedApp.pid), "/t", "/f"], { stdio: "ignore" }); const timer = setTimeout(done, 5_000); killer.once("exit", () => { clearTimeout(timer); done(); }); });
  } else { ownedApp.kill(); }
 }
 if (vite && vite.exitCode === null) vite.kill();
 vite = undefined;
 await new Promise((r) => setTimeout(r, 500));
 assertOwnedRoot(root); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
