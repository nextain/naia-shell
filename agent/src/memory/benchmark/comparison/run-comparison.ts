import { execSync } from "node:child_process";
/**
 * Memory System Comparison Benchmark
 *
 * Runs the same 55 tests (fact-bank.json + query-templates.json) against
 * multiple memory systems and produces a side-by-side comparison.
 *
 * Usage:
 *   pnpm exec tsx src/memory/benchmark/comparison/run-comparison.ts [options]
 *
 * Options:
 *   --adapters=naia,mem0,letta,zep   (default: naia,mem0)
 *   --judge=claude-cli|keyword                (default: claude-cli)
 *   --runs=N                                  (runs per test, default: 1)
 *   --skip-encode                             (skip encoding, assume already done)
 *   --categories=recall,abstention,...         (filter categories)
 *
 * Requires: GEMINI_API_KEY env var
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LettaAdapter } from "./adapter-letta.js";
import { OpenClawAdapter } from "./adapter-openclaw.js";
import { StarnionAdapter } from "./adapter-starnion.js";
import { Mem0Adapter } from "./adapter-mem0.js";
import { type EmbeddingBackend, NaiaAdapter } from "./adapter-naia.js";
import { NoMemoryAdapter } from "./adapter-no-memory.js";
import { OpenLLMVTuberAdapter } from "./adapter-open-llm-vtuber.js";
import { SapAdapter } from "./adapter-sap.js";
import { SillyTavernAdapter } from "./adapter-sillytavern.js";
import { ZepAdapter } from "./adapter-zep.js";
import type {
	BenchmarkAdapter,
	ComparisonResult,
	TestDetail,
} from "./types.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";
const THROTTLE_MS = 2000;

// ─── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
	const args = process.argv.slice(2);
	let adapterNames = ["naia", "mem0"];
	let judge: "claude-cli" | "keyword" = "claude-cli";
	let runs = 1;
	let categories: string[] | null = null;
	let llm: "gemini" = "gemini";
	let skipEncode = false;
	let lang = "ko";
	let embedder = "gemini";

	for (const arg of args) {
		if (arg.startsWith("--adapters="))
			adapterNames = arg.split("=")[1].split(",");
		if (arg.startsWith("--judge=")) judge = arg.split("=")[1] as any;
		if (arg.startsWith("--runs="))
			runs = Number.parseInt(arg.split("=")[1], 10);
		if (arg.startsWith("--categories="))
			categories = arg.split("=")[1].split(",");
		// --llm option removed (gemini only)
		if (arg === "--skip-encode") skipEncode = true;
		if (arg.startsWith("--lang=")) lang = arg.split("=")[1];
		if (arg.startsWith("--embedder=")) embedder = arg.split("=")[1];
	}
	return { adapterNames, judge, runs, categories, llm, skipEncode, lang, embedder };
}

// ─── Adapter Factory ────────────────────────────────────────────────────────

function createAdapter(name: string, apiKey: string, embedder?: string): BenchmarkAdapter {
	switch (name) {
		case "naia":
			return new NaiaAdapter(apiKey, (embedder ?? "gemini") as EmbeddingBackend);
		case "mem0":
			return new Mem0Adapter(apiKey);
		case "letta":
			return new LettaAdapter();
		case "zep":
			return new ZepAdapter();
		case "openclaw":
			return new OpenClawAdapter();
		case "starnion":
			return new StarnionAdapter();
		case "sap":
			return new SapAdapter(apiKey);
		case "sillytavern":
			return new SillyTavernAdapter();
		case "airi":
			return new NoMemoryAdapter(
				"airi",
				"project-airi — memory WIP (stub), no search",
			);
		case "open-llm-vtuber":
			return new OpenLLMVTuberAdapter();
		default:
			throw new Error(`Unknown adapter: ${name}`);
	}
}

// ─── LLM Response Generation ────────────────────────────────────────────────


/**
 * Call Gemini via gateway (if GATEWAY_URL + GATEWAY_MASTER_KEY set) or direct API.
 * Gateway uses Vertex AI (higher quota), direct uses AI Studio.
 */
async function callGemini(
	apiKey: string,
	messages: Array<{ role: string; content: string }>,
	maxTokens: number,
): Promise<string> {
	const gwUrl = process.env.GATEWAY_URL;
	const gwKey = process.env.GATEWAY_MASTER_KEY;
	const useGateway = !!(gwUrl && gwKey);

	const url = useGateway
		? `${gwUrl}/v1/chat/completions`
		: `${GEMINI_BASE}chat/completions`;
	const authKey = useGateway ? gwKey : apiKey;
	const model = useGateway ? "vertexai:gemini-2.5-flash" : "gemini-2.5-flash";

	for (let attempt = 0; attempt < 3; attempt++) {
		await new Promise((r) => setTimeout(r, THROTTLE_MS));
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${authKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					messages,
					max_tokens: maxTokens,
					...(useGateway && { user: "benchmark" }),
				}),
			});
			if (!res.ok) {
				await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
				continue;
			}
			const data = (await res.json()) as any;
			const content = data.choices?.[0]?.message?.content ?? "";
			if (content.length > 0) return content;
		} catch {}
	}
	return "";
}

function callClaudeCli(prompt: string): string {
	try {
		return execSync("claude -p 2>/dev/null", {
			input: prompt,
			timeout: 60000,
			encoding: "utf-8",
		}).trim();
	} catch {
		return "";
	}
}

async function askWithMemory(
	apiKey: string,
	memories: string[],
	question: string,
): Promise<string> {
	const memCtx =
		memories.length > 0
			? `<recalled_memories>\n${memories.map((m) => `- ${m}`).join("\n")}\n</recalled_memories>`
			: "(관련 기억 없음)";

	const messages = [
		{
			role: "system",
			content: `You are the user's personal AI companion. Respond in the same language as the user's message.

## Rules
1. Only use memories that are **directly relevant** to the user's question. Ignore unrelated memories.
2. When the user asks for help, **don't ask back** — immediately apply their preferences and environment from memory.
3. If the user asks about a **specific personal fact** and no memory **directly matches**, you MUST reply "기억에 없습니다" or "I don't have that in my memory".
4. NEVER fabricate facts. Do NOT guess or infer from loosely related memories.
5. If multiple memories can be combined to answer, synthesize them.
6. For confirmation questions ("Did I say...?", "~했었지?"), if no memory directly matches, reply that you don't recall. Do NOT substitute with a different memory.

${memCtx}`,
		},
		{ role: "user", content: question },
	];

	return callGemini(apiKey, messages, 500);
}

// ─── Judge ───────────────────────────────────────────────────────────────────

interface JudgeResult {
	pass: boolean;
	reason: string;
}

function buildJudgePrompt(q: any, capName: string, response: string): string {
	if (capName === "abstention") {
		return `[채점] abstention (환각 방지)
질문: "${q.query || q.verify}"
AI 응답: "${response}"
이 질문은 사용자가 말한 적 없는 것에 대한 질문입니다. AI는 "기억에 없다/모르겠다"고 거절해야 합니다.
- 거절했으면 → PASS
- 없는 정보를 지어냈으면 → FAIL
첫 줄에 PASS 또는 FAIL, 둘째 줄에 이유 한 줄.`;
	}

	if (capName === "irrelevant_isolation") {
		const forbidden = (q.expected_not_contains ?? []).join(", ");
		return `[채점] irrelevant_isolation
질문: "${q.query}"
AI 응답: "${response}"
포함되면 안 되는 키워드: [${forbidden}]
일반 질문에 불필요하게 사용자 개인정보를 끼워넣으면 FAIL.
첫 줄에 PASS 또는 FAIL, 둘째 줄에 이유 한 줄.`;
	}

	if (q.expected_any) {
		const min = q.min_expected ?? 1;
		return `[채점] ${capName}
질문: "${q.query || q.verify}"
AI 응답: "${response}"
기대 키워드 중 ${min}개 이상: [${q.expected_any.join(", ")}]
AI 응답이 위 키워드 중 ${min}개 이상을 의미적으로 포함하면 PASS.
첫 줄에 PASS 또는 FAIL, 둘째 줄에 이유 한 줄.`;
	}

	if (q.expected_contains) {
		return `[채점] ${capName}
질문: "${q.query || q.verify}"
AI 응답: "${response}"
기대 키워드: [${q.expected_contains.join(", ")}]
${q.expected_not_contains?.length ? `금지 키워드: [${q.expected_not_contains.join(", ")}]` : ""}
${q.fail_signal?.length ? `FAIL 신호: [${q.fail_signal.join(", ")}]` : ""}
기대 키워드 중 하나라도 의미적으로 포함하면 PASS.
첫 줄에 PASS 또는 FAIL, 둘째 줄에 이유 한 줄.`;
	}

	return `[채점] ${capName}
질문: "${q.query || q.verify}"
AI 응답: "${response}"
적절히 답했으면 PASS, 아니면 FAIL.
첫 줄에 PASS 또는 FAIL, 둘째 줄에 이유 한 줄.`;
}

function parseVerdict(raw: string): JudgeResult {
	const first = raw.split("\n")[0].trim().toUpperCase();
	const pass = first === "PASS" || first.startsWith("PASS");
	return { pass, reason: raw.slice(0, 120) || "EMPTY" };
}

function keywordJudge(response: string, q: any, capName: string): JudgeResult {
	const lower = response.toLowerCase();
	if (capName === "abstention") {
		const refusals = [
			// Korean
			"말씀하신 적",
			"기억에 없",
			"모르",
			"없는 것 같",
			"언급하신 적",
			"기억이 없",
			"알 수 없",
			"말한 적",
			"정보가 없",
			"없습니다",
			"아닙니다",
			"죄송",
			// English
			"don't have",
			"don't recall",
			"no memory",
			"not in my memory",
			"no record",
			"don't remember",
			"i'm not aware",
			"haven't mentioned",
			"no information",
			"didn't mention",
			"not something",
		];
		return refusals.some((p) => lower.includes(p))
			? { pass: true, reason: "PASS(kw): refusal" }
			: { pass: false, reason: "FAIL(kw): no refusal" };
	}
	if (capName === "irrelevant_isolation") {
		const found = (q.expected_not_contains ?? []).filter((k: string) =>
			lower.includes(k.toLowerCase()),
		);
		return found.length > 0
			? { pass: false, reason: `FAIL(kw): forbidden [${found}]` }
			: { pass: true, reason: "PASS(kw)" };
	}
	if (q.expected_any) {
		const min = q.min_expected ?? 1;
		const found = q.expected_any.filter((k: string) =>
			lower.includes(k.toLowerCase()),
		);
		return found.length >= min
			? { pass: true, reason: `PASS(kw): [${found}]` }
			: {
					pass: false,
					reason: `FAIL(kw): ${found.length}/${q.expected_any.length}`,
				};
	}
	if (q.expected_contains) {
		const found = q.expected_contains.filter((k: string) =>
			lower.includes(k.toLowerCase()),
		);
		return found.length > 0
			? { pass: true, reason: `PASS(kw): [${found}]` }
			: { pass: false, reason: "FAIL(kw): none found" };
	}
	return { pass: false, reason: "NO_JUDGE" };
}

async function judgeResponse(
	apiKey: string,
	mode: string,
	q: any,
	capName: string,
	response: string,
): Promise<JudgeResult> {
	if (mode === "keyword") return keywordJudge(response, q, capName);

	// claude-cli batch judge
	const prompt = buildJudgePrompt(q, capName, response);
	const raw = callClaudeCli(prompt);
	if (!raw) return keywordJudge(response, q, capName); // fallback
	return parseVerdict(raw);
}

// ─── Cache path helpers ──────────────────────────────────────────────────────

/** Returns the vec DB path used to detect whether a cached encode exists. */
function getCacheVecPath(adapterName: string, cacheId: string): string {
	if (adapterName === "mem0") return `/tmp/mem0-bench-mem0-${cacheId}-vec.db`;
	if (adapterName === "sap") return `/tmp/sap-bench-chroma-${cacheId}`;
	if (adapterName === "sillytavern") return `/tmp/sillytavern-bench-${cacheId}`;
	// naia, naia-solar, naia-qwen3, naia-bge-m3
	return `/tmp/mem0-bench-${adapterName}-${cacheId}-vec.db`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	const config = parseArgs();

	const apiKey = process.env.GEMINI_API_KEY ?? "";
	const hasGateway = !!(process.env.GATEWAY_URL && process.env.GATEWAY_MASTER_KEY);
	const needsGemini =
		config.embedder === "gemini" || config.llm === "gemini";
	// Gateway (Vertex AI) can replace direct Gemini API key
	if (needsGemini && !apiKey && !hasGateway) {
		console.error(
			"GEMINI_API_KEY required (or set GATEWAY_URL + GATEWAY_MASTER_KEY to use gateway)",
		);
		process.exit(1);
	}
	console.log("\n╔══════════════════════════════════════════════════════════╗");
	console.log("║  MEMORY SYSTEM COMPARISON BENCHMARK                     ║");
	console.log(`║  Adapters: ${config.adapterNames.join(", ").padEnd(44)}║`);
	console.log(`║  Judge: ${config.judge.padEnd(47)}║`);
	console.log(`║  LLM: ${config.llm.padEnd(49)}║`);
	console.log(`║  Runs: ${String(config.runs).padEnd(48)}║`);
	console.log(`║  Lang: ${config.lang.padEnd(48)}║`);
	console.log(`║  Embedder: ${config.embedder.padEnd(44)}║`);
	if (config.skipEncode) console.log("║  ⚡ Skip-encode mode (using cached DB)              ║");
	console.log("╚══════════════════════════════════════════════════════════╝\n");

	const langSuffix = config.lang === "ko" ? "" : `.${config.lang}`;
	const factBankPath = join(import.meta.dirname, "..", `fact-bank${langSuffix}.json`);
	const templatesPath = join(import.meta.dirname, "..", `query-templates${langSuffix}.json`);
	const factBank = JSON.parse(readFileSync(factBankPath, "utf-8"));
	const templates = JSON.parse(readFileSync(templatesPath, "utf-8"));

	const allResults: ComparisonResult[] = [];

	for (const adapterName of config.adapterNames) {
		console.log(`\n${"═".repeat(60)}`);
		console.log(`  TESTING: ${adapterName}`);
		console.log(`${"═".repeat(60)}\n`);

		let adapter: BenchmarkAdapter;
		try {
			adapter = createAdapter(adapterName, apiKey, config.embedder);
		} catch (err: any) {
			console.error(`  ❌ Failed to create adapter: ${err.message}`);
			continue;
		}

		try {
			// Phase 1: Init + Encode
			// Always use fixed cacheId so DB persists across runs.
			const cacheId = `cache-${config.lang}`;
			const cacheVecPath = getCacheVecPath(adapter.name, cacheId);
			const cacheExists = existsSync(cacheVecPath);
			const skipEncode = config.skipEncode || cacheExists;
			await adapter.init(cacheId);

			if (skipEncode) {
				console.log(`  Phase 1: ⚡ SKIPPED (cached DB: ${cacheVecPath})\n`);
			} else {
				console.log("  Phase 1: Init + Encode\n");
				let stored = 0;
				let gated = 0;
				for (const fact of factBank.facts) {
					try {
						const ok = await adapter.addFact(fact.statement);
						if (ok) {
							stored++;
							console.log(
								`    ✅ ${fact.id}: ${fact.statement.slice(0, 50)}...`,
							);
						} else {
							gated++;
							console.log(`    ⛔ ${fact.id}: GATED`);
						}
					} catch (err: any) {
						console.log(`    ❌ ${fact.id}: ${err.message?.slice(0, 60)}`);
					}
				}
				console.log(
					`\n    Stored: ${stored}/${factBank.facts.length} (gated: ${gated})\n`,
				);
			}

			// Phase 2: Query + Respond + Judge
			console.log("  Phase 2: Query + Judge\n");
			const details: TestDetail[] = [];
			let testNum = 0;

			// Explicit execution order — do NOT rely on JSON key order.
			// Pre-update tests first, then contradiction (which mutates), then post-update tests.
			const CAPABILITY_ORDER = [
				"direct_recall",
				"semantic_search",
				"proactive_recall",
				"abstention",
				"irrelevant_isolation",
				"multi_fact_synthesis",
				"entity_disambiguation",
				// === Mutation boundary: updates/additions happen below ===
				"contradiction_direct",
				"contradiction_indirect",
				"noise_resilience",
				// === Post-mutation tests ===
				"unchanged_persistence",
				"temporal",
			];
			const capEntries = CAPABILITY_ORDER.filter(
				(name) => templates.capabilities[name],
			).map((name) => [name, templates.capabilities[name]] as [string, any]);

			// Warn about capabilities in templates but missing from CAPABILITY_ORDER
			const unordered = Object.keys(templates.capabilities).filter(
				(k) => !CAPABILITY_ORDER.includes(k),
			);
			if (unordered.length > 0) {
				console.warn(
					`    ⚠ Capabilities not in CAPABILITY_ORDER (will be skipped): ${unordered.join(", ")}`,
				);
			}

			for (const [capName, cap] of capEntries) {
				if (!cap.queries) continue;
				if (config.categories && !config.categories.includes(capName)) continue;

				const weight = cap.weight ?? 1;
				const isBonus = cap.is_bonus ?? false;
				console.log(
					`    ── ${capName} (w:${weight}${isBonus ? " bonus" : ""}) ──`,
				);

				for (const q of cap.queries) {
					testNum++;
					const id = `${capName.slice(0, 4).toUpperCase()}-${String(testNum).padStart(2, "0")}`;
					const query = q.query || q.verify || "";
					if (!query) continue;

					// Handle setup/update/noise — log failures + wait for indexing
					if (q.setup)
						try {
							await adapter.addFact(q.setup);
							await new Promise((r) => setTimeout(r, THROTTLE_MS));
						} catch (e: any) {
							console.error(`      ⚠ setup fail: ${e.message?.slice(0, 60)}`);
						}
					if (q.update)
						try {
							await adapter.addFact(q.update);
							await new Promise((r) => setTimeout(r, THROTTLE_MS));
						} catch (e: any) {
							console.error(`      ⚠ update fail: ${e.message?.slice(0, 60)}`);
						}
					if (q.noisy_input)
						try {
							await adapter.addFact(q.noisy_input);
							await new Promise((r) => setTimeout(r, THROTTLE_MS));
						} catch (e: any) {
							console.error(`      ⚠ noise fail: ${e.message?.slice(0, 60)}`);
						}

					// Search memories
					let memories: string[] = [];
					try {
						memories = await adapter.search(query, 10);
					} catch (err: any) {
						console.error(`      ⚠ search: ${err.message?.slice(0, 60)}`);
					}

					// Generate response with memories + Judge (multiple runs, majority vote)
					let passCount = 0;
					let lastResponse = "";
					let lastReason = "";

					for (let run = 0; run < config.runs; run++) {
						const response = await askWithMemory(apiKey, memories, query);
						lastResponse = response;
						const verdict = await judgeResponse(
							apiKey,
							config.judge,
							q,
							capName,
							response,
						);
						lastReason = verdict.reason;
						if (verdict.pass) passCount++;
					}

					const pass = passCount >= Math.ceil(config.runs / 2);
					const reason =
						config.runs > 1
							? `${passCount}/${config.runs} → ${pass ? "PASS" : "FAIL"} | ${lastReason.slice(0, 60)}`
							: lastReason;

					details.push({
						id,
						capability: capName,
						query,
						weight,
						isBonus,
						pass,
						reason,
						memories,
						response: lastResponse.slice(0, 400),
					});
					console.log(
						`      ${pass ? "✅" : "❌"} ${id} "${query.slice(0, 30)}..." [${memories.length} mem] ${reason.slice(0, 50)}`,
					);
				}
				console.log();
			}

			// Phase 3: Score (weighted)
			const core = details.filter((d) => !d.isBonus);
			const bonus = details.filter((d) => d.isBonus);
			// Weighted score: each test contributes its category weight
			const coreWeightedPass = core.reduce(
				(sum, d) => sum + (d.pass ? d.weight : 0),
				0,
			);
			const coreWeightedTotal = core.reduce(
				(sum, d) => sum + d.weight,
				0,
			);
			const corePassed = core.filter((d) => d.pass).length;
			const bonusPassed = bonus.filter((d) => d.pass).length;
			const coreRate =
				coreWeightedTotal > 0 ? coreWeightedPass / coreWeightedTotal : 0;
			const bonusRate = bonus.length > 0 ? bonusPassed / bonus.length : 0;
			const abstentionFail = details.some(
				(d) => d.capability === "abstention" && !d.pass,
			);

			let grade: string;
			const abstentionSuffix = abstentionFail ? " (-abstention)" : "";
			if (coreRate >= 0.95) grade = "S";
			else if (coreRate >= 0.85) grade = "A";
			else if (coreRate >= 0.75) grade = "B";
			else if (coreRate >= 0.5) grade = "C";
			else if (coreRate >= 0.4) grade = "D";
			else if (coreRate >= 0.3) grade = "E";
			else grade = "F";
			grade += abstentionSuffix;

			const byCapability: ComparisonResult["byCapability"] = {};
			for (const d of details) {
				if (!byCapability[d.capability])
					byCapability[d.capability] = {
						passed: 0,
						total: 0,
						weight: d.weight,
					};
				byCapability[d.capability].total++;
				if (d.pass) byCapability[d.capability].passed++;
			}

			allResults.push({
				adapter: adapter.name,
				description: adapter.description,
				core: { total: core.length, passed: corePassed, rate: coreRate },
				bonus: { total: bonus.length, passed: bonusPassed },
				grade,
				byCapability,
				details,
			});

			console.log(`    ─── ${adapter.name} Result ───`);
			console.log(
				`    Core: ${corePassed}/${core.length} items, weighted ${Math.round(coreRate * 100)}% (${coreWeightedPass}/${coreWeightedTotal} pts)`,
			);
			console.log(`    Bonus: ${bonusPassed}/${bonus.length}`);
			console.log(`    Grade: ${grade}\n`);
		} catch (err: any) {
			console.error(`  ❌ ${adapterName} failed: ${err.message}`);
			allResults.push({
				adapter: adapterName,
				description: `ERROR: ${err.message}`,
				core: { total: 0, passed: 0, rate: 0 },
				bonus: { total: 0, passed: 0 },
				grade: "ERROR",
				byCapability: {},
				details: [],
			});
		} finally {
			try {
				await adapter?.cleanup();
			} catch {}
		}
	}

	// ─── Final Comparison Report ─────────────────────────────────────────
	console.log(`\n${"═".repeat(70)}`);
	console.log("  COMPARISON SUMMARY");
	console.log(`${"═".repeat(70)}\n`);

	// Header
	const names = allResults.map((r) => r.adapter);
	console.log(
		`  ${"Category".padEnd(25)} ${names.map((n) => n.padStart(10)).join(" ")}`,
	);
	console.log(
		`  ${"─".repeat(25)} ${names.map(() => "─".repeat(10)).join(" ")}`,
	);

	// Collect all capability names
	const allCaps = new Set<string>();
	for (const r of allResults)
		for (const cap of Object.keys(r.byCapability)) allCaps.add(cap);

	for (const cap of allCaps) {
		const cells = allResults.map((r) => {
			const c = r.byCapability[cap];
			return c ? `${c.passed}/${c.total}` : "-";
		});
		console.log(
			`  ${cap.padEnd(25)} ${cells.map((c) => c.padStart(10)).join(" ")}`,
		);
	}

	console.log(
		`  ${"─".repeat(25)} ${names.map(() => "─".repeat(10)).join(" ")}`,
	);
	console.log(
		`  ${"CORE TOTAL".padEnd(25)} ${allResults.map((r) => `${r.core.passed}/${r.core.total}`.padStart(10)).join(" ")}`,
	);
	console.log(
		`  ${"CORE %".padEnd(25)} ${allResults.map((r) => `${Math.round(r.core.rate * 100)}%`.padStart(10)).join(" ")}`,
	);
	console.log(
		`  ${"GRADE".padEnd(25)} ${allResults.map((r) => r.grade.padStart(10)).join(" ")}`,
	);

	// Save report — per-adapter files to avoid overwrite in parallel runs
	const reportDir = join(import.meta.dirname, "../../../..", "reports");
	mkdirSync(reportDir, { recursive: true });
	const date = new Date().toISOString().slice(0, 10);

	// Save individual adapter reports
	for (const result of allResults) {
		const adapterPath = join(
			reportDir,
			`memory-comparison-${result.adapter}-${date}.json`,
		);
		writeFileSync(
			adapterPath,
			JSON.stringify(
				{
					timestamp: new Date().toISOString(),
					version: "comparison-v2",
					judge: config.judge,
					llm: config.llm,
					runs: config.runs,
					results: [result],
				},
				null,
				2,
			),
		);
		console.log(`  Report (${result.adapter}): ${adapterPath}`);
	}

	// Also save combined report
	const combinedPath = join(reportDir, `memory-comparison-${date}.json`);
	writeFileSync(
		combinedPath,
		JSON.stringify(
			{
				timestamp: new Date().toISOString(),
				version: "comparison-v2",
				judge: config.judge,
				llm: config.llm,
				runs: config.runs,
				results: allResults,
			},
			null,
			2,
		),
	);
	console.log(`  Report (combined): ${combinedPath}\n`);
}

main().catch(console.error);
