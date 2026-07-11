// 실 Tauri WebView2 부팅 capability **하드 게이트** (codex P0 리뷰 C1).
//   tauri-driver(Windows DevToolsActivePort 이슈) 없이, 실 빌드 바이너리를 직접 실행하고 부팅 시 프론트가
//   남기는 `[NvaCapability]` 로그(→Rust stderr 포워딩)를 파싱해 layeredOk===true 를 **강제**한다. 실패 시
//   비영(non-zero) 종료 → CI fail-gate. 수동 1회 관찰이 아니라 회귀 방지 자동 검증. (Linux CI = xvfb-run 필요.)
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { execPath, platform } from "node:process";
import { fileURLToPath } from "node:url";

const IS_WIN = platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
const HERE = dirname(fileURLToPath(import.meta.url)); // e2e-tauri
const SHELL_DIR = resolve(HERE, "..");
const BINARY = resolve(SHELL_DIR, `src-tauri/target/debug/naia-shell${EXE}`);
const VITE = resolve(SHELL_DIR, "node_modules/vite/bin/vite.js");
const BOOT_TIMEOUT_MS = 45_000;

function killApp() {
	try {
		if (IS_WIN) execSync("taskkill /F /IM naia-shell.exe", { stdio: "ignore" });
		else
			execSync("pkill -9 -f naia-shell 2>/dev/null || true", {
				stdio: "ignore",
			});
	} catch {
		/* no matching process */
	}
}

function waitPort(port, ms) {
	// vite 는 Windows 에서 localhost 를 IPv6(::1)에 바인딩할 수 있어 127.0.0.1 단독 연결은 실패한다.
	// wdio.conf 와 동일하게 여러 호스트를 병렬 시도(하나라도 붙으면 준비).
	const hosts = ["127.0.0.1", "::1", "localhost"];
	return new Promise((ok, fail) => {
		const deadline = Date.now() + ms;
		const round = () => {
			let pending = hosts.length;
			let done = false;
			for (const host of hosts) {
				const s = connect(port, host);
				s.once("connect", () => {
					if (done) return;
					done = true;
					s.destroy();
					ok();
				});
				s.once("error", () => {
					s.destroy();
					pending -= 1;
					if (done || pending > 0) return;
					if (Date.now() > deadline) fail(new Error(`port ${port} timeout`));
					else setTimeout(round, 400);
				});
			}
		};
		round();
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let vite;
let app;
function cleanup() {
	try {
		app?.kill();
	} catch {
		/* noop */
	}
	try {
		vite?.kill();
	} catch {
		/* noop */
	}
	killApp();
}

async function main() {
	killApp();
	vite = spawn(execPath, [VITE], {
		cwd: SHELL_DIR,
		stdio: ["ignore", "ignore", "ignore"],
		env: { ...process.env, BROWSER: "none" },
	});
	await waitPort(1420, 30_000);

	app = spawn(BINARY, [], {
		cwd: SHELL_DIR,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
	});
	let buf = "";
	const onData = (d) => {
		buf += d.toString();
	};
	app.stdout.on("data", onData);
	app.stderr.on("data", onData);

	// 라인 스코프 추출: `[NvaCapability]` 를 포함한 완성 라인에서 첫 `{`~마지막 `}` 를 JSON.parse.
	// (정규식 greedy 매칭보다 강건 — 로그가 섞여도 라인 경계로 격리, 부분 라인은 parse 실패→다음 폴링 대기.)
	function extractCaps(text) {
		for (const line of text.split(/\r?\n/)) {
			const tag = line.indexOf("[NvaCapability]");
			if (tag < 0) continue;
			const s = line.indexOf("{", tag);
			const e = line.lastIndexOf("}");
			if (s < 0 || e <= s) continue;
			try {
				return JSON.parse(line.slice(s, e + 1));
			} catch {
				/* 아직 부분 라인 — 다음 폴링 */
			}
		}
		return null;
	}

	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	let caps = null;
	while (Date.now() < deadline) {
		caps = extractCaps(buf);
		if (caps) break;
		await sleep(500);
	}

	if (!caps) {
		console.error("FAIL: 실 앱 부팅 [NvaCapability] 로그 미검출 (timeout)");
		cleanup();
		process.exit(1);
	}
	console.log("실 WebView2 부팅 capability:", JSON.stringify(caps));
	const ok =
		caps.layeredOk === true &&
		caps.rvfc === true &&
		caps.webgl2 === true &&
		caps.mseH264 === true &&
		caps.canvasAlpha === true;
	cleanup();
	if (!ok) {
		console.error(`FAIL: 레이어드 능력 미충족 (reasons=${caps.reasons})`);
		process.exit(1);
	}
	console.log("PASS: 실 Tauri WebView2 layeredOk===true (하드 게이트 통과)");
	process.exit(0);
}

main().catch((e) => {
	console.error("ERR:", e?.message || e);
	cleanup();
	process.exit(2);
});
