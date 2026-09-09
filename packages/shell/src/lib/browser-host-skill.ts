/**
 * #582 S6a 실배선 — 에이전트 브라우저 호스트 도구 (`env_browser_*`).
 *
 * 배선 = environment-skill.ts 와 같은 상시 표면 경로:
 *   부팅 시 App.tsx 가 sendAppSkills(BROWSER_HOST_APP_ID, browserHostTools()) 등록
 *   → agent 가 LLM 에 노출 → app_tool_call
 *   → ChatArea dispatchAppToolCall 의 브라우저 호스트 분기가 executeBrowserHostSkill 실행
 *   → EnvironmentToolService (코어 조립 makeEnvironmentToolService)
 *   → BrowserOperationPort · BrowserWorkspacePort · BrowserScriptPort · CancellationPort
 *   → 감독자 → Chromium.
 *
 * 세 가지를 여기서 못 박는다.
 *
 * 1. **서비스를 거치지 않는 길은 없다.** 기존 `skill_browser_*` 는 React 에서 Tauri 명령을 직접
 *    부르고 `addAllowedTool` 로 승인까지 건너뛴다(BrowserCenterArea.tsx:521-546). 그 경로는 등급도
 *    증거도 취소도 없다. 새 도구는 그러지 않는다 — 등급은 서비스의 표가 정하고(BROWSER_RPC_TIERS),
 *    승인은 서비스가 요구하며(BROWSER_RPCS_REQUIRING_APPROVAL), 셸은 **결과와 거부 사유를 그대로**
 *    도구 결과에 싣는다. `addAllowedTool` 은 이 파일에 없다.
 * 2. **꺼져 있으면 등록하지 않는다.** 기능 플래그가 꺼진 OS 에서 도구를 등록해 두고 안에서 거절하면
 *    뇌는 매 요청 도구 선언에 토큰을 쓰면서 아무것도 못 한다. 뇌가 아예 보지 못하게 한다.
 * 3. **이름이 겹치지 않는다.** `skill_browser_*`(임베디드 웹뷰)와 `env_browser_*`(백그라운드 호스트)는
 *    다른 것이다. 겹치면 뇌가 사용자의 화면을 건드리는 도구와 건드리지 않는 도구를 구별하지 못한다.
 */

import {
	ALL_TIERS,
	egoHostEnabled,
	makeEnvironmentToolService,
	type BrowserEvidence,
	type BrowserWorkspace,
	type CapabilityTier,
	type EgoPlatform,
	type ElementTarget,
	type EnvOperationRequest,
	type EnvRejection,
	EnvironmentToolService,
	type EnvironmentToolWiring,
} from "@nextain/naia-os-core/composition";
import type { NaiaTool } from "./app-registry";
import { getAdkPath } from "./adk-store";
import { loadConfig } from "./config";
import { Logger } from "./logger";

/** appExec 등록용 앱 id — 브라우저 호스트는 화면 앱이 아니라 상시 표면이라 app_skills_clear 대상이 아니다. */
export const BROWSER_HOST_APP_ID = "browser-host";

/** 뇌에 노출하는 도구 이름. 순서가 곧 등록 순서다. */
export const BROWSER_HOST_TOOL_NAMES = [
	"env_browser_create_workspace",
	"env_browser_list_workspaces",
	"env_browser_close_workspace",
	"env_browser_open",
	"env_browser_navigate",
	"env_browser_snapshot",
	"env_browser_click",
	"env_browser_fill",
	"env_browser_evaluate",
	"env_browser_screenshot",
	"env_browser_close",
	"env_browser_script",
] as const;

export type BrowserHostToolName = (typeof BROWSER_HOST_TOOL_NAMES)[number];

/**
 * 도구 이름 → 서비스의 RPC 이름. 등급은 서비스의 표(`BROWSER_RPC_TIERS`)가 이 이름으로 정한다.
 * 표에 없는 이름을 여기 적으면 서비스가 등급을 못 찾는다 — 테스트가 두 표를 맞대어 본다.
 */
export const BROWSER_HOST_RPC_OF: Readonly<Record<BrowserHostToolName, string>> = {
	env_browser_create_workspace: "createWorkspace",
	env_browser_list_workspaces: "listWorkspaces",
	env_browser_close_workspace: "closeWorkspace",
	env_browser_open: "open",
	env_browser_navigate: "navigate",
	env_browser_snapshot: "snapshot",
	env_browser_click: "click",
	env_browser_fill: "fill",
	env_browser_evaluate: "evaluate",
	env_browser_screenshot: "screenshot",
	env_browser_close: "close",
	env_browser_script: "script",
};

export function isBrowserHostTool(name: string): name is BrowserHostToolName {
	return (BROWSER_HOST_TOOL_NAMES as readonly string[]).includes(name);
}

const objectSchema = (
	properties: Record<string, unknown>,
	required: string[] = [],
): NaiaTool["parameters"] => ({ type: "object", properties, required });

const REF_ARG = {
	ref: {
		type: "string",
		description: "직전 env_browser_snapshot 이 준 참조. 지어내지 않는다. 없으면 먼저 스냅샷을 찍는다.",
	},
};

/**
 * 도구 선언. `tier` 는 셸 승인 UI 의 등급이고, 실제 권한 판정은 서비스가 한다 —
 * 여기 값이 낮다고 서비스가 통과시키지 않고, 높다고 서비스가 더 허용하지도 않는다.
 * `env_browser_script` 만 2(확인)인 이유는 임의 자바스크립트라 건별 승인이 계약이기 때문이다.
 */
export const BROWSER_HOST_TOOLS: readonly NaiaTool[] = [
	{
		name: "env_browser_create_workspace",
		description:
			"에이전트 전용 브라우저에 격리된 작업 공간을 하나 연다. 이 공간은 사용자의 브라우저가 아니고 화면도 없으며 로그인되어 있지 않다. 이후의 브라우저 도구는 이 공간에서 돈다.",
		parameters: objectSchema({
			name: { type: "string", description: "이 일감을 부르는 짧은 이름." },
		}),
		tier: 1,
	},
	{
		name: "env_browser_list_workspaces",
		description: "지금 열려 있는 브라우저 작업 공간을 나열한다. 보기만 한다.",
		parameters: objectSchema({}),
		tier: 1,
	},
	{
		name: "env_browser_close_workspace",
		description: "작업 공간 하나를 닫는다. 그 공간의 탭·쿠키·저장소가 사라진다.",
		parameters: objectSchema(
			{ workspace_id: { type: "string", description: "닫을 공간의 손잡이." } },
			["workspace_id"],
		),
		tier: 1,
	},
	{
		name: "env_browser_open",
		description: "작업 공간에 새 탭을 열어 주소로 간다. 사용자의 창은 열리지 않는다.",
		parameters: objectSchema({ url: { type: "string", description: "http/https 주소." } }, ["url"]),
		tier: 1,
	},
	{
		name: "env_browser_navigate",
		description: "지금 탭에서 다른 주소로 간다.",
		parameters: objectSchema({ url: { type: "string", description: "http/https 주소." } }, ["url"]),
		tier: 1,
	},
	{
		name: "env_browser_snapshot",
		description:
			"지금 페이지의 접근성 구조를 참조가 달린 글로 받는다. 조작하기 전에 이것을 먼저 부른다 — 참조는 이 호출이 만든다.",
		parameters: objectSchema({}),
		tier: 1,
	},
	{
		name: "env_browser_click",
		description:
			"스냅샷의 참조로 요소를 누른다. 참조로 못 잡을 때만 좌표를 쓰고, 그때는 why 에 이유를 적는다 — 그 사실이 결과에 남는다.",
		parameters: objectSchema({
			...REF_ARG,
			x: { type: "number", description: "좌표 조작일 때의 x(CSS 픽셀)." },
			y: { type: "number", description: "좌표 조작일 때의 y(CSS 픽셀)." },
			why: { type: "string", description: "참조 대신 좌표를 쓴 이유." },
		}),
		tier: 1,
	},
	{
		name: "env_browser_fill",
		description: "스냅샷의 참조가 가리키는 입력란에 값을 넣는다.",
		parameters: objectSchema({ ...REF_ARG, value: { type: "string", description: "넣을 값." } }, [
			"value",
		]),
		tier: 1,
	},
	{
		name: "env_browser_evaluate",
		description:
			"페이지 안에서 한 덩어리 자바스크립트를 평가하고 값을 받는다. 효과가 고정된 평가다 — 여러 단계를 묶어 돌리는 것은 env_browser_script 이고 등급이 다르다.",
		parameters: objectSchema(
			{ expression: { type: "string", description: "한 번에 값을 내는 식." } },
			["expression"],
		),
		tier: 1,
	},
	{
		name: "env_browser_screenshot",
		description:
			"지금 페이지를 캡처한다. 저장 위치는 감독자가 정하고 결과에는 그 참조만 온다 — 경로를 지정하지 않는다.",
		parameters: objectSchema({}),
		tier: 1,
	},
	{
		name: "env_browser_close",
		description: "지금 탭을 닫는다. 작업 공간은 남는다.",
		parameters: objectSchema({}),
		tier: 1,
	},
	{
		name: "env_browser_script",
		description:
			"여러 단계를 자바스크립트 한 덩어리로 묶어 브라우저에서 실행한다. 터미널에서 명령을 돌리는 것과 같은 등급이며 호출마다 사용자 승인이 필요하다. 승인이 없으면 거부되고, 거부는 실패다 — 형식 도구를 늘어놓아 같은 효과를 내려 하지 않는다.",
		parameters: objectSchema({ code: { type: "string", description: "실행할 자바스크립트." } }, [
			"code",
		]),
		tier: 2,
	},
];

// ── 기능 플래그 (계약 4.9) ────────────────────────────────────────────────────

/** 플래그 값의 출처. 사람이 정한 값이 있으면 그것이 OS 기본값을 이긴다. */
export interface BrowserHostFlagSource {
	/** 빌드·실행 환경. 셸에서는 `import.meta.env` 다. `NAIA_EGO_HOST` 와 `VITE_NAIA_EGO_HOST` 를 본다. */
	readonly env?: Readonly<Record<string, unknown>> | undefined;
	/** 사용자 설정. `egoHostEnabled` 를 본다. */
	readonly config?: { readonly egoHostEnabled?: boolean } | null | undefined;
}

/**
 * 사람이 정한 값을 하나로 모은다. 설정이 환경보다 세다 — 설정은 사용자가 이 기계에서 직접 정한 값이고,
 * 환경 변수는 실행을 감싼 쪽이 정한 값이다. 둘 다 없으면 undefined 이고 그때 OS 기본값이 답한다.
 */
export function browserHostFlag(source: BrowserHostFlagSource): string | boolean | undefined {
	if (typeof source.config?.egoHostEnabled === "boolean") return source.config.egoHostEnabled;
	const env = source.env ?? {};
	for (const key of ["NAIA_EGO_HOST", "VITE_NAIA_EGO_HOST"]) {
		const value = env[key];
		if (typeof value === "boolean") return value;
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
}

/**
 * 이 OS 에서 켜는가. 판정 자체는 코어의 `egoHostEnabled` 가 한다 — 셸이 따로 판정하면
 * 조립이 켜 둔 것과 셸이 등록한 것이 갈라져, 뇌가 보는 도구와 실제로 도는 포트가 어긋난다.
 */
export function browserHostEnabled(
	platform: EgoPlatform,
	source: BrowserHostFlagSource = {},
): boolean {
	return egoHostEnabled(platform, browserHostFlag(source));
}

/** 웹뷰에서 OS 를 읽는다. Tauri 웹뷰의 UA 는 호스트 OS 를 그대로 담는다. */
export function detectPlatform(userAgent: string): EgoPlatform {
	if (/windows/i.test(userAgent)) return "win32";
	if (/mac os x|macintosh/i.test(userAgent)) return "darwin";
	return "linux";
}

// ── 조립 ──────────────────────────────────────────────────────────────────────

/**
 * 감독자를 실제로 띄우는 쪽(node)으로 가는 다리.
 *
 * ⚠️ 셸 웹뷰에는 node 가 없다. 코어의 기본 로더는 `packages/ego-host/src/host-api.mjs` 를
 *    동적 import 하므로 웹뷰에서는 실패하고, 그 실패는 **형식 있는 거부 사유로 그대로** 뇌에
 *    올라간다(조용한 성공이 아니다). 다리를 놓는 일은 이 슬라이스 밖이며, 그때까지는
 *    `globalThis.__NAIA_EGO_HOST_API__` 로 주입된 구현이 있으면 그것을 쓴다 —
 *    계약 테스트(node)와 Playwright e2e(브라우저)가 같은 자리를 쓴다.
 */
function injectedHostApi(): unknown {
	return (globalThis as { __NAIA_EGO_HOST_API__?: unknown }).__NAIA_EGO_HOST_API__;
}

/**
 * 포트 대역 자리 (개발·테스트 전용).
 *
 * Playwright e2e 는 실 UI 위에서 돌지만 웹뷰 안에는 감독자도 Chromium 도 없다. 그래서 **어댑터
 * 아래**를 대역으로 바꾼다 — 서비스(`EnvironmentToolService`)와 등급표·승인 규칙·결과 카드는
 * 실물 그대로다. 감독자와 실 Chromium 을 지나는 경로는 S3a 계약 테스트가 실 Chromium 으로 돈다.
 *
 * 프로덕션 번들에서는 `import.meta.env.DEV` 가 거짓이라 이 자리를 아예 보지 않는다.
 */
export interface BrowserHostPortsOverride {
	readonly browser: ConstructorParameters<typeof EnvironmentToolService>[0];
	readonly terminal?: ConstructorParameters<typeof EnvironmentToolService>[1];
	readonly cancellation: ConstructorParameters<typeof EnvironmentToolService>[2];
	readonly tiers?: readonly CapabilityTier[];
	readonly workspaces?: ConstructorParameters<typeof EnvironmentToolService>[4];
	readonly scripts?: ConstructorParameters<typeof EnvironmentToolService>[5];
}

function devMode(): boolean {
	const env = viteEnv();
	return env.DEV === true || env.MODE === "test" || env.MODE === "development";
}

function injectedPorts(): BrowserHostPortsOverride | undefined {
	if (!devMode()) return undefined;
	return (globalThis as { __NAIA_BROWSER_HOST_PORTS__?: BrowserHostPortsOverride })
		.__NAIA_BROWSER_HOST_PORTS__;
}

const NO_TERMINAL: ConstructorParameters<typeof EnvironmentToolService>[1] = {
	async exec() {
		throw new Error("이 조립에는 터미널 포트가 없다");
	},
};

export interface BrowserHostWiringOptions {
	readonly adkDir?: string | null;
	readonly platform?: EgoPlatform;
	readonly grantedTiers?: readonly CapabilityTier[];
	readonly flag?: BrowserHostFlagSource;
}

let wiring: EnvironmentToolWiring | null = null;
let wiringAdkDir: string | null = null;

/**
 * 조립 하나를 만든다. ADK 가 바뀌면 새로 만든다 — 감독자의 lease·프로필·소켓·증거가 전부
 * ADK 아래이므로 A 의 조립으로 B 를 건드리면 남의 워크스페이스에 브라우저를 남긴다.
 */
export function browserHostWiring(options: BrowserHostWiringOptions = {}): EnvironmentToolWiring {
	const adkDir = options.adkDir ?? getAdkPath() ?? "";
	if (wiring && wiringAdkDir === adkDir) return wiring;
	const platform = options.platform ?? detectPlatform(navigatorUserAgent());
	const flag = browserHostFlag(options.flag ?? { env: viteEnv(), config: loadConfig() });
	const ports = injectedPorts();
	if (ports) {
		wiring = {
			service: new EnvironmentToolService(
				ports.browser,
				ports.terminal ?? NO_TERMINAL,
				ports.cancellation,
				ports.tiers ?? options.grantedTiers ?? ALL_TIERS,
				ports.workspaces,
				ports.scripts,
			),
			environment: null,
			enabled: true,
		};
		wiringAdkDir = adkDir;
		return wiring;
	}
	const api = injectedHostApi();
	wiring = makeEnvironmentToolService({
		adkDir,
		platform,
		grantedTiers: options.grantedTiers ?? ALL_TIERS,
		...(flag !== undefined ? { egoHostFlag: flag } : {}),
		...(api ? { loadApi: async () => api as never } : {}),
	});
	wiringAdkDir = adkDir;
	return wiring;
}

/** ADK 전환·재시작 뒤 다음 호출이 새 조립을 만들게 한다. 여기서 감독자를 내리지는 않는다. */
export function resetBrowserHostWiring(): void {
	wiring = null;
	wiringAdkDir = null;
}

function navigatorUserAgent(): string {
	return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

function viteEnv(): Record<string, unknown> {
	try {
		return (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {};
	} catch {
		return {};
	}
}

// ── 승인 ──────────────────────────────────────────────────────────────────────

/**
 * 건별 승인 장부 (FR-ENV-TOOL.14). `env_browser_script` 는 이 장부에 승인 참조가 있어야만
 * 서비스가 포트를 부른다. **셸이 스스로 채우지 않는다** — 채우면 "승인"이 이름만 남는다.
 * 사용자가 승인 UI 에서 허락한 순간에만 기록된다.
 */
const approvals = new Map<string, string>();

export function grantBrowserHostApproval(toolCallId: string, approvalRef: string): void {
	if (toolCallId && approvalRef) approvals.set(toolCallId, approvalRef);
}

export function takeBrowserHostApproval(toolCallId: string): string | undefined {
	const ref = approvals.get(toolCallId);
	if (ref) approvals.delete(ref);
	return ref;
}

export function clearBrowserHostApprovals(): void {
	approvals.clear();
}

// ── 실행 ──────────────────────────────────────────────────────────────────────

/** 결과 카드 하나. 뇌도 사람도 이것을 읽는다 — 문자열 접두사로 성공을 되짚지 않는다. */
export interface BrowserHostCard {
	readonly kind: "browser-host";
	readonly tool: string;
	/** `pending` 은 아직 결과가 없다는 뜻이다 — 성공으로 세지 않는다. */
	readonly status: "pending" | "success" | "refused" | "error";
	readonly workspaceId: string;
	readonly operationId?: string;
	readonly evidence?: BrowserEvidence;
	readonly workspaces?: readonly BrowserWorkspace[];
	readonly result?: string;
	readonly notes?: readonly string[];
	readonly refusals?: readonly EnvRejection[];
	readonly deduplicated?: boolean;
}

export interface BrowserHostResult {
	readonly ok: boolean;
	readonly card: BrowserHostCard;
	/** 뇌에게 보낼 문자열. 카드를 그대로 실어 거부 사유가 뭉개지지 않게 한다. */
	readonly text: string;
}

export interface BrowserHostDeps {
	readonly service: EnvironmentToolService;
	readonly workspaceId: string;
	readonly timeoutMs: number;
	/** 이 호출에 붙은 승인 참조. 없으면 서비스가 승인이 필요한 RPC 를 거부한다. */
	readonly approvalRef?: string | undefined;
	readonly newId: () => string;
	/** 새 공간이 생기면 셸이 그것을 기억한다. */
	readonly rememberWorkspace?: (id: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** 공간을 아직 만들지 않았을 때 쓰는 자리. 감독자가 이 이름으로 첫 공간을 잡는다. */
export const DEFAULT_WORKSPACE_ID = "naia-browser";

let currentWorkspaceId = DEFAULT_WORKSPACE_ID;

export function browserHostWorkspaceId(): string {
	return currentWorkspaceId;
}

export function setBrowserHostWorkspaceId(id: string): void {
	if (id) currentWorkspaceId = id;
}

function str(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	return typeof value === "string" ? value : "";
}

function num(args: Record<string, unknown>, key: string): number | null {
	const value = args[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 참조가 먼저다. 좌표는 참조가 없을 때의 예외이고 이유가 있어야 한다 (FR-ENV-TOOL.3). */
export function elementTarget(args: Record<string, unknown>): ElementTarget | string {
	const ref = str(args, "ref");
	if (ref) return { kind: "reference", ref };
	const x = num(args, "x");
	const y = num(args, "y");
	if (x === null || y === null) return "참조(ref)나 좌표(x, y)가 필요하다 — 먼저 env_browser_snapshot 을 부른다";
	const why = str(args, "why");
	if (!why) return "좌표로 찍으려면 why 에 참조를 쓸 수 없는 이유를 적어야 한다";
	return { kind: "coordinate", x, y, why };
}

function request(deps: BrowserHostDeps, tier: CapabilityTier): EnvOperationRequest {
	const id = deps.newId();
	return {
		operationId: id,
		idempotencyKey: id,
		// 호출자 선언은 판정에 쓰이지 않는다 — 서비스의 표가 RPC 마다 등급을 고정한다.
		capability: tier,
		timeoutMs: deps.timeoutMs,
		workspaceId: deps.workspaceId,
		...(deps.approvalRef ? { approvalRef: deps.approvalRef } : {}),
	};
}

function refused(tool: string, workspaceId: string, refusals: readonly EnvRejection[]): BrowserHostResult {
	const card: BrowserHostCard = { kind: "browser-host", tool, status: "refused", workspaceId, refusals };
	return { ok: false, card, text: JSON.stringify(card) };
}

function failed(tool: string, workspaceId: string, detail: string): BrowserHostResult {
	const card: BrowserHostCard = {
		kind: "browser-host",
		tool,
		status: "error",
		workspaceId,
		refusals: [{ code: "disconnected", detail }],
	};
	return { ok: false, card, text: JSON.stringify(card) };
}

function succeeded(card: BrowserHostCard): BrowserHostResult {
	return { ok: true, card, text: JSON.stringify(card) };
}

/**
 * 도구 호출 하나. 서비스가 낸 판정을 그대로 카드에 싣는다 —
 * 거부·오류를 성공으로 바꾸지 않고, 성공을 문자열에서 되짚지도 않는다.
 */
export async function executeBrowserHostSkill(
	toolName: string,
	args: Record<string, unknown>,
	deps: BrowserHostDeps,
): Promise<BrowserHostResult> {
	if (!isBrowserHostTool(toolName)) {
		return failed(toolName, deps.workspaceId, `브라우저 호스트 도구가 아니다: ${toolName}`);
	}
	const workspaceId = deps.workspaceId;
	const service = deps.service;
	try {
		switch (toolName) {
			case "env_browser_create_workspace": {
				const outcome = await service.createWorkspace(request(deps, "workspace-write"));
				if (!outcome.ok) return refused(toolName, workspaceId, outcome.rejections);
				deps.rememberWorkspace?.(outcome.value.id);
				return succeeded({
					kind: "browser-host",
					tool: toolName,
					status: "success",
					workspaceId: outcome.value.id,
					operationId: outcome.operationId,
					workspaces: [outcome.value],
				});
			}
			case "env_browser_list_workspaces": {
				const outcome = await service.listWorkspaces(request(deps, "observe"));
				if (!outcome.ok) return refused(toolName, workspaceId, outcome.rejections);
				return succeeded({
					kind: "browser-host",
					tool: toolName,
					status: "success",
					workspaceId,
					operationId: outcome.operationId,
					workspaces: outcome.value,
				});
			}
			case "env_browser_close_workspace": {
				const target = str(args, "workspace_id") || workspaceId;
				const outcome = await service.closeWorkspace(request(deps, "workspace-write"), target);
				if (!outcome.ok) return refused(toolName, workspaceId, outcome.rejections);
				return succeeded({
					kind: "browser-host",
					tool: toolName,
					status: "success",
					workspaceId: target,
					operationId: outcome.operationId,
				});
			}
			case "env_browser_close": {
				const outcome = await service.close(request(deps, "workspace-write"));
				if (!outcome.ok) return refused(toolName, workspaceId, outcome.rejections);
				return succeeded({
					kind: "browser-host",
					tool: toolName,
					status: "success",
					workspaceId,
					operationId: outcome.operationId,
				});
			}
			default:
				return await runEvidenceRpc(toolName, args, deps);
		}
	} catch (error) {
		Logger.warn("browser-host", "tool call threw", { tool: toolName, error: String(error) });
		return failed(toolName, workspaceId, String(error));
	}
}

/** 증거를 돌려주는 RPC 묶음. 증거가 없으면 서비스가 완료로 세지 않는다 (FR-ENV-TOOL.6). */
async function runEvidenceRpc(
	toolName: BrowserHostToolName,
	args: Record<string, unknown>,
	deps: BrowserHostDeps,
): Promise<BrowserHostResult> {
	const service = deps.service;
	const workspaceId = deps.workspaceId;
	let outcome: Awaited<ReturnType<EnvironmentToolService["snapshot"]>>;
	switch (toolName) {
		case "env_browser_open": {
			const url = str(args, "url");
			if (!url) return refused(toolName, workspaceId, [{ code: "workspace-escape", detail: "url 이 필요하다" }]);
			outcome = await service.open(request(deps, "workspace-write"), url);
			break;
		}
		case "env_browser_navigate": {
			const url = str(args, "url");
			if (!url) return refused(toolName, workspaceId, [{ code: "workspace-escape", detail: "url 이 필요하다" }]);
			outcome = await service.navigate(request(deps, "workspace-write"), url);
			break;
		}
		case "env_browser_snapshot":
			outcome = await service.snapshot(request(deps, "observe"));
			break;
		case "env_browser_screenshot":
			outcome = await service.screenshot(request(deps, "observe"));
			break;
		case "env_browser_click": {
			const target = elementTarget(args);
			if (typeof target === "string") {
				return refused(toolName, workspaceId, [{ code: "workspace-escape", detail: target }]);
			}
			outcome = await service.click(request(deps, "workspace-write"), target);
			break;
		}
		case "env_browser_fill": {
			const target = elementTarget(args);
			if (typeof target === "string") {
				return refused(toolName, workspaceId, [{ code: "workspace-escape", detail: target }]);
			}
			outcome = await service.fill(request(deps, "workspace-write"), target, str(args, "value"));
			break;
		}
		case "env_browser_evaluate": {
			const expression = str(args, "expression");
			if (!expression) {
				return refused(toolName, workspaceId, [{ code: "workspace-escape", detail: "expression 이 필요하다" }]);
			}
			outcome = await service.evaluate(request(deps, "workspace-write"), { expression });
			break;
		}
		case "env_browser_script": {
			const code = str(args, "code");
			if (!code) return refused(toolName, workspaceId, [{ code: "workspace-escape", detail: "code 가 필요하다" }]);
			outcome = await service.script(request(deps, "workspace-write"), code);
			break;
		}
		default:
			return failed(toolName, workspaceId, `증거 RPC 가 아니다: ${toolName}`);
	}
	if (!outcome.ok) return refused(toolName, workspaceId, outcome.rejections);
	const operation = outcome.operation;
	const evidence = operation.evidence?.kind === "browser" ? operation.evidence.value : undefined;
	return succeeded({
		kind: "browser-host",
		tool: toolName,
		status: "success",
		workspaceId,
		operationId: operation.operationId,
		...(evidence ? { evidence } : {}),
		...(operation.result !== undefined ? { result: operation.result } : {}),
		...(operation.notes.length > 0 ? { notes: operation.notes } : {}),
		...(operation.deduplicated ? { deduplicated: true } : {}),
	});
}

/** 라이브 배선용 기본 의존. ADK·플래그·승인 장부를 여기서 한 번에 읽는다. */
export function liveBrowserHostDeps(toolCallId: string): BrowserHostDeps {
	const approvalRef = takeBrowserHostApproval(toolCallId);
	return {
		service: browserHostWiring().service,
		workspaceId: browserHostWorkspaceId(),
		timeoutMs: DEFAULT_TIMEOUT_MS,
		...(approvalRef ? { approvalRef } : {}),
		newId: () => `${toolCallId || "env-browser"}-${Date.now().toString(36)}`,
		rememberWorkspace: setBrowserHostWorkspaceId,
	};
}

/**
 * 등록할 도구 목록. 꺼져 있으면 **빈 목록**이다 — 호출자는 빈 목록이면 등록하지 않는다.
 * 판정을 여기 한 곳에 두는 이유는 "등록은 켜졌는데 조립은 꺼진" 상태가 생기지 않게 하기 위해서다.
 */
export function browserHostTools(
	platform: EgoPlatform = detectPlatform(navigatorUserAgent()),
	source: BrowserHostFlagSource = { env: viteEnv(), config: loadConfig() },
): readonly NaiaTool[] {
	return browserHostEnabled(platform, source) ? BROWSER_HOST_TOOLS : [];
}
