/**
 * #582 S6a — env_browser_* 도구 단위 테스트 (FR-ENV-TOOL.13·14).
 *
 * deps 주입 = Tauri 도, 감독자도, Chromium 도 없이 헤르메틱. 여기서 재는 것 다섯.
 *
 *  (1) 등록 목록이 계약의 열두 도구다.
 *  (2) 기능 플래그가 세 플랫폼에서 계약 4.9 의 기본값대로 답하고, 사람이 정한 값이 그것을 이긴다.
 *  (3) 새 이름이 기존 `skill_browser_*` 와 겹치지 않는다.
 *  (4) 도구 호출이 **EnvironmentToolService 를 거쳐서만** 포트에 닿는다.
 *  (5) 거부 사유가 뭉개지지 않고 그대로 결과에 실린다 — 특히 승인 없는 `env_browser_script`.
 */
import {
	ALL_TIERS,
	BROWSER_RPC_TIERS,
	EnvironmentToolService,
	type BrowserEvidence,
	type CapabilityTier,
	type EnvOperationRequest,
} from "@nextain/naia-os-core/composition";
import { describe, expect, it } from "vitest";
import {
	BROWSER_HOST_APP_ID,
	BROWSER_HOST_RPC_OF,
	BROWSER_HOST_TOOLS,
	BROWSER_HOST_TOOL_NAMES,
	browserHostEnabled,
	browserHostFlag,
	browserHostTools,
	detectPlatform,
	elementTarget,
	executeBrowserHostSkill,
	isBrowserHostTool,
	type BrowserHostDeps,
} from "../browser-host-skill";

/** 기존 임베디드 웹뷰 도구 이름. BrowserCenterArea.tsx 의 목록과 같아야 한다. */
const LEGACY_BROWSER_TOOLS = [
	"skill_browser_navigate",
	"skill_browser_back",
	"skill_browser_forward",
	"skill_browser_reload",
	"skill_browser_click",
	"skill_browser_fill",
	"skill_browser_scroll",
	"skill_browser_press",
	"skill_browser_snapshot",
	"skill_browser_get_text",
	"skill_browser_eval",
];

const EVIDENCE: BrowserEvidence = {
	snapshotRef: "snap-1",
	screenshotRef: "/adk/ego-host/evidence/op-1.png",
	url: "https://example.test/",
	urlRevision: 3,
};

interface Recorded {
	readonly rpc: string;
	readonly request: EnvOperationRequest;
}

/** 실제 서비스 + 기록만 하는 포트. 서비스를 우회하면 이 기록이 비어 테스트가 깨진다. */
function wiring(options: { tiers?: readonly CapabilityTier[] } = {}) {
	const calls: Recorded[] = [];
	const note = (rpc: string, request: EnvOperationRequest) => {
		calls.push({ rpc, request });
	};
	const browser = {
		async open(request: EnvOperationRequest) {
			note("open", request);
			return EVIDENCE;
		},
		async navigate(request: EnvOperationRequest) {
			note("navigate", request);
			return EVIDENCE;
		},
		async snapshot(request: EnvOperationRequest) {
			note("snapshot", request);
			return EVIDENCE;
		},
		async click(request: EnvOperationRequest) {
			note("click", request);
			return EVIDENCE;
		},
		async fill(request: EnvOperationRequest) {
			note("fill", request);
			return EVIDENCE;
		},
		async evaluate(request: EnvOperationRequest) {
			note("evaluate", request);
			return { evidence: EVIDENCE, result: "42" };
		},
		async screenshot(request: EnvOperationRequest) {
			note("screenshot", request);
			return EVIDENCE;
		},
		async close(request: EnvOperationRequest) {
			note("close", request);
		},
	};
	const workspaces = {
		async create(request: EnvOperationRequest) {
			note("createWorkspace", request);
			return { id: "space-7", mode: "headless" as const, ownership: "agent" as const, revision: 0 };
		},
		async list() {
			note("listWorkspaces", { operationId: "list" } as EnvOperationRequest);
			return [];
		},
		async close(request: EnvOperationRequest) {
			note("closeWorkspace", request);
		},
	};
	const scripts = {
		async script(request: EnvOperationRequest) {
			note("script", request);
			return { evidence: EVIDENCE, result: "묶음 실행 결과" };
		},
	};
	const terminal = {
		async exec() {
			throw new Error("이 테스트에는 터미널이 없다");
		},
	};
	const cancellation = {
		async cancel() {
			return [] as readonly string[];
		},
	};
	const service = new EnvironmentToolService(
		browser,
		terminal,
		cancellation,
		options.tiers ?? ALL_TIERS,
		workspaces,
		scripts,
	);
	return { service, calls };
}

function deps(
	service: EnvironmentToolService,
	overrides: Partial<BrowserHostDeps> = {},
): BrowserHostDeps {
	let counter = 0;
	return {
		service,
		workspaceId: "space-1",
		timeoutMs: 5_000,
		newId: () => `op-${++counter}`,
		...overrides,
	};
}

describe("#582 S6a env_browser_* 도구 등록 (FR-ENV-TOOL.13)", () => {
	it("계약이 정한 열두 도구를 등록한다", () => {
		expect(BROWSER_HOST_TOOL_NAMES).toHaveLength(12);
		expect(BROWSER_HOST_TOOLS.map((t) => t.name)).toEqual([...BROWSER_HOST_TOOL_NAMES]);
		for (const tool of BROWSER_HOST_TOOLS) {
			expect(tool.description.length, `${tool.name} 설명이 없다`).toBeGreaterThan(10);
			expect(tool.parameters?.type).toBe("object");
		}
	});

	it("상시 표면 앱 id 는 화면 앱과 다르다", () => {
		expect(BROWSER_HOST_APP_ID).toBe("browser-host");
		expect(BROWSER_HOST_APP_ID).not.toBe("browser");
	});

	it("기존 skill_browser_* 와 이름이 하나도 겹치지 않는다", () => {
		const overlap = BROWSER_HOST_TOOL_NAMES.filter((name) =>
			(LEGACY_BROWSER_TOOLS as string[]).includes(name),
		);
		expect(overlap, "임베디드 웹뷰 도구와 이름이 겹친다").toEqual([]);
		for (const name of BROWSER_HOST_TOOL_NAMES) {
			expect(name.startsWith("skill_browser_"), `${name} 이 기존 접두사를 쓴다`).toBe(false);
			expect(name.startsWith("env_browser_")).toBe(true);
		}
		// 반대 방향도 본다 — 기존 도구가 우리 판정에 걸려 새 경로로 새면 권한이 바뀐다.
		for (const legacy of LEGACY_BROWSER_TOOLS) {
			expect(isBrowserHostTool(legacy), `${legacy} 가 새 분기로 샌다`).toBe(false);
		}
	});

	it("도구마다 서비스의 등급 표에 있는 RPC 이름을 쓴다", () => {
		for (const name of BROWSER_HOST_TOOL_NAMES) {
			const rpc = BROWSER_HOST_RPC_OF[name];
			expect(rpc in BROWSER_RPC_TIERS, `${name} → ${rpc} 가 등급 표에 없다`).toBe(true);
		}
	});
});

describe("#582 S6a 기능 플래그 (계약 4.9)", () => {
	it("값이 없으면 리눅스만 켜진다", () => {
		expect(browserHostEnabled("linux")).toBe(true);
		expect(browserHostEnabled("win32")).toBe(false);
		expect(browserHostEnabled("darwin")).toBe(false);
	});

	it("환경 변수가 OS 기본값을 이긴다", () => {
		expect(browserHostEnabled("win32", { env: { NAIA_EGO_HOST: "1" } })).toBe(true);
		expect(browserHostEnabled("linux", { env: { NAIA_EGO_HOST: "off" } })).toBe(false);
		expect(browserHostEnabled("darwin", { env: { VITE_NAIA_EGO_HOST: "true" } })).toBe(true);
	});

	it("사용자 설정이 환경 변수를 이긴다", () => {
		expect(
			browserHostEnabled("linux", { env: { NAIA_EGO_HOST: "1" }, config: { egoHostEnabled: false } }),
		).toBe(false);
		expect(
			browserHostEnabled("win32", { env: { NAIA_EGO_HOST: "0" }, config: { egoHostEnabled: true } }),
		).toBe(true);
	});

	it("빈 문자열·모르는 값은 사람이 정한 값이 아니다", () => {
		expect(browserHostFlag({ env: { NAIA_EGO_HOST: "  " } })).toBeUndefined();
		// 모르는 값은 코어가 OS 기본값으로 되돌린다.
		expect(browserHostEnabled("win32", { env: { NAIA_EGO_HOST: "maybe" } })).toBe(false);
		expect(browserHostEnabled("linux", { env: { NAIA_EGO_HOST: "maybe" } })).toBe(true);
	});

	it("꺼진 플랫폼에서는 등록할 도구가 없다 — 뇌가 보지 못한다", () => {
		expect(browserHostTools("win32", {})).toEqual([]);
		expect(browserHostTools("darwin", {})).toEqual([]);
		expect(browserHostTools("linux", {})).toHaveLength(12);
		expect(browserHostTools("win32", { config: { egoHostEnabled: true } })).toHaveLength(12);
	});

	it("웹뷰 UA 에서 OS 를 읽는다", () => {
		expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("linux");
		expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("win32");
		expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("darwin");
		expect(detectPlatform("")).toBe("linux");
	});
});

describe("#582 S6a 실행은 EnvironmentToolService 를 거친다 (FR-ENV-TOOL.14)", () => {
	it("스냅샷이 서비스를 지나 포트에 닿고 증거 셋을 돌려준다", async () => {
		const { service, calls } = wiring();
		const result = await executeBrowserHostSkill("env_browser_snapshot", {}, deps(service));
		expect(result.ok).toBe(true);
		expect(calls.map((c) => c.rpc)).toEqual(["snapshot"]);
		expect(result.card.evidence).toEqual(EVIDENCE);
		// 뇌가 읽는 문자열에도 증거가 그대로 실린다.
		expect(JSON.parse(result.text).evidence.url).toBe(EVIDENCE.url);
	});

	it("등급은 서비스의 표가 정한다 — 호출자 선언은 판정에 쓰이지 않는다", async () => {
		// 관측 등급만 부여된 조립. 이동은 workspace-write 라 거부돼야 한다.
		const { service, calls } = wiring({ tiers: ["observe"] });
		const ok = await executeBrowserHostSkill("env_browser_snapshot", {}, deps(service));
		expect(ok.ok).toBe(true);

		const denied = await executeBrowserHostSkill(
			"env_browser_navigate",
			{ url: "https://example.test/" },
			deps(service),
		);
		expect(denied.ok).toBe(false);
		expect(denied.card.status).toBe("refused");
		expect(denied.card.refusals?.[0]?.code).toBe("capability-denied");
		expect(calls.map((c) => c.rpc), "거부됐는데 포트가 불렸다").toEqual(["snapshot"]);
	});

	it("승인 없는 env_browser_script 는 포트 앞에서 거부된다", async () => {
		const { service, calls } = wiring();
		const result = await executeBrowserHostSkill(
			"env_browser_script",
			{ code: "await snapshotText()" },
			deps(service),
		);
		expect(result.ok).toBe(false);
		expect(result.card.status).toBe("refused");
		expect(result.card.refusals?.[0]?.code).toBe("approval-missing");
		// 자식 프로세스가 뜨기 전에 막혀야 한다 — 포트는 한 번도 불리지 않는다.
		expect(calls).toEqual([]);
	});

	it("승인이 있으면 같은 호출이 묶음 실행 포트까지 간다", async () => {
		const { service, calls } = wiring();
		const result = await executeBrowserHostSkill(
			"env_browser_script",
			{ code: "await snapshotText()" },
			deps(service, { approvalRef: "approval-1" }),
		);
		expect(result.ok).toBe(true);
		expect(calls.map((c) => c.rpc)).toEqual(["script"]);
		expect(calls[0]?.request.approvalRef).toBe("approval-1");
		expect(result.card.result).toBe("묶음 실행 결과");
	});

	it("승인 없는 script 가 거부돼도 관측 도구는 그대로 돈다", async () => {
		const { service, calls } = wiring();
		const refused = await executeBrowserHostSkill("env_browser_script", { code: "x" }, deps(service));
		expect(refused.ok).toBe(false);
		const observed = await executeBrowserHostSkill("env_browser_snapshot", {}, deps(service));
		expect(observed.ok).toBe(true);
		expect(calls.map((c) => c.rpc)).toEqual(["snapshot"]);
	});

	it("작업 공간을 만들면 그 손잡이를 셸이 기억한다", async () => {
		const { service } = wiring();
		const remembered: string[] = [];
		const result = await executeBrowserHostSkill(
			"env_browser_create_workspace",
			{ name: "조사" },
			deps(service, { rememberWorkspace: (id) => remembered.push(id) }),
		);
		expect(result.ok).toBe(true);
		expect(remembered).toEqual(["space-7"]);
		expect(result.card.workspaceId).toBe("space-7");
	});

	it("빈 작업 공간 목록은 실패가 아니라 빈 목록이다", async () => {
		const { service } = wiring();
		const result = await executeBrowserHostSkill("env_browser_list_workspaces", {}, deps(service));
		expect(result.ok).toBe(true);
		expect(result.card.workspaces).toEqual([]);
	});

	it("모르는 도구 이름은 조용히 성공하지 않는다", async () => {
		const { service, calls } = wiring();
		const result = await executeBrowserHostSkill("env_browser_teleport", {}, deps(service));
		expect(result.ok).toBe(false);
		expect(result.card.status).toBe("error");
		expect(calls).toEqual([]);
	});
});

describe("#582 S6a 조작 대상 (FR-ENV-TOOL.3)", () => {
	it("참조가 먼저다", () => {
		expect(elementTarget({ ref: "e1" })).toEqual({ kind: "reference", ref: "e1" });
	});

	it("좌표는 이유가 있어야 쓴다", () => {
		expect(elementTarget({ x: 10, y: 20 })).toMatch(/why/);
		expect(elementTarget({ x: 10, y: 20, why: "캔버스라 참조가 없다" })).toEqual({
			kind: "coordinate",
			x: 10,
			y: 20,
			why: "캔버스라 참조가 없다",
		});
	});

	it("참조도 좌표도 없으면 먼저 스냅샷을 부르라고 한다", () => {
		expect(elementTarget({})).toMatch(/env_browser_snapshot/);
	});

	it("좌표를 쓴 사실이 결과에 남는다", async () => {
		const { service } = wiring();
		const result = await executeBrowserHostSkill(
			"env_browser_click",
			{ x: 4, y: 5, why: "캔버스" },
			deps(service),
		);
		expect(result.ok).toBe(true);
		expect(result.card.notes?.join(" ")).toMatch(/좌표 조작 사용/);
	});
});
