import { describe, expect, it, vi } from "vitest";
import { drawCelticCross, type TarotReading } from "../reading";
import { createTarotToolHandler } from "../tools";
function fixture() {
	let reading: TarotReading | null = null;
	const finish = vi.fn();
	const openStory = vi.fn(() => ({ chapter_title: "Chapter", page: 1 }));
	const readAloud = vi.fn(() => ({
		started: true,
		chapter_title: "Chapter",
		page: 1,
		total_pages: 2,
		chapter_end: false,
	}));
	const stopReading = vi.fn(() => ({ page: 1 }));
	const run = createTarotToolHandler({
		getReading: () => reading,
		startReading: (q, s) => {
			reading = drawCelticCross(q, () => 0, 1, s);
			return reading;
		},
		setReading: (r) => {
			reading = r;
		},
		finish,
		openStory,
		readAloud,
		stopReading,
		status: () => ({ screen: "table" }),
	});
	return { run, finish, openStory, readAloud, stopReading };
}
describe("Naia tarot actions", () => {
	it("starts Celtic, reveals ten cards one by one, retrieves and finishes", () => {
		const { run, finish } = fixture();
		expect(run({ action: "start_reading", question: " work " }).total).toBe(10);
		expect(() => run({ action: "finish" })).toThrow();
		for (let i = 1; i <= 10; i++) {
			const r = run({ action: "reveal_next" });
			expect(r.number).toBe(i);
			expect(r.total).toBe(10);
			expect(r.position_meaning).toBeTruthy();
			expect(r.meaning).toBeTruthy();
		}
		expect(run({ action: "get_reading" }).cards as unknown[]).toHaveLength(10);
		expect(run({ action: "finish" }).cards as unknown[]).toHaveLength(10);
		expect(finish).toHaveBeenCalledOnce();
		expect(() => run({ action: "reveal_next" })).toThrow();
	});
	it("requires a new concern before starting and hides every unrevealed card", () => {
		const f = fixture();
		expect(f.run({ action: "start_reading", question: "  " })).toMatchObject({
			need_question: true,
		});
		expect(() => f.run({ action: "get_reading" })).toThrow("No reading");
		f.run({ action: "start_reading", question: "work", spread: "three" });
		const first = f.run({ action: "reveal_next" });
		expect(first).toMatchObject({
			revealed: 1,
			remaining: 2,
			all_revealed: false,
			note: expect.stringContaining("Do not name"),
		});
		const result = f.run({ action: "get_reading" });
		expect(result).toMatchObject({
			incomplete: true,
			revealed: 1,
			remaining: 2,
		});
		expect(result.cards as unknown[]).toHaveLength(1);
		const second = f.run({ action: "reveal_next" });
		const third = f.run({ action: "reveal_next" });
		expect(JSON.stringify(result)).not.toContain(String(second.card));
		expect(JSON.stringify(result)).not.toContain(String(third.card));
		expect(third).toMatchObject({ remaining: 0, all_revealed: true });
		expect(f.run({ action: "get_reading" })).toMatchObject({
			all_revealed: true,
		});
	});
	it("supports three cards and story and reading actions", () => {
		const f = fixture();
		expect(
			f.run({ action: "start_reading", spread: "three", question: "work" })
				.total,
		).toBe(3);
		expect(
			f.run({ action: "open_story", card: "Star", part: 2 }).chapter_title,
		).toBe("Chapter");
		expect(f.openStory).toHaveBeenCalledWith("Star", 2);
		expect(f.run({ action: "read_aloud" })).toMatchObject({ started: true });
		expect(f.run({ action: "read_aloud" })).not.toHaveProperty("text");
		expect(f.run({ action: "stop_reading" }).page).toBe(1);
		expect(f.run({ action: "status" }).screen).toBe("table");
		expect(() => f.run({ action: "start_reading", spread: "wrong" })).toThrow();
	});
});
