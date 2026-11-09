import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryWebFs, setWebFsForTests } from "../web-runtime/web-fs";
import { parseKbStats } from "../knowledge-config";
import { Bm25RetrievalAdapter } from "./kb-compiler/adapters/retrieval/bm25";
import { SafetyBlockedError, applySafety } from "./kb-compiler/core/safety";
import { coverage, stem } from "./kb-compiler/core/text";
import { verify } from "./kb-compiler/core/verify";
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
	parseKioskKb,
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

function collectFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) out.push(...collectFiles(full));
		else if (/\.(?:js|mjs|cjs|json|html|css|md|txt)$/i.test(entry)) out.push(full);
	}
	return out;
}

describe("UC-KIOSK-KNOWLEDGE-S1", () => {
	it("locally compiles the reviewed manuscript reproducibly with safety:block", async () => {
		const result = await compileKioskKnowledge();
		if (process.env.UPDATE_KIOSK_KB === "1")
			writeFileSync("src/lib/kiosk-demo/knowledge/kb.json", result.json + "\n");
		else expect(JSON.parse(result.json)).toEqual(JSON.parse(bundled));
		expect(result.report.cardCount).toBe(21);
		expect(result.safety.mode).toBe("block");
		expect(result.safety.findings).toEqual([]);
		expect(result.safety.piiCount).toBe(0);
		expect(result.safety.confidentialCount).toBe(0);
		expect(() =>
			applySafety([{ id: "leak.md", text: "이 문서는 대외비 내부자료입니다." }], "block"),
		).toThrow(SafetyBlockedError);
	});
	it("rejects sensitive financial content, Korean amounts, equity %, valuation and internal paths", () => {
		assertPublicKnowledge(bundled);
		for (const bad of [
			"매출",
			"영업이익",
			"영업 이익",
			"순이익",
			"당기순이익",
			"밸류에이션",
			"기업가치",
			"기업 가치",
			"투자금",
			"투자 유치금",
			"지분 10%",
			"15.5% 지분",
			"지분율 20%",
			"오십억",
			"백억",
			"삼천만",
			"3천만",
			"USD 100",
			"오천만원",
			"1억원",
			"4,000만 원",
			"20 달러",
			"$300",
			"3억",
			"/home/nextain/work",
			"minho",
			"nextain-adk",
		])
			expect(() => assertPublicKnowledge(bad), `expected ${bad} to throw`).toThrow();
		expect(() =>
			assertPublicKnowledge("다운로드 1,749건, 커뮤니티 85명, 1인 창업자"),
		).not.toThrow();
	});
	it("contains no internal file paths or developer identifiers in bundled knowledge or dist output", () => {
		const knowledgeFiles = collectFiles("src/lib/kiosk-demo/knowledge");
		expect(knowledgeFiles.length).toBeGreaterThanOrEqual(21);
		for (const file of knowledgeFiles) {
			const text = readFileSync(file, "utf8");
			for (const token of ["/home/", "minho", "nextain-adk"]) {
				expect(text.toLowerCase().includes(token), `${file} contained ${token}`).toBe(
					false,
				);
			}
		}
		for (const file of [
			...collectFiles("dist"),
			...collectFiles("dist-web"),
		]) {
			const text = readFileSync(file, "utf8");
			const sanitized = text
				.replaceAll('"/home/web_user"', "")
				.replaceAll("naia-jina-minho-war-room-uhd.webp", "")
				.replaceAll('"minho-anime"', "")
				.replaceAll('"minho"', "")
				.replace(/caminho/gi, "");
			for (const token of ["/home/", "minho", "nextain-adk"]) {
				expect(
					sanitized.includes(token),
					`${file} contained forbidden token ${token}`,
				).toBe(false);
			}
		}
	});
	it("verifies all 22 eval-questions against expectedPoints via verify()", async () => {
		const kb = parseKioskKb(bundled);
		const goldQA = questions.map((q) => ({
			q: q.question,
			a: q.expectedPoints.join(" "),
		}));
		const verified = await verify(kb, goldQA, new Bm25RetrievalAdapter());
		expect(verified.gaps).toEqual([]);
		expect(verified.acceptedCardIds).toHaveLength(21);
		expect(verified.score).toBe(1);
	});
	it("answers basic Naia definition queries with naia.md paragraph without abstaining", async () => {
		expect(stem("나이아란")).toBe("나이아");
		expect(stem("사람이란")).toBe("사람");
		expect(stem("계란")).toBe("계란");
		expect(stem("이란")).toBe("이란");
		const service = await kioskKnowledgeService();
		const naiaText = readFileSync(
			"src/lib/kiosk-demo/knowledge/naia.md",
			"utf8",
		);
		for (const q of [
			"나이아는 어떤 서비스인가요?",
			"나이아란?",
			"나이아는 어떤 서비스인가요? 한두 문장으로 알려 주세요.",
		]) {
			const asked = await service.ask(q);
			expect(asked.abstained).toBe(false);
			expect(asked.sources[0]?.sourceUris).toContain(
				`${KIOSK_SOURCE}/naia.md`,
			);
			expect(naiaText).toContain(asked.answer);
			expect(asked.answer).toContain(
				"개인이 일하고 노는 환경에서 듣고 말하고 기억하는 AI 에이전트",
			);
		}
	});
	it.each(questions)(
		"retrieves and answers expectedPoints: $id — $question",
		async ({ question, expectedPoints, source }) => {
			const service = await kioskKnowledgeService();
			const hits = await service.search(question, 5);
			expect(
				hits.some((hit) =>
					hit.sourceUris.includes(`${KIOSK_SOURCE}/${source}`),
				),
			).toBe(true);
			for (const hit of hits) assertPublicKnowledge(hit.snippet);
			const asked = await service.ask(question);
			expect(asked.abstained).toBe(false);
			expect(
				asked.sources.some((s) =>
					s.sourceUris.includes(`${KIOSK_SOURCE}/${source}`),
				),
			).toBe(true);
			for (const point of expectedPoints) {
				expect(
					coverage(point, asked.answer),
					`expected answer "${asked.answer}" to cover "${point}"`,
				).toBeGreaterThanOrEqual(0.6);
			}
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
			21,
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
		expect(parseKbStats(await fs.readText(kbPath("other")))?.cards).toBe(21);
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
		expect(write).toHaveBeenCalledTimes(24);
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
		).toBe(21);
	});
});
