// UC-CONFIG-SOT / FR-CONFIG-SOT — 부팅 병합은 파일이 SoT, localStorage 는 캐시.
//
// 배경(재현 100%, 2026-07-15): naia-settings/config.json 을 나이아(부스)로 바꿔도 재기동마다
//   스테일 localStorage persona(알파)가 이겨 파일을 덮었다. 원인 = App.tsx 부팅 병합만 유일하게
//   `{ ...local, ...file, ...ui }` 로 local 을 base 로 썼다(워크스페이스 전환은 이미 파일만 base).
import { describe, it, expect } from "vitest";
import { mergeBootConfig } from "../config.js";

describe("mergeBootConfig — 파일이 SoT, localStorage 는 캐시 (FR-CONFIG-SOT.1)", () => {
	it("스테일 localStorage persona 를 config.json 이 덮는다 (핵심 회귀)", () => {
		const local = { persona: "알파", agentName: "알파" }; // 스테일 캐시
		const file = { persona: "나이아", agentName: "나이아" }; // config.json = SoT
		const merged = mergeBootConfig(local, file, null);
		expect(merged?.persona).toBe("나이아");
		expect(merged?.agentName).toBe("나이아");
	});

	it("local 을 base 로 쓰지 않는다 — 파일에 없는 스테일 키가 새어들지 않음", () => {
		// 이전 버그: file 이 persona 를 안 담으면 local.persona 가 스프레드에서 살아남았다.
		const local = { persona: "알파", model: "stale-model", agentName: "알파" };
		const file = { agentName: "나이아" }; // persona/model 키 없음 (부분 config)
		const merged = mergeBootConfig(local, file, null);
		expect(merged).not.toHaveProperty("persona"); // 스테일 알파가 새지 않는다
		expect(merged).not.toHaveProperty("model");
		expect(merged?.agentName).toBe("나이아");
	});

	it("ui-config.json 은 UI 키를 얹는다 (config.json 뒤)", () => {
		const merged = mergeBootConfig(
			{ persona: "알파" },
			{ persona: "나이아" },
			{ vrmModel: "cat.vrm", backgroundImage: "bg.png" },
		);
		expect(merged?.persona).toBe("나이아");
		expect(merged?.vrmModel).toBe("cat.vrm");
		expect(merged?.backgroundImage).toBe("bg.png");
	});
});

describe("mergeBootConfig — 부트스트랩 키 폴백 (workspaceRoot / onboardingComplete)", () => {
	it("파일이 workspaceRoot 를 안 담으면 local 에서 폴백", () => {
		const merged = mergeBootConfig(
			{ workspaceRoot: "C:/Users/x/naia-adk", persona: "알파" },
			{ persona: "나이아" },
			null,
		);
		expect(merged?.workspaceRoot).toBe("C:/Users/x/naia-adk"); // 부트스트랩 유지
		expect(merged?.persona).toBe("나이아"); // 나머지는 파일 우선
	});

	it("파일이 onboardingComplete 를 담으면 파일 우선", () => {
		const merged = mergeBootConfig(
			{ onboardingComplete: false },
			{ onboardingComplete: true, persona: "나이아" },
			null,
		);
		expect(merged?.onboardingComplete).toBe(true);
	});

	it("부트스트랩 외 다른 local 키는 폴백하지 않는다", () => {
		const merged = mergeBootConfig(
			{ theme: "dark", speechStyle: "casual", persona: "알파" }, // 전부 스테일
			{ persona: "나이아" },
			null,
		);
		expect(merged).not.toHaveProperty("theme");
		expect(merged).not.toHaveProperty("speechStyle");
	});
});

describe("mergeBootConfig — 캐시 wipe 방지 (FR-CONFIG-SOT.1)", () => {
	it("파일이 둘 다 없으면 null 반환 (호출자가 기존 캐시 유지, wipe 금지)", () => {
		expect(mergeBootConfig({ persona: "알파" }, null, null)).toBeNull();
	});

	it("config.json 만 있어도 하이드레이트한다", () => {
		const merged = mergeBootConfig(null, { persona: "나이아" }, null);
		expect(merged?.persona).toBe("나이아");
	});

	it("ui-config.json 만 있어도 하이드레이트한다", () => {
		const merged = mergeBootConfig(null, null, { vrmModel: "cat.vrm" });
		expect(merged?.vrmModel).toBe("cat.vrm");
	});

	it("local 이 null 이어도 크래시 없이 파일로 하이드레이트", () => {
		const merged = mergeBootConfig(null, { persona: "나이아" }, { vrmModel: "cat.vrm" });
		expect(merged?.persona).toBe("나이아");
		expect(merged?.vrmModel).toBe("cat.vrm");
	});
});

describe("mergeBootConfig — 워크스페이스 전환과 동형 (비대칭 해소)", () => {
	it("applyWorkspaceConfigToLocal 과 동일하게 파일만 base — 부팅↔전환 대칭", () => {
		// applyWorkspaceConfigToLocal(adk-store.ts:413) = { ...fileConfig, ...uiConfig }.
		// 부팅도 이제 local 을 base 로 쓰지 않으므로 두 경로가 같은 결과를 낸다.
		const file = { persona: "나이아", agentName: "나이아", speechStyle: "formal" };
		const ui = { vrmModel: "cat.vrm" };
		const boot = mergeBootConfig({ persona: "알파" }, file, ui);
		const workspaceSwitch = { ...file, ...ui }; // 전환 경로의 병합
		// 부트스트랩 키를 뺀 나머지가 동일해야 한다.
		for (const k of Object.keys(workspaceSwitch)) {
			expect(boot?.[k]).toEqual((workspaceSwitch as Record<string, unknown>)[k]);
		}
	});
});
