// UC12 graft seam 통합테스트 — completeOnboardingNewCore 가 실 core(dist) 를 경유해
// write_naia_config(agent-only, secret strip) + write_agent_key(키체인) 를 정확히 발신하나.
// f*-live-adapter parity 테스트 등가(graft 배선이 Old-Baseline 보안불변=secret 로컬 미포함 유지 검증).
// ⚠️ shell-compat(core) 는 mock 안 함 — 실 dist 통합(셸→core→invoke 경계 버그 포착, chat .payload 버그류).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn().mockResolvedValue(undefined);
const mockSaveConfig = vi.fn();
let localStore: Record<string, unknown> | null = null;

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
	convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../config", () => ({
	loadConfig: () => localStore,
	saveConfig: (c: Record<string, unknown>) => {
		mockSaveConfig(c);
		localStore = c;
	},
	loadConfigWithSecrets: async () => localStore,
	isOnboardingComplete: () => false,
	NAIA_WEB_BASE_URL: "https://naia.test",
}));
vi.mock("../adk-store", () => ({
	getAdkPath: () => "/adk",
	setAdkPath: vi.fn(),
}));

import { completeOnboardingNewCore } from "../onboarding-core";

describe("UC12 graft seam — completeOnboardingNewCore (실 core 경유)", () => {
	beforeEach(() => {
		mockInvoke.mockClear();
		mockSaveConfig.mockClear();
		localStore = null;
	});

	it("flat(apiKey+naiaKey) → write_naia_config 는 agent-only(secret strip) + write_agent_key 키체인 + markComplete", async () => {
		await completeOnboardingNewCore({
			provider: "openai",
			model: "gpt-4o",
			agentName: "나이아",
			apiKey: "SK",
			naiaKey: "NK",
			workspaceRoot: "/adk",
			onboardingComplete: true,
		});

		// write_naia_config = agent-only(secret 미포함) — 보안 불변(UC12 stale-credential fix)
		const cfgWrite = mockInvoke.mock.calls.find((c) => c[0] === "write_naia_config");
		expect(cfgWrite).toBeTruthy();
		const json = String((cfgWrite?.[1] as { json: string }).json);
		expect(json).not.toContain("SK"); // apiKey 누출 금지
		expect(json).not.toContain("NK"); // naiaKey 누출 금지
		expect(json).toContain("openai"); // agent 필드는 포함

		// write_agent_key = 키체인 envKey 매핑(openai→OPENAI_API_KEY, naiaKey→NAIA_ANYLLM_API_KEY)
		const keyCalls = mockInvoke.mock.calls.filter((c) => c[0] === "write_agent_key").map((c) => c[1]);
		expect(keyCalls).toContainEqual({ adkPath: "/adk", envKey: "OPENAI_API_KEY", value: "SK" });
		expect(keyCalls).toContainEqual({ adkPath: "/adk", envKey: "NAIA_ANYLLM_API_KEY", value: "NK" });

		// 로컬(saveConfig) 엔 secret 미포함
		const localCalls = mockSaveConfig.mock.calls.map((c) => c[0]);
		for (const c of localCalls) {
			expect(c.apiKey).toBeUndefined();
			expect(c.naiaKey).toBeUndefined();
		}
		// markOnboardingComplete → onboardingComplete=true 영속
		expect(localStore?.onboardingComplete).toBe(true);
	});
});
