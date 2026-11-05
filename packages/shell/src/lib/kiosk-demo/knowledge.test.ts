import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { createMemoryWebFs, setWebFsForTests } from "../web-runtime/web-fs";
import { parseKbStats } from "../knowledge-config";
import questions from "./knowledge/eval-questions.json";
import bundled from "./knowledge/kb.json?raw";
import {
	assertPublicKnowledge,
	compileKioskKnowledge,
	handleKioskKnowledgeCommand,
	kioskKnowledgeService,
	kbPath,
	KIOSK_SCOPE,
	KIOSK_SOURCE,
	seedKioskKnowledge,
} from "./knowledge";

const on = () => {
	vi.stubEnv("MODE", "web");
	vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
};
afterEach(() => {
	vi.unstubAllEnvs();
	setWebFsForTests(null);
});

describe("UC-KIOSK-KNOWLEDGE-S1", () => {
	it("locally compiles the reviewed manuscript reproducibly", async () => {
		const result = await compileKioskKnowledge();
		if (process.env.UPDATE_KIOSK_KB === "1")
			writeFileSync("src/lib/kiosk-demo/knowledge/kb.json", result.json + "\n");
		else expect(JSON.parse(result.json)).toEqual(JSON.parse(bundled));
		expect(result.report.cardCount).toBe(20);
	});
	it("rejects sensitive financial content and accepts growth counts", () => {
		assertPublicKnowledge(bundled);
		for (const bad of [
			"매출",
			"영업이익",
			"영업 이익",
			"USD 100",
			"오천만원",
			"1억원",
			"4,000만 원",
			"20 달러",
			"$300",
			"3억",
		])
			expect(() => assertPublicKnowledge(bad)).toThrow();
		expect(() =>
			assertPublicKnowledge("다운로드 1,749건, 커뮤니티 85명"),
		).not.toThrow();
	});
	it.each(questions)(
		"retrieves evidence: $id — $question",
		async ({ question, source }) => {
			const service = await kioskKnowledgeService();
			const hits = await service.search(question, 5);
			expect(
				hits.some((hit) =>
					hit.sourceUris.includes(`${KIOSK_SOURCE}/${source}`),
				),
			).toBe(true);
			for (const hit of hits) assertPublicKnowledge(hit.snippet);
		},
	);
	it("abstains for unrelated queries and empty KB", async () => {
		expect(
			(await (await kioskKnowledgeService()).ask("양자색역학 뮤온 수명"))
				.abstained,
		).toBe(true);
		const empty = await kioskKnowledgeService(
			'{"version":1,"kb":{"cards":[],"entities":[],"relations":[]}}',
		);
		expect(await empty.search("나이아")).toEqual([]);
	});
	it("seeds once, persists config, compiles a selected scope and rejects traversal", async () => {
		on();
		const fs = createMemoryWebFs();
		await Promise.all([seedKioskKnowledge(fs), seedKioskKnowledge(fs)]);
		expect(parseKbStats(await fs.readText(kbPath(KIOSK_SCOPE)))?.cards).toBe(
			20,
		);
		const json = JSON.stringify({
			version: 1,
			scope: "other",
			sources: [{ path: KIOSK_SOURCE }],
		});
		await handleKioskKnowledgeCommand(
			"write_naia_knowledge_config",
			{ json },
			fs,
		);
		await handleKioskKnowledgeCommand("compile_knowledge", {}, fs);
		expect(parseKbStats(await fs.readText(kbPath("other")))?.cards).toBe(20);
		await seedKioskKnowledge(fs);
		expect(
			JSON.parse(
				String(
					await handleKioskKnowledgeCommand(
						"read_naia_knowledge_config",
						{},
						fs,
					),
				),
			).scope,
		).toBe("other");
		await expect(
			handleKioskKnowledgeCommand(
				"read_naia_knowledge_kb",
				{ scope: "../secret" },
				fs,
			),
		).rejects.toThrow();
		await expect(
			handleKioskKnowledgeCommand(
				"write_naia_knowledge_config",
				{ json: '{"sources":[{"path":"/private"}]}' },
				fs,
			),
		).rejects.toThrow();
	});
	it("propagates storage errors and retries failed seeding", async () => {
		on();
		const fs = createMemoryWebFs();
		const write = vi
			.spyOn(fs, "writeBytes")
			.mockRejectedValueOnce(new Error("quota"));
		await expect(seedKioskKnowledge(fs)).rejects.toThrow("quota");
		await seedKioskKnowledge(fs);
		expect(write).toHaveBeenCalledTimes(23);
	});
	it("OFF preserves all four desktop-only commands and performs no writes", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		const fs = createMemoryWebFs();
		setWebFsForTests(fs);
		await seedKioskKnowledge(fs);
		const { routeCommand } = await import("../web-runtime/router");
		for (const cmd of [
			"compile_knowledge",
			"read_naia_knowledge_kb",
			"read_naia_knowledge_config",
			"write_naia_knowledge_config",
		])
			await expect(routeCommand(cmd)).rejects.toThrow(`desktop_only:${cmd}`);
		expect(fs.snapshot()).toEqual({});
	});
	it("ON routes the four commands to OPFS", async () => {
		on();
		const fs = createMemoryWebFs();
		setWebFsForTests(fs);
		const { routeCommand } = await import("../web-runtime/router");
		expect(
			parseKbStats(String(await routeCommand("read_naia_knowledge_kb")))?.cards,
		).toBe(20);
	});
});
