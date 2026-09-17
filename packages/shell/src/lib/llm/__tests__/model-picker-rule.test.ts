// 선택기 숨김 규칙 (에픽 #589 할 일 2, #598): 나이아 로그인은 모델 하나만 알고,
// 제공자가 고를 수 있는 대화 모델이 하나뿐이면 모델 선택기를 그리지 않는다.
// 판정은 등록부(모델 목록)로 한다.
import { describe, expect, it } from "vitest";
import {
	getLlmProvider,
	selectableConversationModels,
	shouldHideModelPicker,
} from "../registry";
import type { LlmModelMeta } from "../types";

const model = (
	id: string,
	capabilities: LlmModelMeta["capabilities"] = ["llm"],
): LlmModelMeta => ({ id, label: id, capabilities });

describe("선택기 숨김 규칙 · selectableConversationModels", () => {
	it("ASR(전용 STT) 모델은 대화 선택지에서 뺀다", () => {
		const models = [model("deepseek-v4-flash"), model("whisper", ["asr"])];
		expect(selectableConversationModels(models).map((m) => m.id)).toEqual([
			"deepseek-v4-flash",
		]);
	});

	it("omni 모델은 대화 선택지에 남긴다(실시간 음성 겸용)", () => {
		const models = [model("gemini-2.5-flash-live", ["llm", "omni"])];
		expect(selectableConversationModels(models)).toHaveLength(1);
	});
});

describe("선택기 숨김 규칙 · shouldHideModelPicker", () => {
	it("고를 수 있는 대화 모델이 하나뿐이면 선택기를 숨긴다", () => {
		expect(shouldHideModelPicker([model("deepseek-v4-flash")])).toBe(true);
	});

	it("대화 모델이 둘 이상이면 선택기를 보인다", () => {
		expect(
			shouldHideModelPicker([model("deepseek-v4-flash"), model("grok-4.3")]),
		).toBe(false);
	});

	it("선택지가 없으면(빈 목록) 선택기를 숨긴다", () => {
		expect(shouldHideModelPicker([])).toBe(true);
	});

	it("남는 대화 모델이 하나뿐이면 ASR 모델이 섞여 있어도 숨긴다", () => {
		expect(
			shouldHideModelPicker([
				model("deepseek-v4-flash"),
				model("whisper", ["asr"]),
			]),
		).toBe(true);
	});
});

describe("선택기 숨김 규칙 · 나이아 계정 단일 모델 전환", () => {
	it("게이트웨이가 나이아 계정을 단일 모델로 줄이면 규칙이 선택기를 숨긴다", () => {
		// 게이트웨이 카탈로그가 계정 모델을 하나로 줄인 상태를 표현.
		const singleAccountModel = [model("deepseek-v4-flash")];
		expect(shouldHideModelPicker(singleAccountModel)).toBe(true);
	});

	it("나이아 계정 기본 모델은 deepseek-v4-flash 하나다", () => {
		// 등록부의 나이아 계정 제공자 기본값이 단일 대화 모델임을 못박는다.
		const nextain = getLlmProvider("nextain");
		expect(nextain?.defaultModel).toBe("deepseek-v4-flash");
	});
});
