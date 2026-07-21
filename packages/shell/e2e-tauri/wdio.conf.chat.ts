// Lean wdio config — provider-provenance chat UC 전용. base wdio.conf 를 상속하되 무거운 ensureAppReady
// (다중 refresh churn → 간헐 workspace_set_root 90s 경합 → before-all hook 타임아웃)를 스킵한다.
// before() = localStorage-writable 대기 + autoApprove 만. 설정/refresh 는 각 spec 의 before 가 1회 수행.
import { execSync } from "node:child_process";
import { config as base } from "./wdio.conf.js";

let permissionPoller: { dispose: () => void } | undefined;

export const config = {
	...base,
	specs: ["./specs/90-glm-newcore-chat.spec.ts"],
	// hook/test 여유 — 간헐 workspace_set_root(IPC 경합) 대비. 단일 refresh 면 보통 빠름(dev 53ms).
	mochaOpts: {
		...(base as { mochaOpts?: object }).mochaOpts,
		timeout: 300_000,
	},
	// ★ base afterSession 의 `pkill -9 -f naia-shell`(-f=full cmdline 광범위)이 wdio 워커 노드까지 시그널로 죽여
	//   테스트 결과 리포트 전 워커가 exit code null 로 사라짐("FAILED in undefined", 통과인데 실패 기록). trace 로 확인.
	//   → 정확한 comm 이름만 죽임(`pkill -x`): 워커(comm=node)는 안 건드리고 앱/드라이버 바이너리만 정리.
	afterSession() {
		for (const name of [
			"naia-shell",
			"tauri-driver",
			"WebKitWebDriver",
			"naia-node",
		]) {
			try {
				execSync(`pkill -x ${name} 2>/dev/null || true`, { stdio: "ignore" });
			} catch {
				/* best-effort */
			}
		}
	},
	async before(this: unknown) {
		// http origin + localStorage 쓰기 가능까지 대기(base 와 동일 — WebView 초기 navigate 보장).
		await browser.waitUntil(
			async () => {
				try {
					return await browser.execute(() => {
						if (!document.location.href.startsWith("http")) return false;
						try {
							const k = "__naia_e2e_probe__";
							localStorage.setItem(k, "1");
							localStorage.removeItem(k);
							return true;
						} catch {
							return false;
						}
					});
				} catch {
					return false;
				}
			},
			{
				timeout: 30_000,
				timeoutMsg:
					"webview never reached http origin with writable localStorage",
			},
		);
		// ensureAppReady() 스킵(이중 refresh churn 회피). 권한 모달 자동 승인만 유지.
		const { autoApprovePermissions } = await import("./helpers/permissions.js");
		permissionPoller = autoApprovePermissions();
	},
	after() {
		permissionPoller?.dispose();
		permissionPoller = undefined;
	},
};
