/**
 * #502 environment observation helpers (FR-ENV-LIVE / FR-ENV-ATTENTION).
 *
 * #611 removed skill_environment from the model-facing registry. This module
 * still owns EnvironmentSession observation used by `always` awareness
 * segments and settings, but App/ChatArea clear the app-skill registration
 * instead of advertising SKILL_ENVIRONMENT to the model.
 */

import { invoke } from "@tauri-apps/api/core";
import {
	EnvironmentSession,
	surfaceRef,
	type DispatchGrants,
	type EnvironmentAwareness,
	type EnvironmentCommandPort,
	type EnvironmentIntent,
} from "@nextain/naia-os-core/composition";
import type { NaiaTool } from "./app-registry";
import { Logger } from "./logger";

/** appExec 등록용 앱 id — 환경은 화면 앱이 아니라 상시 표면이라 app_skills_clear 대상이 아니다. */
export const ENVIRONMENT_APP_ID = "environment";

export const ENVIRONMENT_ACTIONS = ["observe", "watch", "unwatch", "focus", "interrupt", "run"] as const;
export type EnvironmentAction = (typeof ENVIRONMENT_ACTIONS)[number];

export const SKILL_ENVIRONMENT: NaiaTool = {
	name: "skill_environment",
	description:
		"사용자의 작업 표면(터미널·에이전트)을 관측하고 조작한다. 평소에는 표면이 몇 개 열려 있는지만 알려 주고 이름과 손잡이는 주지 않는다 — 자세히 알아야 할 때 스스로 부른다. observe=지금 무엇이 돌고 있는지 목록을 한 번 받는다(손잡이·이름·활동상태). watch=목록을 계속 곁에 두고 본다. 사용자의 작업을 따라가야 하는 동안 쓰고, 끝나면 unwatch 로 되돌린다 — 계속 켜 두면 요청마다 사용자의 터미널 이름이 실린다. unwatch=다시 개수만 보는 상태로 돌아간다. focus=그 표면을 앞으로 가져온다. run=그 표면에서 요청을 실행한다. interrupt=그 표면에서 돌고 있는 것을 멈춘다. surface 인자에는 observe 나 watch 가 준 손잡이를 그대로 쓴다 — 손잡이를 지어내지 않는다. 거절 사유가 오면 성공했다고 말하지 않는다.",
	parameters: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: [...ENVIRONMENT_ACTIONS],
				description: ENVIRONMENT_ACTIONS.join(" | "),
			},
			surface: {
				type: "string",
				description: "observe 가 준 표면 손잡이. focus/run/interrupt 에 필요하다.",
			},
			request: {
				type: "string",
				description: "run 에서 그 표면에 시킬 일.",
			},
		},
		required: ["action"],
	},
	tier: 1,
};

/** Tauri 명령 경계. 코어는 이 포트만 보고 herdr 를 모른다. */
const tauriCommands: EnvironmentCommandPort = {
	invoke: (command, args) => invoke<unknown>(command, args as Record<string, unknown>),
};

/**
 * 셸 세션 하나가 손잡이 발행기를 든다. 모듈 수준인 이유는 손잡이가 대화 턴을 넘어
 * 살아남아야 하기 때문이다 — 관측한 턴과 조작하는 턴이 다르다.
 */
export const environmentSession = new EnvironmentSession();

/**
 * 환경 도구가 뇌에 실제로 등록되어 있다고 마지막으로 확인된 상태 (FR-ENV-ATTENTION.16).
 *
 * 왜 상태로 두는가: 매 턴 확인 응답을 기다리면, 응답이 오지 않을 때 사용자의 모든 대화가
 * 시간초과만큼 멈춘다. 사용자의 말은 즉시 나가야 한다 — 환경은 대화의 조건이 아니다.
 * 그래서 등록은 기다리지 않고 쏘고, 확인이 돌아오면 이 상태가 바뀐다.
 *
 * 한계도 분명하다: 뇌가 방금 죽었다면 확인 실패가 돌아올 때까지 한두 턴은 등록되어 있다고
 * 믿는다. 그 사이 표면이 실릴 수 있다. 이것을 감수하는 대신 대화를 막지 않는다.
 */
let environmentToolAcked = false;

/** 마지막으로 확인된 등록 상태. 판정에 쓴다. */
export function environmentToolRegistered(): boolean {
	return environmentToolAcked;
}

/** 확인 응답이 돌아왔을 때 상태를 갱신한다. */
export function noteEnvironmentToolAck(ok: boolean): void {
	environmentToolAcked = ok;
}

/**
 * 해제가 실패해 뇌에 도구 선언이 남아 있을 수 있는 상태 (FR-ENV-ATTENTION.17).
 *
 * 꺼 두면 대화 턴에서 등록 경로를 타지 않으므로, 실패한 해제는 스스로 낫지 않는다.
 * 그래서 사실을 들고 있다가 다음 턴에 한 번 더 시도한다.
 */
let environmentClearPending = false;

/** 해제가 아직 확인되지 않았는가. */
export function environmentClearNeeded(): boolean {
	return environmentClearPending;
}

/** 해제 시도 결과를 기록한다. 성공하면 더 시도하지 않는다. */
export function noteEnvironmentClear(ok: boolean): void {
	environmentClearPending = !ok;
	// 껐다면 등록되어 있다고 주장하지 않는다. 해제가 실패했더라도 셸이 "등록됨"으로
	// 판정해서는 안 된다 — 다시 켤 때 낡은 참으로 첫 턴에 표면을 실어 버린다
	// (2026-08-28 18차 적대리뷰 지적).
	environmentToolAcked = false;
}

/** 스냅샷을 실제로 가져와 관측을 갱신한다. 실패하면 null — 없는 것을 있는 척하지 않는다. */
export async function refreshEnvironment(): Promise<ReturnType<EnvironmentSession["latestReport"]>> {
	try {
		const snapshot = await invoke<unknown>("herdr_snapshot");
		return environmentSession.observeSnapshot(snapshot as never);
	} catch (e) {
		// Herdr 이 안 돌고 있는 것은 정상 상태다. 아무것도 모르는 상태로 되돌린다 —
		// 마지막으로 본 목록을 계속 싣지 않는다 (FR-ENV-ATTENTION.6). 그렇게 두면 이미
		// 닫힌 터미널 이름이 계속 뇌로 가고, 죽은 손잡이가 살아 있는 것처럼 보인다.
		Logger.info("environment", "herdr snapshot unavailable", { error: String(e) });
		environmentSession.markUnavailable();
		return null;
	}
}

function toIntent(args: Record<string, unknown>): EnvironmentIntent | string {
	const action = typeof args.action === "string" ? args.action : "";
	const surface = typeof args.surface === "string" ? args.surface : "";
	const request = typeof args.request === "string" ? args.request : "";
	switch (action) {
		case "observe":
			return { kind: "observe" };
		case "focus":
			return surface ? { kind: "focus", surface: surfaceRef(surface) } : "focus 에는 표면 손잡이가 필요하다";
		case "interrupt":
			return surface ? { kind: "interrupt", surface: surfaceRef(surface) } : "interrupt 에는 표면 손잡이가 필요하다";
		case "run":
			return surface && request
				? { kind: "run", surface: surfaceRef(surface), request }
				: "run 에는 표면 손잡이와 요청이 모두 필요하다";
		default:
			return `모르는 동작: ${action || "(없음)"} — ${ENVIRONMENT_ACTIONS.join(" | ")} 중 하나여야 한다`;
	}
}

export interface EnvironmentSkillDeps {
	readonly refresh: () => Promise<unknown>;
	readonly commands: EnvironmentCommandPort;
	readonly grants: DispatchGrants;
	readonly session: EnvironmentSession;
	/** 사용자가 정한 인지 수준. always 면 나이아의 watch/unwatch 는 아무것도 바꾸지 못한다. */
	readonly awareness: EnvironmentAwareness;
	/**
	 * 이 호출이 온 경로가 요청마다 표면 세그먼트를 싣는가 (FR-ENV-ATTENTION.10).
	 *
	 * 셸이 대화 요청을 조립하는 경로만 싣는다. 실시간 음성은 연결 시점의 지시문 하나로
	 * 이야기하고, 능동 발화는 뇌가 밀어 주는 것이라 셸이 요청을 만들지 않는다.
	 * 그런데 watch 는 "다음 요청부터 목록이 실린다"고 말한다 — 안 싣는 경로에서 그렇게
	 * 답하면 거짓말이다. 이 슬라이스가 거절을 성공으로 바꾸지 않는 것과 같은 이유로,
	 * 못 하는 것을 한다고 말하지 않는다.
	 *
	 * ⚠️ 기본값은 false 다. 모르는 경로가 생기면 겸손한 쪽으로 틀려야 한다 — 참으로 두면
	 *    새 경로마다 조용히 거짓 약속이 나간다(2026-08-27 11차 적대리뷰에서 실제로 그랬다).
	 */
	readonly segmentsRideRequests: boolean;
	/**
	 * 이 호출로 켜지는 지켜보기의 주인 (FR-ENV-ATTENTION.13).
	 * 실시간 음성은 그 통화의 식별자를 준다 — 통화가 끝날 때 자기가 켠 것만 끄기 위해서다.
	 * 다른 경로는 주지 않는다(주인 없음 = 통화가 끄지 않는다).
	 */
	readonly watchOwner?: string;
}

/** 도구 호출 하나의 결과. 성공 여부를 문자열에서 되짚지 않는다. */
export interface EnvironmentSkillResult {
	readonly text: string;
	readonly ok: boolean;
}

const fail = (text: string): EnvironmentSkillResult => ({ text, ok: false });
const done = (text: string): EnvironmentSkillResult => ({ text, ok: true });

/** 관측 결과를 뇌가 읽을 줄로 편다. observe 와 watch 가 같은 형태를 쓴다. */
function renderReport(report: ReturnType<EnvironmentSession["latestReport"]>): string | null {
	if (report === null) return null;
	if (report.surfaces.length === 0) return "관측됨: 지금 열려 있는 작업 표면이 없다";
	const lines = report.surfaces.map(
		(s) => `${s.ref.token}\t${s.activity}${s.focused ? "\t(사용자가 보고 있음)" : ""}\t${s.label}`,
	);
	const tail = report.omitted > 0 ? `\n(상한 때문에 ${report.omitted}개는 싣지 못했다)` : "";
	return `작업 표면 ${report.surfaces.length}개:\n${lines.join("\n")}${tail}`;
}

/**
 * 도구 호출 하나를 실행하고 뇌가 읽을 결과 문자열을 낸다.
 * 거절과 오류를 성공처럼 쓰지 않는다 — 뇌가 실패를 성공으로 보고하는 경로를 막는다 (FR-ENV-LIVE.5).
 */
export async function executeEnvironmentSkill(
	args: Record<string, unknown>,
	deps: EnvironmentSkillDeps,
): Promise<EnvironmentSkillResult> {
	const action = typeof args.action === "string" ? args.action : "";

	// 사용자가 꺼 두었으면 도구가 아예 등록되지 않는다. 여기 도달했다는 것은 등록 뒤에
	// 껐다는 뜻이다 — 관측도 조작도 하지 않는다 (FR-ENV-ATTENTION.4).
	if (deps.awareness === "off") return fail("거절: 사용자가 작업 표면 인지를 꺼 두었다");

	// 주의 제어 (FR-ENV-ATTENTION.1·2). 환경에 아무 명령도 내리지 않으므로 의도 판정 전에 갈라진다.
	// 사용자가 always 나 off 를 정해 두었으면 나이아의 선택은 그것을 이기지 못한다 — 그 사실을
	// 성공처럼 말하지 않고 그대로 알린다 (FR-ENV-ATTENTION.4).
	if (action === "watch" || action === "unwatch") {
		if (deps.awareness === "always") {
			// 상태가 안 바뀌었으므로 성공이 아니다. 뇌가 껐다고 믿으면 안 된다.
			return fail("무시됨: 사용자가 작업 표면을 늘 싣도록 정해 두었다 — 지켜보기를 켜고 끌 수 없다");
		}
		if (action === "unwatch") {
			deps.session.unwatch();
			return done(
				deps.segmentsRideRequests ? "그만 본다: 다음 요청부터 표면 개수만 실린다" : "그만 본다",
			);
		}
		// 관측이 먼저다. 켜 놓고 실패를 보고하면, 뒤에 환경이 살아났을 때 성공한 watch 없이
		// 표면 이름이 실린다 — 실패라고 말해 놓고 노출 상태만 바꿔 두는 셈이다
		// (2026-08-27 12차 적대리뷰 지적).
		await deps.refresh();
		const rendered = renderReport(deps.session.latestReport());
		if (rendered === null) {
			return fail("지켜보지 못한다: 작업 표면 환경이 지금 응답하지 않는다");
		}
		deps.session.watch(deps.watchOwner);
		const promise = deps.segmentsRideRequests
			? "지켜본다: 다음 요청부터 목록이 실린다"
			: "지켜본다고 표시했다. 다만 지금 이야기하는 이 경로(실시간 음성)는 요청마다 목록을 싣지 않는다 — 변화가 궁금하면 그때그때 observe 를 불러라";
		return done(`${promise}\n${rendered}`);
	}

	const intent = toIntent(args);
	if (typeof intent === "string") return fail(`거절: ${intent}`);

	// 조작도 관측을 먼저 갱신한다. 사라진 표면의 손잡이가 무효가 되는 지점이다.
	await deps.refresh();

	if (intent.kind === "observe") {
		const rendered = renderReport(deps.session.latestReport());
		if (rendered === null) return fail("관측 불가: 작업 표면 환경이 지금 응답하지 않는다");
		return done(rendered);
	}

	const outcome = await deps.session.act(intent, deps.commands, deps.grants);
	if (outcome.ok) return done(`전달됨: ${intent.kind}`);
	if ("environmentError" in outcome) return fail(`환경 오류: ${outcome.environmentError}`);
	return fail(`거절: ${outcome.rejections.map((r) => `${r.code} — ${r.detail}`).join(" / ")}`);
}

/** 라이브 배선용 기본 의존. 터미널 입력 권한과 인지 수준을 호출자가 정한다. */
export function liveEnvironmentDeps(
	terminalInput: boolean,
	awareness: EnvironmentAwareness = "auto",
	segmentsRideRequests = false,
	watchOwner?: string,
): EnvironmentSkillDeps {
	const grants: DispatchGrants = { workspaceObserve: true, terminalInput };
	return {
		refresh: refreshEnvironment,
		commands: tauriCommands,
		grants,
		session: environmentSession,
		awareness,
		segmentsRideRequests,
		watchOwner,
	};
}
