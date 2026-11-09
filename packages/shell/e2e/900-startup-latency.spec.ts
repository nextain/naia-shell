import { expect, test } from "@playwright/test";

/**
 * 앱이 뜨기까지 걸리는 시간에 한도를 건다.
 *
 * 왜 필요한가: 이 저장소의 성능 축은 크기만 잠겨 있다. bundle-budget 이
 * 진입 스크립트와 배포본 크기를 막지만, 시간은 어디에도 한도가 없다. 지금은
 * 타임아웃이 사실상의 한도이고, 그것은 "안 죽었다" 만 말한다. 번들이 커지지
 * 않으면서도 초기화가 느려지는 회귀는 아무것도 잡지 못한다.
 *
 * 무엇을 재는가: 페이지를 열고 셸의 첫 화면이 보일 때까지의 벽시계 시간.
 * 러너 성능은 실행마다 흔들리므로 세 번 재서 중앙값을 쓴다. 한 번의 튐으로
 * 붉어지면 사람은 곧 이 테스트를 꺼 버린다.
 *
 * 한도는 어떻게 정했나: 이 기계에서 실측한 값에 넉넉한 여유를 얹었다. 목적은
 * 지금 속도를 지키는 것이 아니라 배가 느려지는 회귀를 잡는 것이다.
 */

const TAURI_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};

	// Record every invoke so the test can assert which Tauri commands fire
	window.__INVOKE_LOG__ = [];

	var callbacks = new Map();
	var nextCbId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextCbId++;
		callbacks.set(id, function(data) { if (once) callbacks.delete(id); return fn && fn(data); });
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, data) {
		var cb = callbacks.get(id);
		if (cb) cb(data);
	};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		window.__INVOKE_LOG__.push({ cmd: cmd, args: args ?? null, t: Date.now() });

		// Safe defaults
		if (cmd === "plugin:event|listen") return 1;
		if (cmd === "plugin:event|unlisten") return undefined;
		if (cmd === "plugin:window|show") return undefined;
		if (cmd === "plugin:window|inner_size") return { width: 1024, height: 768 };
		if (cmd === "plugin:store|load") return undefined;
		if (cmd === "plugin:store|get") return undefined;
		if (cmd === "plugin:store|set") return undefined;
		if (cmd === "plugin:store|save") return undefined;
		if (cmd === "plugin:store|entries") return [];
		if (cmd === "plugin:store|has") return false;
		if (cmd === "plugin:updater|check") return undefined;
		if (cmd === "plugin:path|resolve_directory") return "/tmp/naia-mock-home";
		if (cmd === "plugin:path|join") return (args.paths || []).filter(Boolean).join("/");
		if (cmd === "read_naia_path_cache") return "/tmp/mock-naia-adk-workspace";
		if (cmd === "workspace_detect_adk_root") return null;
		if (cmd === "app_list_installed") return [];
		if (cmd === "send_to_agent_command") return undefined;
		if (cmd === "frontend_log") return undefined;
		if (cmd === "read_text_file") return "";
		if (cmd === "list_directory") return [];
		if (cmd === "exists") return false;
		// Default: log + return undefined so React doesn't crash on missing handler
		return undefined;
	};
})();
`;

// 워크스페이스가 이미 골라진 상태로 띄운다. 이것을 넣지 않으면 셸은
// ADK 설정 화면에서 멈추고, 그 화면은 App.tsx 의 초기화 분기를 통째로
// 건너뛴다 — 즉 셸이 뜨는 시간이 아니라 "설정하라는 안내" 가 뜨는 시간을
// 재게 된다. 이 상수는 원래 파일에 있었지만 어디에서도 쓰이지 않았고,
// 그래서 이 스펙은 오랫동안 엉뚱한 화면을 재고 있었다.
const SET_ADK_PATH = `
localStorage.setItem("naia-adk-path", "/tmp/mock-naia-adk-workspace");
`;

/**
 * 셸이 준비된 자리.
 *
 * 처음에는 화면 요소가 그려진 순간(`.naia-chat-area`)을 잡았다. 그런데 그
 * 시점에 셸은 아직 설정도 로케일도 하이드레이트하지 않았고, 그 구간에 3초를
 * 넣어도 숫자가 움직이지 않았다. 성능 축이 잡고 싶어 하는 "번들은 그대로인데
 * 초기화가 느려지는 회귀" 가 정확히 거기서 일어난다.
 *
 * 이제 앱이 스스로 준비됐다고 말하는 표지를 기다린다. 그 표지는 로케일
 * 하이드레이션까지 반영한다.
 */
/**
 * 예전에는 `[data-app-ready="true"]` 를 기다렸다. 그 표지는 설정·로케일
 * 하이드레이션과 아바타까지만 반영한다. 그래서 설치 앱 목록 읽기에 3초를
 * 넣어도 측정값이 807ms / 219ms 로 기준선(1,072 / 167)과 구별되지 않았다 —
 * 앱바가 3초 동안 비어 있어도 성능 축이 아무 말을 하지 않는 상태였다.
 *
 * 부팅의 마지막까지 기다린다.
 */
const SHELL_READY = '[data-app-boot-complete="true"]';

/** 설정 화면의 표지. 여기 도달했다면 측정 대상이 틀린 것이다. */
const SETUP_SCREEN = ".adk-setup-headline";

// 콜드와 웜을 한 숫자로 뭉개면 한도가 콜드에 끌려가 웜 회귀를 못 잡는다.
// 이 기계 실측이 그 구조를 그대로 보여 준다 — 3회 반복 실행에서 첫 표본은
// 829/851/927ms 로 일관되게 느리고, 그 뒤 표본은 141~217ms 로 모인다.
// 한 한도로 덮으면 콜드에 맞춰야 하므로 웜이 다섯 배 느려져도 통과한다.
//
// 그래서 둘로 나눈다. 첫 표본은 콜드로 따로 판정하고, 웜은 워밍업 뒤 표본의
// 중앙값으로 판정한다. 각 한도는 이 기계 최악 관측의 두 배를 조금 넘는 자리다
// (콜드 927 → 2,000 / 웜 217 → 500). 중앙값이 이미 튐을 걸러 주므로 이보다
// 넓힐 이유가 없고, 이 폭이면 2배 회귀는 잡으면서 러너 차이는 견딘다.
// CI 러너에서 재 보고 흔들리면 넓히되, 관측값과 이유를 여기 적어라.
const WARM_SAMPLES = 5;
const COLD_BUDGET_MS = 2_000;
const WARM_BUDGET_MS = 500;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

async function measure(page: import("@playwright/test").Page): Promise<number> {
	await page.addInitScript({ content: TAURI_MOCK });
	await page.addInitScript({ content: SET_ADK_PATH });
	const started = Date.now();
	await page.goto("/");
	await expect(page.locator(SHELL_READY)).toBeVisible();
	const elapsed = Date.now() - started;

	// 재는 대상이 맞는지 스스로 확인한다. 설정 화면이 떠 있으면 이 숫자는
	// 셸 시작 시간이 아니다.
	await expect(page.locator(SETUP_SCREEN)).toHaveCount(0);
	return elapsed;
}

test("셸 첫 화면이 콜드·웜 한도 안에 뜬다 (UC-PERF-STARTUP-LATENCY)", async ({
	page,
}) => {
	const cold = await measure(page);

	const warm: number[] = [];
	for (let attempt = 0; attempt < WARM_SAMPLES; attempt++) {
		warm.push(await measure(page));
	}
	const warmMedian = median(warm);

	console.log(
		`[startup-latency] 콜드 ${cold}ms (한도 ${COLD_BUDGET_MS}ms) / ` +
			`웜 표본 ${warm.join(", ")}ms → 중앙값 ${warmMedian}ms (한도 ${WARM_BUDGET_MS}ms)`,
	);

	expect(
		cold,
		`콜드 시작이 ${cold}ms — 한도 ${COLD_BUDGET_MS}ms 를 넘었다.`,
	).toBeLessThan(COLD_BUDGET_MS);
	expect(
		warmMedian,
		`웜 시작 중앙값이 ${warmMedian}ms — 한도 ${WARM_BUDGET_MS}ms 를 넘었다. 표본 ${warm.join(", ")}`,
	).toBeLessThan(WARM_BUDGET_MS);
});
