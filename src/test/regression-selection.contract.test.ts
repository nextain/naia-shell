// 회귀 러너가 **환경이 없다고 말한 스펙을 실제로 빼는지** 고정한다.
//
// 왜 이 파일이 있는가: 러너는 십몇 분 도는 프로그램이라, 선별이 옳은지 보려면
// 매번 그 시간을 다시 써야 했다. 그래서 아무도 확인하지 않았고, 확인하지 않은
// 자리가 실제로 어긋났다. `docs/regression-runs/naia-os-3090-2026-09-05T18-02-15-115Z.json`
// 은 그 어긋남이 남은 기계 기록이다 — 러너가 세 스펙을 `envMissingBeforeRun`
// 에 적어 놓고 셋 다 wdio 에 넘겼다. 하나(`96-voice-linux-app-start`)는
// `NAIA_E2E_NAIA_KEY must be a Naia member gateway key` 로 죽어 `stableFailures`
// 에 올랐고, 다른 하나(`88-stt-tts-combo-verification`)는 스스로 통과해
// `executed` 에 올랐다. 재지 않은 것이 한쪽에서는 결함으로, 다른 쪽에서는
// 통과로 세어진 것이다.
//
// 그래서 여기서 재는 것은 러너의 출력이 아니라 **선별 함수 자체**다. 그날의
// 기계에 어떤 키가 있었는지와 무관하게, 같은 입력이면 같은 판단이 나와야 한다.
// 픽스처는 그 기록에서 실제로 어긋났던 세 스펙과 그것들이 속한 설정이다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const SELECTION_PATH = resolve(
	ROOT,
	"scripts",
	"lib",
	"regression-selection.mjs",
);
const MODULE_URL = pathToFileURL(SELECTION_PATH).href;
/** 하네스가 채우는 변수의 정본. 선별과 시딩이 **둘 다** 여기서 읽어야 한다. */
const HARNESS_ENV_PATH = resolve(
	ROOT,
	"packages",
	"shell",
	"e2e-tauri",
	"harness-provided-env.mjs",
);
const HARNESS_ENV_URL = pathToFileURL(HARNESS_ENV_PATH).href;
/** 시딩 모듈. 셸 소스를 정적으로 끌어오면 루트 tsc 가 rootDir 위반으로 붉어진다. */
const SEED_PATH = resolve(
	ROOT,
	"packages",
	"shell",
	"e2e-tauri",
	"credentialed-adk-seed.ts",
);
const WDIO_CONF_PATH = resolve(
	ROOT,
	"packages",
	"shell",
	"e2e-tauri",
	"wdio.conf.ts",
);
const WDIO_CHAT_CONF_PATH = resolve(
	ROOT,
	"packages",
	"shell",
	"e2e-tauri",
	"wdio.conf.chat.ts",
);

/** 인벤토리 한 줄. `docs/e2e-inventory.json` 의 `specs[]` 모양 그대로다. */
type SpecEntry = {
	spec: string;
	conf: readonly string[];
	env: readonly string[];
	tier: string;
	requires?: readonly CapabilityRequirement[];
};

type CapabilityRequirement = {
	capability: string;
	tracker: string;
};

type Selection = {
	partitionByEnv(
		specs: readonly SpecEntry[],
		env: Record<string, string | undefined>,
	): {
		runnable: SpecEntry[];
		envMissing: Map<string, string[]>;
		harnessProvided: Map<string, string[]>;
		capabilityBlocked: Map<string, CapabilityRequirement[]>;
	};
	groupByConf(specs: readonly SpecEntry[]): Map<string, string[]>;
	planGroups(
		specs: readonly SpecEntry[],
		env: Record<string, string | undefined>,
	): {
		groups: Map<string, string[]>;
		runnable: SpecEntry[];
		envMissing: Map<string, string[]>;
		harnessProvided: Map<string, string[]>;
		capabilityBlocked: Map<string, CapabilityRequirement[]>;
		skippedGroups: { conf: string; specs: string[]; reason: string }[];
	};
	wdioSpecArgs(specNames: readonly string[]): string[];
};

const load = async (): Promise<Selection> =>
	(await import(MODULE_URL)) as unknown as Selection;

/**
 * 정본 모듈과 시딩 모듈의 표면. `typeof import(...)` 로 가져오면 루트 tsc 가
 * 셸 소스를 끌어들여 컴파일 무결성 게이트가 붉어지므로 여기 적는다.
 */
interface HarnessEnvModule {
	CREDENTIALED_KEY_ENV: string;
	HARNESS_PROVIDED_ENV: readonly string[];
	HARNESS_PROVIDED_ENV_CONFS: readonly string[];
	credentialedSeedAvailable(env?: Record<string, string | undefined>): boolean;
	credentialedSeedActive(env?: Record<string, string | undefined>): boolean;
	harnessProvidedEnv(
		conf: string,
		env?: Record<string, string | undefined>,
	): string[];
}

const loadHarnessEnv = async (): Promise<HarnessEnvModule> =>
	(await import(HARNESS_ENV_URL)) as unknown as HarnessEnvModule;

const loadSeed = async (): Promise<HarnessEnvModule> =>
	(await import(SEED_PATH)) as unknown as HarnessEnvModule;

/**
 * 실제 기계 기록. 픽스처를 손으로 지어내면 그날 어긋난 모양이 아니라 내가
 * 상상한 모양을 재게 된다.
 */
const RECORD = JSON.parse(
	readFileSync(
		resolve(
			ROOT,
			"docs/regression-runs/naia-os-3090-2026-09-05T18-02-15-115Z.json",
		),
		"utf8",
	),
) as {
	planned: string[];
	executed: string[];
	stableFailures: string[];
	envMissingBeforeRun: Record<string, string[]>;
};

/**
 * 그 기록이 맡았던 몫. 그날의 인벤토리에서 떠 둔 것을 읽는다.
 *
 * 예전에는 살아 있는 `docs/e2e-inventory.json` 에서 집었다. 그러면 그날의
 * 스펙이 제품에서 지워질 때마다(#610 의 23-channels·93-discord, #603 의 88)
 * 픽스처가 그날이 아니게 되어, 선별 함수가 옳아도 이 파일이 붉어졌다.
 */
const SNAPSHOT = JSON.parse(
	readFileSync(
		resolve(
			ROOT,
			"src/test/fixtures/regression-selection-naia-os-3090-2026-09-05.json",
		),
		"utf8",
	),
) as { specs: SpecEntry[] };
const MINE: SpecEntry[] = SNAPSHOT.specs.filter((s) =>
	RECORD.planned.includes(s.spec),
);
/** 오늘의 인벤토리. 그날이 아니라 지금의 선언을 재는 자리에서만 쓴다. */
const INVENTORY = JSON.parse(
	readFileSync(resolve(ROOT, "docs/e2e-inventory.json"), "utf8"),
) as { specs: SpecEntry[] };

/**
 * 그날 기계의 환경. 기록의 `envMissingBeforeRun` 에 적힌 이름만 없고 나머지
 * 요구 변수는 있었다는 뜻이므로, 그대로 되살린다. 값은 아무 문자열이면 된다 —
 * 이 함수는 있는지 없는지만 본다. 진짜 키는 쓰지 않는다.
 */
function envOfThatRun(): Record<string, string> {
	const absent = new Set(Object.values(RECORD.envMissingBeforeRun).flat());
	const env: Record<string, string> = {};
	for (const spec of MINE) {
		for (const name of spec.env) if (!absent.has(name)) env[name] = "present";
	}
	return env;
}

describe("회귀 스펙 선별", () => {
	it("기록이 남은 그 실행에서, 환경이 없던 세 스펙이 실행 목록에 없다", async () => {
		const { planGroups } = await load();
		const { groups, envMissing } = planGroups(MINE, envOfThatRun());

		// 먼저 픽스처가 그날을 정말 되살렸는지 본다. 이것이 어긋나면 아래
		// 단정은 다른 상황을 재는 것이다.
		expect([...envMissing.keys()].sort()).toEqual(
			Object.keys(RECORD.envMissingBeforeRun).sort(),
		);

		const passedToWdio = new Set([...groups.values()].flat());
		for (const spec of Object.keys(RECORD.envMissingBeforeRun)) {
			expect(passedToWdio.has(spec)).toBe(false);
		}
	});

	it("그날 결함으로 기록된 96-voice-linux-app-start 는 애초에 넘어가지 않는다", async () => {
		const { planGroups } = await load();
		const { groups } = planGroups(MINE, envOfThatRun());
		const passedToWdio = new Set([...groups.values()].flat());

		// 기록에는 이것이 `stableFailures` 에 있다 — 두 번 돌려 두 번 죽었다.
		// 죽은 이유는 회귀가 아니라 키가 없다는 것이었다.
		expect(RECORD.stableFailures).toContain("96-voice-linux-app-start.spec.ts");
		expect(passedToWdio.has("96-voice-linux-app-start.spec.ts")).toBe(false);
	});

	it("그날 통과로 세어진 88-stt-tts-combo 도 넘어가지 않는다", async () => {
		const { planGroups } = await load();
		const { groups } = planGroups(MINE, envOfThatRun());
		const passedToWdio = new Set([...groups.values()].flat());

		// 반대 방향의 거짓이다. 키가 없는데 스펙이 스스로 통과해 `executed`
		// 에 올랐고, 완결성 게이트는 그것을 덮인 것으로 셌다.
		expect(RECORD.executed).toContain("88-stt-tts-combo-verification.spec.ts");
		expect(passedToWdio.has("88-stt-tts-combo-verification.spec.ts")).toBe(
			false,
		);
	});

	it("스펙이 전부 환경 부재인 설정은 아예 띄우지 않고, 그 사실을 남긴다", async () => {
		const { planGroups } = await load();
		const { groups, skippedGroups } = planGroups(MINE, envOfThatRun());

		// `wdio.conf.voice-6g.ts` 에는 `94-voice-6g-shell` 하나뿐인데 그 하나가
		// 환경 부재다. 그날 이 설정은 그래도 떠서 통과 0 · failed 로 끝났다.
		expect(groups.has("wdio.conf.voice-6g.ts")).toBe(false);
		expect(skippedGroups.map((g) => g.conf)).toContain("wdio.conf.voice-6g.ts");
		const voice6g = skippedGroups.find(
			(g) => g.conf === "wdio.conf.voice-6g.ts",
		);
		expect(voice6g?.specs).toEqual(["94-voice-6g-shell.spec.ts"]);
		// 사라지는 것이 아니다 — 왜 안 돌렸는지가 기록에 남아야 한다.
		expect(voice6g?.reason).toMatch(/환경/);
	});

	it("환경이 필요 없는 스펙은 그대로 남고, 설정별로 갈린다", async () => {
		const { planGroups } = await load();
		const { groups } = planGroups(MINE, envOfThatRun());

		// 아무것도 요구하지 않는 스펙이 함께 떨어져 나가면 이 수정은 덮개를
		// 줄이는 것이 된다. 반대쪽도 못 박는다.
		expect(groups.get("wdio.conf.ts")).toContain("23-channels-status.spec.ts");
		expect(groups.get("wdio.conf.discord-settings.ts")).toEqual([
			"93-discord-inbox-handoff.spec.ts",
		]);
	});

	it("고른 것이 그대로 wdio 인자가 된다", async () => {
		const { planGroups, wdioSpecArgs } = await load();
		const { groups } = planGroups(MINE, envOfThatRun());
		const args = wdioSpecArgs(
			groups.get("wdio.conf.discord-settings.ts") ?? [],
		);

		// 고르는 자리와 인자를 만드는 자리가 다르면 둘이 갈라져도 아무도
		// 모른다. 한 함수에서 나오는지를 여기서 못 박는다.
		expect(args).toEqual([
			"--spec",
			"e2e-tauri/specs/93-discord-inbox-handoff.spec.ts",
		]);
		// 뺀 스펙의 이름이 인자에 섞이면 선별이 무효다.
		expect(args.join(" ")).not.toContain("94-voice-6g-shell");
	});

	it("빈 문자열은 있는 것으로 읽지 않는다", async () => {
		const { partitionByEnv } = await load();
		const specs: SpecEntry[] = [
			{ spec: "x.spec.ts", conf: [], env: ["K"], tier: "native_local" },
		];

		// 셸에서 `K=` 로 지운 키가 있는 것으로 읽히면, 그 스펙이 자격증명 없이
		// 돌아 다시 결함처럼 죽는다.
		expect(partitionByEnv(specs, { K: "" }).runnable).toEqual([]);
		expect(partitionByEnv(specs, { K: "v" }).envMissing.size).toBe(0);
	});
});

// ── 하네스가 채우는 변수 ────────────────────────────────────────────────────
//
// 위의 계약은 "환경에 없으면 빼라" 를 못 박는다. 그런데 그 판단은 실행 **전**
// 환경만 본다. 자격증명 시딩(#547)이 들어온 뒤로 기본 설정은 스스로
// `NAIA_E2E_ADK_PATH` 와 `NAIA_E2E_ADK_FIXTURE` 를 실행 자리 아래 격리 ADK 로
// 잡는다. 그 둘은 밖에서 채우면 **안 되는** 값이다 — 실제 ADK 경로를 넣으면
// 화면은 실제 ADK, 네이티브는 격리 ADK 를 보는 분리가 난다. 그래서 사람이
// 일부러 비워 두었는데, 선별이 그것을 부재로 읽어 자격증명 등급 마흔여섯 개
// 중 서른여덟 개를 뺐다(이 기계 실측, 넘길 것 8 · 뺄 것 38).
//
// 여기서 재는 것은 셋이다. 하나, 키가 있으면 기본 설정 스펙의 그 둘은 부재가
// 아니다. 둘, 키가 없으면 그대로 부재다 — 시딩이 돌지 않으므로. 셋, 그 사실의
// 출처가 설정 자신이다: 목록이 소스에 하드코딩된 것이 아니라 정본 한 곳에서
// 오고, 그 정본이 말하는 변수를 설정이 실제로 채운다.
describe("하네스가 채우는 변수", () => {
	/** 기본 설정으로 도는, 그 두 변수만 요구하는 스펙 하나. */
	const baseSpec = (env: readonly string[]): SpecEntry => ({
		spec: "harness-filled.spec.ts",
		conf: ["wdio.conf.ts"],
		env,
		tier: "credentialed_live",
	});

	it("키가 있으면 기본 설정 스펙의 두 변수는 부재가 아니다", async () => {
		const { partitionByEnv } = await load();
		const { HARNESS_PROVIDED_ENV, CREDENTIALED_KEY_ENV } =
			await loadHarnessEnv();
		const spec = baseSpec(HARNESS_PROVIDED_ENV);

		const { runnable, envMissing, harnessProvided } = partitionByEnv([spec], {
			[CREDENTIALED_KEY_ENV]: "gw-something",
		});

		// 부재로 세지 않는다 — 이것이 서른여덟 개를 되돌리는 자리다.
		expect(envMissing.size).toBe(0);
		expect(runnable.map((s) => s.spec)).toEqual(["harness-filled.spec.ts"]);
		// 그렇다고 사라지지도 않는다. 왜 안 물었는지가 남아야 러너가 한 줄 찍는다.
		expect(harnessProvided.get("harness-filled.spec.ts")?.sort()).toEqual(
			[...HARNESS_PROVIDED_ENV].sort(),
		);
	});

	it("키가 없으면 그대로 부재다 — 시딩이 돌지 않으므로", async () => {
		const { partitionByEnv } = await load();
		const { HARNESS_PROVIDED_ENV } = await loadHarnessEnv();
		const spec = baseSpec(HARNESS_PROVIDED_ENV);

		const { runnable, envMissing, harnessProvided } = partitionByEnv(
			[spec],
			{},
		);

		// 키가 없으면 설정은 아무것도 심지 않는다. 그때 이 스펙을 넘기면
		// 격리 워크스페이스가 비어 `fetch failed` 로 죽는다 — 고치려던 것과
		// 정확히 반대 방향의 거짓이다.
		expect(runnable).toEqual([]);
		expect(envMissing.get("harness-filled.spec.ts")?.sort()).toEqual(
			[...HARNESS_PROVIDED_ENV].sort(),
		);
		expect(harnessProvided.size).toBe(0);
	});

	it("밖에서 자리를 준 실행에는 규칙이 적용되지 않는다", async () => {
		const { partitionByEnv } = await load();
		const { HARNESS_PROVIDED_ENV, CREDENTIALED_KEY_ENV } =
			await loadHarnessEnv();
		const spec = baseSpec(HARNESS_PROVIDED_ENV);

		// `NAIA_E2E_ADK_PATH` 가 밖에서 오면 워크스페이스의 주인은 밖이고,
		// 기본 설정은 손대지 않는다 — 그러면 폴백(`FIXTURE`)도 채워지지 않는다.
		const { envMissing } = partitionByEnv([spec], {
			[CREDENTIALED_KEY_ENV]: "gw-something",
			NAIA_E2E_ADK_PATH: "/somewhere/outside",
		});
		// 목록을 글자로 다시 적지 않는다 — 정본에 이름이 하나 늘 때마다 이
		// 단정이 갈라지면, 갈라진 쪽을 아무도 보지 않는다(이 모듈이 있는 이유와
		// 같은 사고다). 밖에서 준 하나를 뺀 나머지 전부가 안 채워진다.
		expect(envMissing.get("harness-filled.spec.ts")).toEqual(
			HARNESS_PROVIDED_ENV.filter((name) => name !== "NAIA_E2E_ADK_PATH"),
		);
	});

	it("다른 설정의 스펙에는 규칙이 적용되지 않는다", async () => {
		const { partitionByEnv } = await load();
		const { CREDENTIALED_KEY_ENV, HARNESS_PROVIDED_ENV_CONFS } =
			await loadHarnessEnv();

		// 전용 설정은 자기 환경 모듈이 따로 있고 **다른 조건으로** 채운다.
		// 예컨대 codex 설정은 키와 무관하게 `configureCodexE2eEnvironment()` 로
		// 채운다. 조건이 다른 것을 같은 것으로 말하면 그 자리가 다시 어긋난다.
		expect(HARNESS_PROVIDED_ENV_CONFS).not.toContain("wdio.conf.codex.ts");
		const spec: SpecEntry = {
			spec: "codex.spec.ts",
			conf: ["wdio.conf.codex.ts"],
			env: ["NAIA_E2E_ADK_PATH"],
			tier: "credentialed_live",
		};
		const { envMissing } = partitionByEnv([spec], {
			[CREDENTIALED_KEY_ENV]: "gw-something",
		});
		expect(envMissing.get("codex.spec.ts")).toEqual(["NAIA_E2E_ADK_PATH"]);
	});

	it("정본이 하나다 — 선별 모듈과 시딩 모듈이 같은 목록을 본다", async () => {
		const canonical = await loadHarnessEnv();
		const seed = await loadSeed();

		// 시딩 모듈은 정본을 그대로 다시 내보낸다. 두 곳에 같은 목록을 적으면
		// 다음에 하나가 바뀔 때 조용히 갈라지고, 갈라진 쪽은 십몇 분짜리 실행
		// 에서만 드러난다.
		expect([...seed.HARNESS_PROVIDED_ENV]).toEqual([
			...canonical.HARNESS_PROVIDED_ENV,
		]);
		expect(seed.CREDENTIALED_KEY_ENV).toBe(canonical.CREDENTIALED_KEY_ENV);
		expect(
			seed.harnessProvidedEnv("wdio.conf.ts", { NAIA_API_KEY: "gw-x" }),
		).toEqual(
			canonical.harnessProvidedEnv("wdio.conf.ts", { NAIA_API_KEY: "gw-x" }),
		);

		// 선별 모듈에는 그 이름이 **글자로 없어야** 한다. 값을 되풀이해 적으면
		// 위의 단정은 참이면서도 두 목록이 따로 살 수 있다.
		const selectionSource = readFileSync(SELECTION_PATH, "utf8");
		const importsCanonical = importedModuleSpecifiers(
			parseSource(SELECTION_PATH),
		).some((specifier) => /harness-provided-env\.mjs$/.test(specifier));
		expect(importsCanonical, "선별 모듈이 정본을 import 하지 않는다").toBe(
			true,
		);
		for (const name of canonical.HARNESS_PROVIDED_ENV) {
			expect(
				selectionSource.includes(`"${name}"`),
				`선별 모듈이 ${name} 을 글자로 다시 적었다`,
			).toBe(false);
		}
	});

	it("정본이 말하는 변수를 기본 설정이 실제로 채운다", async () => {
		const { HARNESS_PROVIDED_ENV, HARNESS_PROVIDED_ENV_CONFS } =
			await loadHarnessEnv();

		// 목록만 맞고 설정이 그것을 안 채우면, 선별은 "채워질 것" 이라 믿고
		// 스펙을 넘기는데 스펙은 빈 워크스페이스를 문다. 그래서 설정 소스를
		// 파서로 읽어 **실제 대입 노드**가 있는지 본다 — 주석에는 노드가 없다.
		const conf = parseSource(WDIO_CONF_PATH);
		for (const name of HARNESS_PROVIDED_ENV) {
			expect(
				assignsProcessEnv(conf, name),
				`wdio.conf.ts 가 ${name} 을 채우지 않는다`,
			).toBe(true);
		}

		// chat 설정에는 자기 환경 모듈이 없다. 기반 설정을 그대로 import 해
		// 그 모듈 최상위의 시딩이 함께 도는 것이 근거다. 그 import 가 사라지면
		// 이 설정을 목록에 둘 이유도 사라진다.
		expect(HARNESS_PROVIDED_ENV_CONFS).toContain("wdio.conf.chat.ts");
		expect(
			importedModuleSpecifiers(parseSource(WDIO_CHAT_CONF_PATH)),
			"chat 설정이 기반 설정을 상속하지 않는다",
		).toContain("./wdio.conf.js");
	});

	it("인벤토리의 실제 스펙에서도 그 둘만 남던 부재가 사라진다", async () => {
		const { partitionByEnv } = await load();
		const { HARNESS_PROVIDED_ENV, CREDENTIALED_KEY_ENV } =
			await loadHarnessEnv();

		// 픽스처를 손으로 지으면 내가 상상한 모양을 재게 된다. 실제 인벤토리에서
		// 기본 설정으로 돌면서 그 둘을 요구하는 스펙을 집어, 나머지 요구 변수만
		// 채운 환경에서 넘어가는지 본다.
		const filled = new Set<string>(HARNESS_PROVIDED_ENV);
		const specs = INVENTORY.specs.filter(
			(s) =>
				((s.conf ?? [])[0] ?? "wdio.conf.ts") === "wdio.conf.ts" &&
				s.env.some((name) => filled.has(name)),
		);
		expect(specs.length).toBeGreaterThan(0);

		const env: Record<string, string> = { [CREDENTIALED_KEY_ENV]: "gw-x" };
		for (const spec of specs) {
			for (const name of spec.env) if (!filled.has(name)) env[name] = "present";
		}
		const { envMissing } = partitionByEnv(specs, env);
		expect([...envMissing.keys()]).toEqual([]);
	});
});

/** 파일을 노드로 읽는다. 글자가 아니라 노드로 재기 위해서다. */
function parseSource(path: string): ts.SourceFile {
	return ts.createSourceFile(
		path,
		readFileSync(path, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
}

/** 이 파일이 import 하는 모듈 지정자들. */
function importedModuleSpecifiers(tree: ts.SourceFile): string[] {
	const specifiers: string[] = [];
	for (const statement of tree.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
		specifiers.push(statement.moduleSpecifier.text);
	}
	return specifiers;
}

/**
 * `process.env.<key> = …` 또는 `process.env.<key> ??= …` 가 실제로 있는가.
 *
 * 읽기만 하는 것은 채우는 것이 아니므로 대입 노드만 센다.
 */
function assignsProcessEnv(tree: ts.SourceFile, key: string): boolean {
	const isProcessEnv = (node: ts.Expression): boolean =>
		ts.isPropertyAccessExpression(node) &&
		node.name.text === "env" &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "process";
	const isTarget = (node: ts.Expression): boolean => {
		if (ts.isPropertyAccessExpression(node))
			return node.name.text === key && isProcessEnv(node.expression);
		if (ts.isElementAccessExpression(node))
			return (
				!!node.argumentExpression &&
				ts.isStringLiteralLike(node.argumentExpression) &&
				node.argumentExpression.text === key &&
				isProcessEnv(node.expression)
			);
		return false;
	};
	const assignments = new Set<ts.SyntaxKind>([
		ts.SyntaxKind.EqualsToken,
		ts.SyntaxKind.QuestionQuestionEqualsToken,
		ts.SyntaxKind.BarBarEqualsToken,
	]);
	let found = false;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (
			ts.isBinaryExpression(node) &&
			assignments.has(node.operatorToken.kind) &&
			isTarget(node.left)
		) {
			found = true;
			return;
		}
		node.forEachChild(visit);
	};
	visit(tree);
	return found;
}

// ── 아직 이어지지 않은 능력 (naia-agent#128 류) ─────────────────────────────
//
// 왜 이 묶음이 있는가: 어떤 스펙은 제품이 틀려서가 아니라 그 능력이 아직
// 배선되지 않아 실패한다. `20-cron-basic` 이 그랬다 — 에이전트가 "현재 사용
// 가능한 도구 목록에 skill_cron 이 포함되어 있지 않습니다" 로 답한다. cron
// 어댑터는 naia-agent#128 이 들고 있다.
//
// 지우면 배선되는 날 아무도 되살리지 않는다. 그대로 두면 매 실행마다 사람이
// 제품 결함이 아닌 것을 들여다본다. 그래서 요구 환경과 같은 방식으로 다룬다 —
// 스펙이 스스로 선언하고(`// requires: capability:cron (naia-agent#128)`),
// 러너가 실행에서 빼되 기록과 화면에 이유와 추적처를 남긴다.
describe("능력이 아직 이어지지 않은 스펙", () => {
	const blocked: SpecEntry & { requires: { capability: string; tracker: string }[] } = {
		spec: "20-cron-basic.spec.ts",
		conf: [],
		env: [],
		tier: "credentialed_live",
		requires: [{ capability: "cron", tracker: "naia-agent#128" }],
	};

	it("실행에서 빼되 이유와 추적처를 남긴다", async () => {
		const { partitionByEnv } = await load();
		const { runnable, capabilityBlocked } = partitionByEnv([blocked], {});

		// 돌리면 매번 같은 자리에서 실패한다 — 능력이 없으니까.
		expect(runnable).toEqual([]);
		// 사라지면 배선되는 날 누가 되살릴지 알 수 없다.
		expect(capabilityBlocked.get("20-cron-basic.spec.ts")).toEqual([
			{ capability: "cron", tracker: "naia-agent#128" },
		]);
	});

	it("선언이 없으면 예전과 똑같이 판단한다", async () => {
		const { partitionByEnv } = await load();
		const plain: SpecEntry = {
			spec: "plain.spec.ts",
			conf: [],
			env: [],
			tier: "deterministic_ci",
		};

		// 반대 방향을 못 박지 않으면 "언제나 뺀다" 도 통과한다. 그러면 아무것도
		// 돌지 않으면서 초록이 된다.
		const { runnable, capabilityBlocked } = partitionByEnv([plain], {});
		expect(runnable.map((s) => s.spec)).toEqual(["plain.spec.ts"]);
		expect(capabilityBlocked.size).toBe(0);
	});

	it("wdio 에 넘기는 묶음에도 들어가지 않는다", async () => {
		const { planGroups } = await load();
		const { groups, capabilityBlocked } = planGroups([blocked], {});

		// 넘겨 버리면 스펙이 그 안에서 죽어 결함처럼 기록된다 — 요구 환경이
		// 없는 스펙을 그대로 넘겼던 옛 사고와 같은 모양이다.
		expect([...groups.values()].flat()).toEqual([]);
		expect(capabilityBlocked.size).toBe(1);
	});

	it("인벤토리가 그 선언을 실제로 싣고 있다", () => {
		// 규칙만 있고 인벤토리가 안 실으면 러너는 아무것도 보지 못한다.
		// `docs/e2e-inventory.json` 은 `build-e2e-inventory.mjs` 가 스펙 주석에서
		// 읽어 채운다.
		//
		// 예전에는 `20-cron-basic` 하나를 이름으로 집었다. cron 이 제품에서
		// 빠지며(#611) 그 스펙이 지워지자 이 단정은 선언 배선과 무관하게 붉어졌다.
		// 이제 스펙마다 주석의 선언과 인벤토리의 `requires` 가 같은지 본다 —
		// 선언이 하나도 없는 날에도 "주석에 적었는데 인벤토리가 안 실었다" 는
		// 어긋남은 그대로 잡힌다.
		const marker =
			/^[ \t]*\/\/[ \t]*requires:[ \t]*capability:([A-Za-z0-9_-]+)[ \t]*\(([^)]+)\)/gm;
		for (const entry of INVENTORY.specs) {
			const source = readFileSync(
				resolve(ROOT, "packages", "shell", "e2e-tauri", "specs", entry.spec),
				"utf8",
			);
			const declared = [...source.matchAll(marker)].map((m) => ({
				capability: m[1],
				tracker: m[2].trim(),
			}));
			expect(entry.requires ?? [], `${entry.spec} 의 선언이 인벤토리와 다르다`).toEqual(
				declared,
			);
		}
	});
});

// ── 전용 설정이 스스로 채우는 변수 ─────────────────────────────────────────
//
// `wdio.conf.grok.ts` 는 `process.env.NAIA_E2E_MAIN_PROVIDER = "grok"` 을 적고,
// `wdio.conf.codex.ts` 가 부르는 `codex-e2e-environment.ts` 는 격리 워크스페이스를
// `NAIA_E2E_ADK_PATH` 에 넣는다. 인벤토리가 그것을 요구로 세던 동안 러너는 그
// 설정들이 채울 값을 "없다" 며 스펙을 통째로 뺐다.
describe("전용 설정이 채우는 변수", () => {
	const entry = (name: string) => {
		const found = INVENTORY.specs.find((s) => s.spec === name);
		expect(found, `${name} 이 인벤토리에 없다`).toBeTruthy();
		return found as SpecEntry;
	};

	it("설정이 대입하는 변수는 그 설정이 맡는 스펙의 요구가 아니다", () => {
		expect(entry("96-grok-readiness.spec.ts").env).not.toContain(
			"NAIA_E2E_MAIN_PROVIDER",
		);
		expect(entry("96-grok-readiness.spec.ts").env).not.toContain(
			"NAIA_E2E_MAIN_MODEL",
		);
		expect(entry("90-codex-live-chat.spec.ts").env).not.toContain(
			"NAIA_E2E_ADK_PATH",
		);
	});

	it("설정이 읽기만 하는 변수는 여전히 요구다", () => {
		// 반대쪽을 못 박지 않으면 "설정에 적힌 변수는 다 뺀다" 도 통과한다.
		expect(entry("70c-nextain-default-chat.spec.ts").env).toContain(
			"NAIA_API_KEY",
		);
	});
});
