import { describe, expect, it, vi } from "vitest";
import type { NvaManifest } from "../nva-core";
import {
	GestureTriggerStream,
	driveGestures,
	parseGestureTriggers,
} from "../nva-gesture-trigger";

const M: NvaManifest = {
	nva_version: "0.2",
	canvas: { width: 400, height: 700, fps: 25 },
	animations: {
		idle: { clip: "i.webm", loop: true, can_talk: false },
		speak: {
			clip: "s.webm",
			loop: true,
			can_talk: true,
			face_bbox: [0.2, 0.3, 0.4],
		},
		"gesture-1": {
			clip: "g1.webm",
			loop: false,
			can_talk: false,
			label: "물방울",
			intent: "playful",
			triggers: ["장난", "환기"],
		},
		"gesture-2": {
			clip: "g2.webm",
			loop: false,
			can_talk: false,
			label: "하트",
			intent: "affection",
			triggers: ["축하", "감사", "사랑"],
		},
	},
};

describe("parseGestureTriggers — LLM 마커 → gesture key", () => {
	it("key 마커", () => {
		const r = parseGestureTriggers("[[gesture:gesture-1]]", M);
		expect(r.gestures.map((g) => g.key)).toEqual(["gesture-1"]);
		expect(r.cleanText).toBe("");
	});
	it("label 마커 + 텍스트 정리", () => {
		const r = parseGestureTriggers("안녕 [[gesture:하트]] 반가워", M);
		expect(r.gestures.map((g) => g.key)).toEqual(["gesture-2"]);
		expect(r.cleanText).toBe("안녕 반가워"); // 마커 제거 + 연속 공백 축약
	});
	it("짧은 alias [[g:...]]", () => {
		expect(parseGestureTriggers("[[g:물방울]]", M).gestures[0]?.key).toBe(
			"gesture-1",
		);
	});
	it("triggers[] 매칭", () => {
		expect(parseGestureTriggers("[[gesture:축하]]", M).gestures[0]?.key).toBe(
			"gesture-2",
		);
	});
	it("intent 매칭 + 대소문자 무시", () => {
		expect(
			parseGestureTriggers("[[gesture:AFFECTION]]", M).gestures[0]?.key,
		).toBe("gesture-2");
	});
	it("미해석 마커 = 트리거 안 함 + 텍스트에서 제거", () => {
		const r = parseGestureTriggers("전 [[gesture:xyz]] 후", M);
		expect(r.gestures).toEqual([]);
		expect(r.cleanText).toBe("전 후");
	});
	it("비-gesture 애니(idle/speak)는 트리거 안 함", () => {
		expect(parseGestureTriggers("[[gesture:idle]]", M).gestures).toEqual([]);
		expect(parseGestureTriggers("[[gesture:speak]]", M).gestures).toEqual([]);
	});
	it("복수 마커 = 등장 순서", () => {
		const r = parseGestureTriggers("A [[g:물방울]] B [[gesture:하트]] C", M);
		expect(r.gestures.map((g) => g.key)).toEqual(["gesture-1", "gesture-2"]);
		expect(r.cleanText).toBe("A B C");
	});
	it("악성 입력 방어: 마커 수 상한(16)", () => {
		const many = Array.from({ length: 30 }, () => "[[g:하트]]").join(" ");
		const r = parseGestureTriggers(many, M);
		expect(r.gestures.length).toBe(16); // 상한까지만 트리거
		expect(r.cleanText.includes("[[")).toBe(false); // 마커는 전부 제거
	});
	it("악성 입력 방어: 마커 값 길이 상한(64) 초과=미해석", () => {
		const long = `[[gesture:${"x".repeat(100)}]]`;
		const r = parseGestureTriggers(long, M);
		expect(r.gestures).toEqual([]);
		expect(r.cleanText).toBe("");
	});
	it("빈/무마커 텍스트", () => {
		expect(parseGestureTriggers("그냥 인사", M)).toEqual({
			cleanText: "그냥 인사",
			gestures: [],
		});
		expect(parseGestureTriggers("", M)).toEqual({
			cleanText: "",
			gestures: [],
		});
	});
});

describe("GestureTriggerStream — split response markers", () => {
	it("holds a marker across chunks and returns clean display/TTS text once complete", () => {
		const stream = new GestureTriggerStream([
			{ key: "wave", label: "Wave" },
		]);
		const first = stream.push("Hello [[ges");
		const second = stream.push("ture:wa");
		const third = stream.push("ve]] world");
		const tail = stream.flush();

		expect(first.cleanText).toBe("Hello");
		expect(second.cleanText).toBe("");
		expect(third.cleanText).toBe(" world");
		expect(third.gestures.map(({ key }) => key)).toEqual(["wave"]);
		expect(tail.cleanText).toBe("");
		expect([first.cleanText, second.cleanText, third.cleanText, tail.cleanText].join(""))
			.toBe("Hello world");
	});

	it("preserves an unfinished marker on flush and strips unknown complete markers", () => {
		const stream = new GestureTriggerStream([
			{ key: "wave", label: "Wave" },
		]);
		const first = stream.push("Keep this [[gesture:wave");
		const tail = stream.flush();
		const unknown = stream.push("No [[gesture:missing]] marker");

		expect(first.cleanText).toBe("Keep this");
		expect(tail.cleanText).toBe(" [[gesture:wave");
		expect(unknown.cleanText).toBe("No marker");
		expect(unknown.gestures).toEqual([]);
	});

	it("returns the preceding space and unfinished marker as ordinary text", () => {
		const stream = new GestureTriggerStream([
			{ key: "wave", label: "Wave" },
		]);
		expect(stream.push("Keep this [[gesture:wave").cleanText).toBe("Keep this");
		expect(stream.flush()).toEqual({
			cleanText: " [[gesture:wave",
			gestures: [],
		});
	});

	it("preserves a split opening bracket and its preceding space at end of response", () => {
		const stream = new GestureTriggerStream();
		expect(stream.push("Keep this [").cleanText).toBe("Keep this");
		expect(stream.flush()).toEqual({ cleanText: " [", gestures: [] });
	});

	it("releases an unfinished marker as soon as a newline makes it invalid", () => {
		const stream = new GestureTriggerStream([
			{ key: "wave", label: "Wave" },
		]);
		const chunk = "[[gesture:wave\n안녕하세요";
		expect(stream.push(chunk).cleanText).toBe(chunk);
		expect(stream.flush()).toEqual({ cleanText: "", gestures: [] });
	});

	it.each([
		"[[gestx",
		`[[gesture:${"x".repeat(65)}`,
	])("releases an incomplete candidate when its syntax or key length is invalid", (chunk) => {
		const stream = new GestureTriggerStream([
			{ key: "wave", label: "Wave" },
		]);
		expect(stream.push(chunk).cleanText).toBe(chunk);
		expect(stream.flush()).toEqual({ cleanText: "", gestures: [] });
	});

	it("preserves plain Markdown exactly across every two-chunk split and character chunks", () => {
		const source =
			"# Summary\n\n    const items = [1, 2];\n\n- first item\n- second item\n\nFinal line.\n";
		const splitAt = (position: number) => [
			source.slice(0, position),
			source.slice(position),
		];
		const chunkings = [
			...Array.from({ length: source.length + 1 }, (_, position) =>
				splitAt(position),
			),
			[...source],
			[
				source.slice(0, 9),
				source.slice(9, 25),
				source.slice(25, 46),
				source.slice(46),
			],
		];

		for (const chunks of chunkings) {
			const stream = new GestureTriggerStream([
				{ key: "wave", label: "Wave" },
			]);
			const received = chunks.map((chunk) => stream.push(chunk).cleanText).join("");
			expect(`${received}${stream.flush().cleanText}`).toBe(source);
		}
	});

	it("normalizes only horizontal whitespace beside a removed marker", () => {
		const stream = new GestureTriggerStream([
			{ key: "wave", label: "Wave" },
		]);
		const parsed = stream.push("안녕  [[gesture:wave]]   반가워");
		expect(`${parsed.cleanText}${stream.flush().cleanText}`).toBe("안녕 반가워");
	});

	it("preserves paragraph breaks when a marker is removed at the boundary", () => {
		const stream = new GestureTriggerStream([
			{ key: "wave", label: "Wave" },
		]);
		const source = "A\n[[gesture:wave]]\n\nB";
		const output = `${stream.push(source).cleanText}${stream.flush().cleanText}`;
		expect(output).toBe("A\n\n\nB");
	});
});

describe("driveGestures — 순차 트리거 + 예외 격리", () => {
	it("순서대로 player.gesture 호출", async () => {
		const calls: string[] = [];
		const player = { gesture: async (k: string) => void calls.push(k) };
		const fired = await driveGestures(player, [
			{ key: "gesture-1", matched: "물방울" },
			{ key: "gesture-2", matched: "하트" },
		]);
		expect(calls).toEqual(["gesture-1", "gesture-2"]);
		expect(fired).toBe(2);
	});
	it("gesture() throw 는 격리하고 계속", async () => {
		const player = {
			gesture: vi
				.fn()
				.mockRejectedValueOnce(new Error("unknown"))
				.mockResolvedValueOnce(undefined),
		};
		const fired = await driveGestures(player, [
			{ key: "bad", matched: "bad" },
			{ key: "gesture-2", matched: "하트" },
		]);
		expect(player.gesture).toHaveBeenCalledTimes(2); // 첫 실패에도 다음 진행
		expect(fired).toBe(1); // 성공 1건만 카운트
	});
});
