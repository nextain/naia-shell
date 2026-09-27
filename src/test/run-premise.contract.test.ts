// 회귀 실행의 **전제** — 그 세션들에 뇌가 있었는가 — 를 기록이 담는지 고정한다.
//
// 왜 이 파일이 있는가: 2026-09-06 naia-os-3090 의 자격증명 등급 실행은 마흔 개를
// 맡아 서른두 개를 안정 실패로 기록했다. 그런데 그 실패는 대부분 제품의 것이
// 아니었다 — 서른여덟 개 스펙 중 서른일곱이 에이전트 없이 돌았다. 앞 세션이
// 남긴 고아 agent 자식이 실행 자리의 리스를 쥐어, 다음 앱은 뇌를 띄우지 못한
// 채로 떴고 스펙은 그대로 진행했다. 로그에는 그 사실이 그대로 있었다
// (`agent_lease_live_blocked` 37회, 성사된 기동 3회). **기록에는 한 글자도
// 없었다.** 그래서 사람이 그 숫자를 믿고 win-rtx4060 의 실패와 가족별로
// 비교하는 헛일을 했다. 자세한 것은
// `docs/regression-runs/analysis-2026-09-06-credentialed.md` 에 있다.
//
// 로그는 다음 실행이 덮어쓴다. 그러니 세는 자리는 실행 자신이어야 한다.
// 여기서 재는 것은 그 세는 규칙이다 — 무엇을 기동으로 세고 무엇을 세지 않는지,
// 그리고 어떤 조합이 "전제 불성립" 인지.
//
// 픽스처의 줄 모양은 그 실행의 로그
// (`regression-3090-cred.log`, 574KB)에서 그대로 가져왔고, 반복 횟수는 그
// 로그에서 실측한 수(기동 3 · 막힘 37)다. 로그 파일 자체는 실행 자리에만 있어
// 저장소에 없으므로, 줄 모양과 수를 여기 옮겨 고정한다.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const MODULE_URL = pathToFileURL(
	resolve(ROOT, "scripts", "lib", "run-premise.mjs"),
).href;

/**
 * 모듈 표면. `.mjs` 를 정적으로 끌어오면 루트 tsc 프로그램이 스크립트를
 * 프로그램에 넣어 rootDir 위반으로 컴파일 무결성 게이트가 붉어진다.
 */
interface PremiseModule {
	countPremiseSignals(output: string): {
		agentStarts: number;
		leaseBlocked: number;
	};
	addPremiseSignals(
		left: { agentStarts: number; leaseBlocked: number },
		right: { agentStarts: number; leaseBlocked: number },
	): { agentStarts: number; leaseBlocked: number };
	judgePremise(input: {
		agentStarts: number;
		leaseBlocked: number;
		executed: number;
		expectedStarts?: number;
	}): { premise: string; reason: string };
	launchesSharedApp(
		confSource: string,
		readSibling?: (name: string) => string | null,
	): boolean;
	expectedGroupStarts(input: { sharedApp: boolean; ran: number }): number;
}

const load = async (): Promise<PremiseModule> =>
	(await import(MODULE_URL)) as unknown as PremiseModule;

// ── 실제 로그에서 그대로 옮긴 줄 모양 ──────────────────────────────────────
/** 에이전트가 실제로 떴다. 이것만이 기동이다. */
const STARTED = "[0-0] [Naia] agent-core started";
/** 같은 사실, 다른 워커 접두. 접두가 달라도 세어야 한다. */
const STARTED_OTHER_PREFIX = "[codex-e2e:app] [Naia] agent-core started";
/** 앞 세션의 고아가 쥔 리스에 막혔다. */
const BLOCKED =
	"[0-1] [Naia] agent-core not available: agent_lease_live_blocked";
/**
 * 기동 **시도**. 이 줄만으로는 뇌가 떴다고 말할 수 없다 — 그래서 세지 않는다.
 * 실측한 그 실행에서 시도와 성사는 똑같이 3회였다.
 */
const ATTEMPT =
	"[0-0] [Naia] Starting agent-core: /usr/bin/node /repo/scripts/builds/agent-stdio-entry.mjs";
/** 막힌 뒤에 쏟아지는 잡음. 이것을 기동으로 세면 전제가 늘 성립한다. */
const NOISE = [
	"[0-1] [Naia] Restarting agent-core...",
	"[0-1] [Naia] agent-core restart debounced (5000ms cooldown remaining)",
	"[0-1] [Naia] Running without agent (chat will be unavailable)",
	"[0-1] [Naia] node = /usr/bin/node",
];

const repeat = (line: string, times: number): string[] =>
	Array.from({ length: times }, () => line);

/**
 * 무효였던 그 실행의 모양. 기동 3 · 막힘 37.
 *
 * 접두가 다른 기동 한 줄을 섞어 둔다 — 실제 로그에서 세 번째 기동은 codex
 * 묶음의 것이었고 접두가 달랐다.
 */
const INVALID_RUN = [
	ATTEMPT,
	...repeat(STARTED, 2),
	STARTED_OTHER_PREFIX,
	...repeat(BLOCKED, 37),
	...NOISE,
].join("\n");

/** 4060 의 정상 실행 모양. 기동 57 = 세션 57 · 막힘 0. */
const HEALTHY_RUN = [...repeat(ATTEMPT, 57), ...repeat(STARTED, 57)].join("\n");

describe("실행 전제 — 그 세션들에 뇌가 있었는가", () => {
	it("무효였던 그 실행의 로그에서 기동 3 · 막힘 37 을 센다", async () => {
		const { countPremiseSignals } = await load();
		expect(countPremiseSignals(INVALID_RUN)).toEqual({
			agentStarts: 3,
			leaseBlocked: 37,
		});
	});

	it("그 실행은 전제 불성립이고, 이유가 함께 남는다", async () => {
		const { countPremiseSignals, judgePremise } = await load();
		const signals = countPremiseSignals(INVALID_RUN);
		const verdict = judgePremise({ ...signals, executed: 38 });

		expect(verdict.premise).toBe("invalid");
		// 이유가 없으면 기록을 읽는 사람이 다시 로그를 찾아야 하는데, 로그는
		// 다음 실행이 덮어쓴다. 두 사실이 다 들어 있어야 한다.
		expect(verdict.reason).toContain("37");
		expect(verdict.reason).toContain("3");
	});

	it("4060 형태 — 기동 57 = 세션 57 · 막힘 0 이면 성립한다", async () => {
		const { countPremiseSignals, judgePremise } = await load();
		const signals = countPremiseSignals(HEALTHY_RUN);
		expect(signals).toEqual({ agentStarts: 57, leaseBlocked: 0 });

		const verdict = judgePremise({ ...signals, executed: 57 });
		expect(verdict.premise).toBe("ok");
		expect(verdict.reason).toBe("");
	});

	it("기동 시도와 재시작 잡음은 기동으로 세지 않는다", async () => {
		const { countPremiseSignals } = await load();

		// 이것이 느슨해지면 전제는 언제나 성립한다 — 막힌 세션일수록 이
		// 잡음이 더 쏟아지기 때문이다(그 실행에서 `restart debounced` 는
		// 1470회였다). 그러면 이 장치가 정확히 반대로 거짓말을 하게 된다.
		expect(countPremiseSignals([ATTEMPT, ...NOISE].join("\n"))).toEqual({
			agentStarts: 0,
			leaseBlocked: 0,
		});
	});

	it("막힘이 없어도 기동 수가 모자라면 성립하지 않는다", async () => {
		const { judgePremise } = await load();

		// 리스만 보면 놓치는 자리가 있다. 앱이 아예 뜨지 못한 세션은 막힘
		// 줄도 남기지 않는다 — 그때도 그 스펙에는 뇌가 없었다.
		const verdict = judgePremise({
			agentStarts: 30,
			leaseBlocked: 0,
			executed: 38,
		});
		expect(verdict.premise).toBe("invalid");
		expect(verdict.reason).toContain("30");
	});

	it("묶음별로 센 것을 더한다 — 묶음마다 wdio 를 따로 부르기 때문이다", async () => {
		const { addPremiseSignals, countPremiseSignals, judgePremise } =
			await load();

		// 한 묶음만 보면 다른 묶음에서 막힌 세션을 놓친다. 실제로 그 실행은
		// 기본 설정·chat·codex-delegation 세 묶음이었다.
		const first = countPremiseSignals([STARTED, STARTED].join("\n"));
		const second = countPremiseSignals(
			[STARTED_OTHER_PREFIX, ...repeat(BLOCKED, 37)].join("\n"),
		);
		const total = addPremiseSignals(first, second);
		expect(total).toEqual({ agentStarts: 3, leaseBlocked: 37 });
		expect(judgePremise({ ...total, executed: 38 }).premise).toBe("invalid");
	});

	it("앱을 onPrepare 에서 한 번 띄우는 설정은 묶음마다 기동 하나를 기대한다", async () => {
		const { expectedGroupStarts, judgePremise, launchesSharedApp } =
			await load();

		// 2026-09-26 win-rtx4060: codex 묶음은 스펙 둘에 기동 하나였다. 스펙
		// 수와 비교하면 뇌가 있었던 실행을 "전제 불성립" 으로 버리게 된다.
		const codexConf =
			"async onPrepare() {\n\t\tawait startOwnedViteServer();\n\t\tawait startOwnedEmbeddedApp(TAURI_BINARY);\n\t},";
		const radioConf =
			"async onPrepare() { reset(); await start(binary); },";
		const defaultConf =
			"async onPrepare() {\n\t\treclaimLeakedAgentChild();\n\t\tawait requirePortFree(VITE_PORT, VITE_HOST);\n\t},";
		expect(launchesSharedApp(codexConf)).toBe(true);
		expect(launchesSharedApp(radioConf)).toBe(true);
		expect(launchesSharedApp(defaultConf)).toBe(false);
		// codex-delegation 은 codex 설정을 펼쳐 그 onPrepare 를 물려받는다.
		const delegationConf =
			'import { config as codexConfig } from "./wdio.conf.codex.js";\nexport const config = { ...codexConfig, specs: [] };';
		const siblings: Record<string, string> = {
			"wdio.conf.codex.ts": codexConf,
		};
		expect(
			launchesSharedApp(delegationConf, (name) => siblings[name] ?? null),
		).toBe(true);
		// 가져오기만 하고 펼치지 않으면 물려받지 않는다.
		expect(
			launchesSharedApp(
				'import { config as codexConfig } from "./wdio.conf.codex.js";\nexport const config = {};',
				(name) => siblings[name] ?? null,
			),
		).toBe(false);

		expect(expectedGroupStarts({ sharedApp: true, ran: 2 })).toBe(1);
		// 한 스펙도 돌지 못했으면 앱이 떴다고 기대하지 않는다.
		expect(expectedGroupStarts({ sharedApp: true, ran: 0 })).toBe(0);
		expect(expectedGroupStarts({ sharedApp: false, ran: 62 })).toBe(62);

		const expectedStarts =
			expectedGroupStarts({ sharedApp: false, ran: 62 }) +
			expectedGroupStarts({ sharedApp: true, ran: 2 });
		expect(
			judgePremise({
				agentStarts: 63,
				leaseBlocked: 0,
				executed: 64,
				expectedStarts,
			}).premise,
		).toBe("ok");
		// 공유 앱이 아예 뜨지 않았다면 여전히 깨진다.
		const broken = judgePremise({
			agentStarts: 62,
			leaseBlocked: 0,
			executed: 64,
			expectedStarts,
		});
		expect(broken.premise).toBe("invalid");
		expect(broken.reason).toContain("63");
	});
});
