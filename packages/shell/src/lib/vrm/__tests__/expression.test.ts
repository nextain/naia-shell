import { describe, expect, it } from "vitest";
import {
	createEmotionController,
	extractExpression,
	mapServerEmotion,
	parseEmotion,
} from "../expression";

describe("extractExpression (robust avatar cue extraction)", () => {
	it("reads an uppercase emotion tag and strips it", () => {
		expect(extractExpression("[HAPPY] 좋아!")).toEqual({
			emotion: "happy",
			cleanText: "좋아!",
		});
	});

	it("maps a lowercase server prosody tag", () => {
		expect(extractExpression("정말요? [laughing] 처음 들어봐요.").emotion).toBe(
			"happy",
		);
		expect(extractExpression("[sigh] 오늘 피곤하셨겠어요.").emotion).toBe("sad");
	});

	it("strips the prosody tag from cleanText", () => {
		expect(extractExpression("정말요? [laughing] 처음.").cleanText).toBe(
			"정말요? 처음.",
		);
	});

	it("reads a leaked parenthetical stage direction and strips it", () => {
		const r = extractExpression("(smiles) 안녕하세요");
		expect(r.emotion).toBe("happy");
		expect(r.cleanText).toBe("안녕하세요");
	});

	it("reads a leaked asterisk narration", () => {
		expect(extractExpression("*sighs* 그렇군요").emotion).toBe("sad");
	});

	it("returns null (no neutral reset) when there is no cue", () => {
		expect(extractExpression("그냥 평범한 문장입니다").emotion).toBeNull();
	});

	it("first cue wins", () => {
		expect(extractExpression("[HAPPY] 좋아 [sigh] 근데").emotion).toBe("happy");
	});

	it("ignores non-emotive prosody (breath/pause) → null, still stripped", () => {
		expect(extractExpression("[breath] 음, 그건").emotion).toBeNull();
		expect(extractExpression("[breath] 음.").cleanText).toBe("음.");
	});
});

describe("mapServerEmotion (naia-omni emotion.updated → avatar)", () => {
	it("maps each known emotion (case/bracket-insensitive)", () => {
		expect(mapServerEmotion("happy")).toBe("happy");
		expect(mapServerEmotion("HAPPY")).toBe("happy");
		expect(mapServerEmotion("[Sad]")).toBe("sad");
		expect(mapServerEmotion(" angry ")).toBe("angry");
		expect(mapServerEmotion("surprised")).toBe("surprised");
		expect(mapServerEmotion("neutral")).toBe("neutral");
		expect(mapServerEmotion("think")).toBe("think");
	});

	it("maps server prosody tags to avatar emotions", () => {
		expect(mapServerEmotion("laughing")).toBe("happy");
		expect(mapServerEmotion("chuckle")).toBe("happy");
		expect(mapServerEmotion("sigh")).toBe("sad");
		expect(mapServerEmotion("gasp")).toBe("surprised");
		expect(mapServerEmotion("shout")).toBe("angry");
		expect(mapServerEmotion("hesitation")).toBe("think");
	});

	it("returns null for non-emotive / unknown tags (no neutral reset)", () => {
		expect(mapServerEmotion("breath")).toBeNull();
		expect(mapServerEmotion("pause")).toBeNull();
		expect(mapServerEmotion("shy")).toBeNull(); // not in the server prosody vocab
		expect(mapServerEmotion("")).toBeNull();
	});
});

describe("parseEmotion", () => {
	it("parses [HAPPY] tag", () => {
		const result = parseEmotion("[HAPPY] 좋아!");
		expect(result.emotion).toBe("happy");
		expect(result.cleanText).toBe("좋아!");
	});

	it("parses [SAD] tag", () => {
		const result = parseEmotion("[SAD] 슬퍼요...");
		expect(result.emotion).toBe("sad");
		expect(result.cleanText).toBe("슬퍼요...");
	});

	it("parses [ANGRY] tag", () => {
		const result = parseEmotion("[ANGRY] 화나!");
		expect(result.emotion).toBe("angry");
		expect(result.cleanText).toBe("화나!");
	});

	it("parses [SURPRISED] tag", () => {
		const result = parseEmotion("[SURPRISED] 헉!");
		expect(result.emotion).toBe("surprised");
		expect(result.cleanText).toBe("헉!");
	});

	it("parses [NEUTRAL] tag", () => {
		const result = parseEmotion("[NEUTRAL] 네, 알겠습니다.");
		expect(result.emotion).toBe("neutral");
		expect(result.cleanText).toBe("네, 알겠습니다.");
	});

	it("parses [THINK] tag", () => {
		const result = parseEmotion("[THINK] 음... 그건...");
		expect(result.emotion).toBe("think");
		expect(result.cleanText).toBe("음... 그건...");
	});

	it("defaults to neutral when no tag", () => {
		const result = parseEmotion("태그 없는 텍스트");
		expect(result.emotion).toBe("neutral");
		expect(result.cleanText).toBe("태그 없는 텍스트");
	});

	it("handles empty string", () => {
		const result = parseEmotion("");
		expect(result.emotion).toBe("neutral");
		expect(result.cleanText).toBe("");
	});

	it("strips mid-text emotion tags", () => {
		const result = parseEmotion("[HAPPY] 안녕! [SAD] 그런데 슬퍼...");
		expect(result.emotion).toBe("happy");
		expect(result.cleanText).toBe("안녕! 그런데 슬퍼...");
	});

	it("strips emotion tags on new lines", () => {
		const result = parseEmotion("[HAPPY] 좋아!\n[SAD] 하지만...");
		expect(result.emotion).toBe("happy");
		expect(result.cleanText).toBe("좋아!\n하지만...");
	});

	it("strips standalone emotion tag lines", () => {
		const result = parseEmotion("[THINK]\n생각 중이야...");
		expect(result.emotion).toBe("think");
		expect(result.cleanText).toBe("생각 중이야...");
	});

	it("strips tag at end of text", () => {
		const result = parseEmotion("끝이야 [HAPPY]");
		expect(result.emotion).toBe("happy");
		expect(result.cleanText).toBe("끝이야");
	});
});

describe("createEmotionController", () => {
	/** VRM 1.0 style expression names (lowercase) */
	function createMockVrm10() {
		const values = new Map<string, number>();
		return {
			expressionManager: {
				expressionMap: {
					happy: {},
					sad: {},
					angry: {},
					surprised: {},
					neutral: {},
					aa: {},
					oh: {},
					ee: {},
				},
				setValue: (name: string, value: number) => {
					values.set(name, value);
				},
				getValue: (name: string) => values.get(name) ?? 0,
			},
			_values: values,
		};
	}

	/** VRM 0.0 style expression names (PascalCase, Joy/Sorrow/Fun) */
	function createMockVrm00() {
		const values = new Map<string, number>();
		return {
			expressionManager: {
				expressionMap: {
					Neutral: {},
					Joy: {},
					Sorrow: {},
					Angry: {},
					Fun: {},
					Surprised: {},
					A: {},
					I: {},
					U: {},
					E: {},
					O: {},
					Blink: {},
				},
				setValue: (name: string, value: number) => {
					values.set(name, value);
				},
				getValue: (name: string) => values.get(name) ?? 0,
			},
			_values: values,
		};
	}

	it("creates controller with setEmotion and update", () => {
		const vrm = createMockVrm10();
		const controller = createEmotionController(vrm as any);
		expect(controller.setEmotion).toBeDefined();
		expect(controller.update).toBeDefined();
	});

	it("setEmotion happy sets target expressions (VRM 1.0)", () => {
		const vrm = createMockVrm10();
		const controller = createEmotionController(vrm as any);
		controller.setEmotion("happy");
		controller.update(0.5);
		expect(vrm._values.get("happy")).toBeGreaterThan(0);
	});

	it("setEmotion happy maps to Joy for VRM 0.0 model", () => {
		const vrm = createMockVrm00();
		const controller = createEmotionController(vrm as any);
		controller.setEmotion("happy");
		controller.update(0.5);
		expect(vrm._values.get("Joy")).toBeGreaterThan(0);
	});

	it("setEmotion sad maps to Sorrow for VRM 0.0 model", () => {
		const vrm = createMockVrm00();
		const controller = createEmotionController(vrm as any);
		controller.setEmotion("sad");
		controller.update(0.5);
		expect(vrm._values.get("Sorrow")).toBeGreaterThan(0);
	});

	it("setEmotion angry maps to Angry for VRM 0.0 model", () => {
		const vrm = createMockVrm00();
		const controller = createEmotionController(vrm as any);
		controller.setEmotion("angry");
		controller.update(0.5);
		expect(vrm._values.get("Angry")).toBeGreaterThan(0);
	});

	it("setEmotion surprised maps to Surprised for VRM 0.0 model", () => {
		const vrm = createMockVrm00();
		const controller = createEmotionController(vrm as any);
		controller.setEmotion("surprised");
		controller.update(0.5);
		expect(vrm._values.get("Surprised")).toBeGreaterThan(0);
	});

	it("setEmotion neutral maps to Neutral for VRM 0.0 model", () => {
		const vrm = createMockVrm00();
		const controller = createEmotionController(vrm as any);
		controller.setEmotion("neutral");
		controller.update(0.5);
		expect(vrm._values.get("Neutral")).toBeGreaterThan(0);
	});

	it("update transitions expressions over time", () => {
		const vrm = createMockVrm10();
		const controller = createEmotionController(vrm as any);
		controller.setEmotion("happy");

		// Small delta - partial transition
		controller.update(0.05);
		const partial = vrm._values.get("happy") ?? 0;
		expect(partial).toBeGreaterThan(0);
		expect(partial).toBeLessThan(1);

		// Large delta - complete transition
		controller.update(1.0);
		expect(vrm._values.get("happy")).toBe(1);
	});
});
