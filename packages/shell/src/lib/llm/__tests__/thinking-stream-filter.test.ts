import { describe, expect, it } from "vitest";
import { ThinkingStreamFilter } from "../thinking-stream-filter";

function collect(chunks: string[]) {
	const filter = new ThinkingStreamFilter();
	let visible = "";
	let thinking = "";
	for (const chunk of chunks) {
		const output = filter.push(chunk);
		visible += output.visible;
		thinking += output.thinking;
	}
	const tail = filter.flush();
	return {
		visible: visible + tail.visible,
		thinking: thinking + tail.thinking,
	};
}

describe("ThinkingStreamFilter", () => {
	it("separates a complete think block from the final answer", () => {
		expect(collect(["<think>private reasoning</think>Final answer."])).toEqual({
			visible: "Final answer.",
			thinking: "private reasoning",
		});
	});

	it("separates tags split at every possible stream boundary", () => {
		const source = "<think>reasoning</think>Final";
		for (let boundary = 1; boundary < source.length; boundary += 1) {
			expect(
				collect([source.slice(0, boundary), source.slice(boundary)]),
			).toEqual({ visible: "Final", thinking: "reasoning" });
		}
	});

	it("preserves visible text before and after a tagged block", () => {
		expect(collect(["Before <THINK>secret</ThInK> after"])).toEqual({
			visible: "Before  after",
			thinking: "secret",
		});
	});

	it("keeps an unclosed think block out of the visible response", () => {
		expect(collect(["<thi", "nk>unfinished"])).toEqual({
			visible: "",
			thinking: "unfinished",
		});
	});

	it("does not reinterpret the avatar expression tag as reasoning", () => {
		expect(collect(["[THINK] This remains a final answer."])).toEqual({
			visible: "[THINK] This remains a final answer.",
			thinking: "",
		});
	});

	it("separates paired bracket reasoning while preserving the final answer", () => {
		expect(
			collect(["[THI", "NK]private chain</thi", "nk>public answer"]),
		).toEqual({
			visible: "public answer",
			thinking: "private chain",
		});
	});

	it("can be reset between requests without leaking parser state", () => {
		const filter = new ThinkingStreamFilter();
		filter.push("<think>old");
		filter.reset();
		expect(filter.push("new answer")).toEqual({
			visible: "new answer",
			thinking: "",
		});
		expect(filter.flush()).toEqual({ visible: "", thinking: "" });
	});

	it("WO13D-F1 whitespace-not-candidate", () => {
		const filter = new ThinkingStreamFilter();
		expect(filter.push("\n\n")).toEqual({ visible: "\n\n", thinking: "" });
		expect(filter.push("답")).toEqual({ visible: "답", thinking: "" });
		expect(filter.flush()).toEqual({ visible: "", thinking: "" });
	});

	it("WO13D-F2 streams-after-leading-blank", () => {
		const filter = new ThinkingStreamFilter();
		expect(filter.push("\n\n").visible).toBe("\n\n");
		expect(filter.push("안녕").visible).toBe("안녕");
		expect(filter.push("하세요").visible).toBe("하세요");
	});

	it("WO13D-F3 split-bracket-after-blank", () => {
		expect(collect(["\n\n", "[TH", "INK]x</think>답"])).toEqual({
			visible: "\n\n답",
			thinking: "x",
		});
	});

	it("WO13D-F4 empty-push", () => {
		const filter = new ThinkingStreamFilter();
		expect(filter.push("")).toEqual({ visible: "", thinking: "" });
		expect(filter.push("답")).toEqual({ visible: "답", thinking: "" });
	});
});
