import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../persona";

const ctx = {
	userName: "루크",
	honorific: "마스터",
	speechStyle: "polite" as const,
	locale: "ko",
	agentName: "알파",
};

describe("페르소나 사용 안 함", () => {
	it("끄면 성격에 해당하는 것이 프롬프트에 없다", () => {
		const p = buildSystemPrompt("You are Naia (낸), a friendly AI.", ctx, true);
		expect(p).not.toContain("Naia");
		expect(p).not.toContain("루크");
		expect(p).not.toContain("마스터");
		expect(p).not.toContain("알파");
	});

	it("끄더라도 응답 언어 지시는 남는다", () => {
		const p = buildSystemPrompt("아무 페르소나", ctx, true);
		expect(p).toMatch(/Respond in/i);
	});

	it("끄더라도 활성 NVA 동작 안내는 남고 목록이 비면 빠진다", () => {
		const withGesture = buildSystemPrompt(
			"아무 페르소나",
			{ ...ctx, avatarGestures: [{ key: "wave", label: "Wave" }] },
			true,
		);
		expect(withGesture).toContain("wave: Wave");
		expect(withGesture).toContain("[[gesture:key]]");
		const empty = buildSystemPrompt(
			"아무 페르소나",
			{ ...ctx, avatarGestures: [] },
			true,
		);
		expect(empty).not.toContain("NVA gesture actions");
	});

	it("켜면 기존대로 페르소나가 들어간다", () => {
		const p = buildSystemPrompt("You are Naia (낸), a friendly AI.", ctx, false);
		expect(p).toContain("루크");
	});

	it("페르소나를 비워도 기본 페르소나가 들어간다 — 이것이 이 이슈의 원인", () => {
		const p = buildSystemPrompt("", ctx, false);
		expect(p).toContain("friendly AI companion");
	});

	it("끄면 그 기본 페르소나조차 안 들어간다", () => {
		const p = buildSystemPrompt("", ctx, true);
		expect(p).not.toContain("friendly AI companion");
	});
});
