import { describe, expect, it, vi } from "vitest";
import { drawCelticCross } from "../reading";
import { createTarotToolHandler } from "../tools";

describe("Cafe Lua Tarot model tools", () => {
	it("starts a local spread, reveals one card, and reports only revealed cards", () => {
		let reading = null as ReturnType<typeof drawCelticCross> | null;
		const startReading = vi.fn((question: string) => {
			const next = drawCelticCross(question, () => 0, 50);
			reading = next;
			return next;
		});
		const onReveal = vi.fn();
		const run = createTarotToolHandler({
			getReading: () => reading,
			startReading,
			setReading: (next) => {
				reading = next;
			},
			onReveal,
		});

		const started = run({ action: "start_reading", question: "  Work  " });
		expect(started.status).toBe("started");
		expect(startReading).toHaveBeenCalledWith("Work");
		expect(started.reading?.cards as unknown[]).toHaveLength(0);
		expect(started.reading?.remaining).toBe(10);

		const revealed = run({ action: "reveal_next" });
		expect(revealed.status).toBe("revealed");
		expect(revealed.reading?.card).toBeTruthy();
		expect(revealed.reading?.keywords).toBeTruthy();
		expect(onReveal).toHaveBeenCalledOnce();
		expect(run({ action: "get_context" }).message).toBe(
			"1 of 10 cards revealed.",
		);
	});

	it("reports the empty and unsupported action states", () => {
		const run = createTarotToolHandler({
			getReading: () => null,
			startReading: () => drawCelticCross("", () => 0, 1),
			setReading: () => {},
		});
		expect(run({ action: "reveal_next" }).status).toBe("empty");
		expect(run({ action: "what" }).message).toMatch(/Unknown action/);
	});
});
