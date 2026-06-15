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

import { completeOnboardingNewCore, makeOnboardingSession } from "../onboarding-core";

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

// step-flow graft(step2) — session 이 실 core OnboardingController 를 경유해 assets/단계전이/게이트/auth 를 구동.
describe("UC12 step-flow graft seam — makeOnboardingSession (실 core 경유)", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		mockInvoke.mockResolvedValue(undefined);
		mockSaveConfig.mockClear();
		localStore = null;
	});

	it("assets(kind) → invoke list_naia_assets(adkPath, subdir) + AssetRef(path/type 재유도)", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_naia_assets") return Promise.resolve(["a.vrm", "bg.mp4"]);
			return Promise.resolve(undefined);
		});
		const s = makeOnboardingSession();
		const refs = await s.assets("vrm-files");
		const call = mockInvoke.mock.calls.find((c) => c[0] === "list_naia_assets");
		expect(call?.[1]).toEqual({ adkPath: "/adk", subdir: "vrm-files" });
		expect(refs.map((r) => r.path)).toContain("/adk/naia-settings/vrm-files/a.vrm");
		// 영상 확장자 → type=video(셸 blob 회피 분기 근거)
		expect(refs.find((r) => r.path.endsWith("bg.mp4"))?.type).toBe("video");
	});

	/** welcome→provider 까지 전진(공통). */
	async function toProvider(s: ReturnType<typeof makeOnboardingSession>) {
		await s.submit({ step: "welcome" });
		await s.submit({ step: "agentName", agentName: "나이아" });
		await s.submit({ step: "userName", userName: "루크" });
		await s.submit({ step: "speechStyle", speechStyle: "casual" });
		await s.submit({ step: "character", vrmModel: "/v.vrm" });
		return s.submit({ step: "background", background: "space" });
	}

	it("submit 전진 = 순서 불변식 누적 → provider 도달", async () => {
		const s = makeOnboardingSession();
		expect(s.currentStep()).toBe("welcome");
		const at = await toProvider(s);
		expect(at.step).toBe("provider");
	});

	it("★ provider-naia 게이트: 미로그인 nextain submit = 전이 차단(step 유지)", async () => {
		const s = makeOnboardingSession();
		await toProvider(s);
		const blocked = await s.submit({ step: "provider", provider: "nextain" });
		expect(blocked.step).toBe("provider"); // 게이트 차단
	});

	it("★ onNaiaAuthCallback → NAIA_ANYLLM_API_KEY 키체인 1회(idempotent) + 게이트 해제 → provider submit = complete", async () => {
		const s = makeOnboardingSession();
		await toProvider(s);
		await s.onNaiaAuthCallback("NK");
		await s.onNaiaAuthCallback("NK2"); // 중복 = no-op
		const keyCalls = mockInvoke.mock.calls.filter(
			(c) => c[0] === "write_agent_key" && (c[1] as { envKey: string }).envKey === "NAIA_ANYLLM_API_KEY",
		);
		expect(keyCalls).toHaveLength(1); // idempotent
		expect((keyCalls[0][1] as { value: string }).value).toBe("NK");
		// 게이트 해제 후 nextain submit → complete 전이
		const done = await s.submit({ step: "provider", provider: "nextain" });
		expect(done.step).toBe("complete");
	});

	it("비-naia provider(apiKey 직결) submit = 게이트 무관 전이(provider→complete)", async () => {
		const s = makeOnboardingSession();
		await toProvider(s);
		const done = await s.submit({ step: "provider", provider: "glm", apiKey: "K" });
		expect(done.step).toBe("complete");
	});

	// ★ 불변식 앵커(R1 리뷰 MEDIUM): 게이트 차단으로 core 가 provider 에 멈춘 상태에서도
	// completeWith 는 core draft 가 아닌 **셸 snapshot** 으로 영속해야 한다(persist=snapshot, draft 미사용).
	// 누가 completeWith 를 draft-병합형으로 바꾸면 이 테스트가 RED.
	it("★ 게이트 차단(미로그인 nextain) 상태 + completeWith = core draft 아닌 셸 snapshot 영속", async () => {
		const s = makeOnboardingSession();
		await toProvider(s); // draft 누적(agentName='나이아' 등)
		const blocked = await s.submit({ step: "provider", provider: "nextain" }); // 게이트 차단 → draft.provider=nextain, step 유지
		expect(blocked.step).toBe("provider");
		// 전혀 다른 값의 셸 snapshot 으로 완료
		await s.completeWith({
			provider: "glm",
			model: "glm-4.6",
			agentName: "스냅샷이름",
			apiKey: "K",
			workspaceRoot: "/adk",
			onboardingComplete: true,
		});
		const cfgWrite = mockInvoke.mock.calls.find((c) => c[0] === "write_naia_config");
		const json = String((cfgWrite?.[1] as { json: string }).json);
		expect(json).toContain("glm"); // snapshot provider 반영
		expect(json).toContain("스냅샷이름"); // snapshot agentName 반영
		expect(json).not.toContain("나이아"); // core draft agentName 미반영(draft 미사용 입증)
		expect(json).not.toContain("nextain"); // core draft provider 미반영
	});
});
