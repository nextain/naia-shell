/**
 * Test: json_object vs json_schema structured output speed comparison
 *
 * Compares mem0's two internal prompts (extract + update) using:
 *   A) response_format: { type: "json_object" }  — current mem0 behavior
 *   B) response_format: { type: "json_schema", json_schema: {...} } — structured output
 *
 * Run: pnpm exec tsx src/memory/benchmark/test-structured-output.ts
 */
import OpenAI from "openai";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "";
const GATEWAY_KEY = process.env.GATEWAY_MASTER_KEY ?? "";
const MODEL = "vertexai:gemini-2.5-flash";
const RUNS = 5; // runs per method per prompt

if (!GATEWAY_URL || !GATEWAY_KEY) {
	console.error("GATEWAY_URL and GATEWAY_MASTER_KEY required");
	process.exit(1);
}

const client = new OpenAI({
	apiKey: GATEWAY_KEY,
	baseURL: `${GATEWAY_URL}/v1/`,
});

// ─── Prompts (from mem0 internals) ───────────────────────────────────────────

const EXTRACT_SYSTEM = `You are a Personal Information Organizer, specialized in accurately storing facts, user memories, and preferences. Your primary role is to extract relevant pieces of information from conversations and organize them into distinct, manageable facts.

Return the facts in JSON format with a 'facts' key containing an array of strings.

Example:
Input: Hi, my name is John. I am a software engineer.
Output: {"facts": ["Name is John", "Is a Software engineer"]}

DO NOT RETURN ANYTHING ELSE OTHER THAN THE JSON FORMAT.`;

const EXTRACT_USER = `Input:
I use Neovim as my editor. I prefer dark mode and tab indentation. My cat's name is Mungchi.`;

const UPDATE_SYSTEM = `You are a smart memory manager which controls the memory of a system.
You can perform four operations: (1) add into the memory, (2) update the memory, (3) delete from the memory, and (4) no change.

Compare newly retrieved facts with the existing memory. For each new fact, decide whether to:
- ADD: Add it to the memory as a new element
- UPDATE: Update an existing memory element
- DELETE: Delete an existing memory element
- NONE: Make no change

Return JSON format: {"memory": [{"id": "...", "text": "...", "event": "ADD|UPDATE|DELETE|NONE"}]}
DO NOT RETURN ANYTHING ELSE OTHER THAN THE JSON FORMAT.`;

const UPDATE_USER = `Existing memory:
[{"id": "0", "text": "Uses VS Code as editor"}, {"id": "1", "text": "Prefers light mode"}]

New facts: ["Uses Neovim as editor", "Prefers dark mode", "Cat named Mungchi"]`;

// ─── JSON Schemas ─────────────────────────────────────────────────────────────

const EXTRACT_SCHEMA = {
	name: "fact_extraction",
	strict: true,
	schema: {
		type: "object",
		properties: {
			facts: {
				type: "array",
				items: { type: "string" },
			},
		},
		required: ["facts"],
		additionalProperties: false,
	},
};

const UPDATE_SCHEMA = {
	name: "memory_update",
	strict: true,
	schema: {
		type: "object",
		properties: {
			memory: {
				type: "array",
				items: {
					type: "object",
					properties: {
						id: { type: "string" },
						text: { type: "string" },
						event: { type: "string", enum: ["ADD", "UPDATE", "DELETE", "NONE"] },
					},
					required: ["id", "text", "event"],
					additionalProperties: false,
				},
			},
		},
		required: ["memory"],
		additionalProperties: false,
	},
};

// ─── Benchmark runner ─────────────────────────────────────────────────────────

async function runTest(
	label: string,
	messages: OpenAI.ChatCompletionMessageParam[],
	responseFormat: any,
	runs: number,
): Promise<{ avgMs: number; errors: number; samples: number[] }> {
	const samples: number[] = [];
	let errors = 0;

	for (let i = 0; i < runs; i++) {
		const t0 = Date.now();
		try {
			const res = await client.chat.completions.create({
				model: MODEL,
				messages,
				response_format: responseFormat,
			});
			const elapsed = Date.now() - t0;
			samples.push(elapsed);
			const raw = res.choices[0]?.message?.content ?? "";
			// Strip markdown code blocks (model sometimes wraps response)
			const content = raw.replace(/^```[\w]*\n?/m, "").replace(/\n?```$/m, "").trim();
			// Verify parseable
			try {
				const parsed = JSON.parse(content);
				const keys = Object.keys(parsed).join(",");
				console.log(`  [${label}] run ${i + 1}: ${elapsed}ms ✅ keys=${keys}`);
			} catch {
				console.warn(`  [${label}] run ${i + 1}: ${elapsed}ms ⚠️  raw=${raw.slice(0, 80)}`);
				errors++;
			}
			console.log(`  [${label}] run ${i + 1}: ${elapsed}ms`);
		} catch (err: any) {
			const elapsed = Date.now() - t0;
			console.warn(`  [${label}] run ${i + 1}: ERROR ${err.message} (${elapsed}ms)`);
			errors++;
			samples.push(elapsed);
		}
		// 1s gap between runs to avoid burst throttle
		if (i < runs - 1) await new Promise((r) => setTimeout(r, 1000));
	}

	const avgMs = samples.reduce((a, b) => a + b, 0) / samples.length;
	return { avgMs, errors, samples };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	console.log(`\n${'='.repeat(60)}`);
	console.log(` json_object vs json_schema — Gemini 2.5 Flash via Gateway`);
	console.log(` Model: ${MODEL} | Runs: ${RUNS} each`);
	console.log('='.repeat(60));

	// ── Test 1: Extract prompt ──────────────────────────────────────
	console.log("\n[EXTRACT PROMPT]");

	const extractMsgs: OpenAI.ChatCompletionMessageParam[] = [
		{ role: "system", content: EXTRACT_SYSTEM },
		{ role: "user", content: EXTRACT_USER },
	];

	console.log("\n  Method A: json_object (current mem0 behavior)");
	const extractA = await runTest(
		"json_object",
		extractMsgs,
		{ type: "json_object" },
		RUNS,
	);

	await new Promise((r) => setTimeout(r, 2000));

	console.log("\n  Method B: json_schema (structured output)");
	const extractB = await runTest(
		"json_schema",
		extractMsgs,
		{ type: "json_schema", json_schema: EXTRACT_SCHEMA },
		RUNS,
	);

	// ── Test 2: Update prompt ───────────────────────────────────────
	console.log("\n[UPDATE PROMPT]");

	const updateMsgs: OpenAI.ChatCompletionMessageParam[] = [
		{ role: "system", content: UPDATE_SYSTEM },
		{ role: "user", content: UPDATE_USER },
	];

	await new Promise((r) => setTimeout(r, 2000));

	console.log("\n  Method A: json_object");
	const updateA = await runTest(
		"json_object",
		updateMsgs,
		{ type: "json_object" },
		RUNS,
	);

	await new Promise((r) => setTimeout(r, 2000));

	console.log("\n  Method B: json_schema");
	const updateB = await runTest(
		"json_schema",
		updateMsgs,
		{ type: "json_schema", json_schema: UPDATE_SCHEMA },
		RUNS,
	);

	// ── Results ─────────────────────────────────────────────────────
	console.log(`\n${'='.repeat(60)}`);
	console.log(" RESULTS");
	console.log('='.repeat(60));
	console.log(`\nExtract prompt:`);
	console.log(`  json_object : avg ${extractA.avgMs.toFixed(0)}ms | errors: ${extractA.errors}/${RUNS}`);
	console.log(`  json_schema : avg ${extractB.avgMs.toFixed(0)}ms | errors: ${extractB.errors}/${RUNS}`);
	const extractSpeedup = extractA.avgMs / extractB.avgMs;
	console.log(`  Speedup     : ${extractSpeedup.toFixed(2)}x ${extractSpeedup > 1 ? '(schema faster)' : '(object faster)'}`);

	console.log(`\nUpdate prompt:`);
	console.log(`  json_object : avg ${updateA.avgMs.toFixed(0)}ms | errors: ${updateA.errors}/${RUNS}`);
	console.log(`  json_schema : avg ${updateB.avgMs.toFixed(0)}ms | errors: ${updateB.errors}/${RUNS}`);
	const updateSpeedup = updateA.avgMs / updateB.avgMs;
	console.log(`  Speedup     : ${updateSpeedup.toFixed(2)}x ${updateSpeedup > 1 ? '(schema faster)' : '(object faster)'}`);

	console.log(`\nTotal per mem0 add() call:`);
	console.log(`  json_object : ~${(extractA.avgMs + updateA.avgMs).toFixed(0)}ms`);
	console.log(`  json_schema : ~${(extractB.avgMs + updateB.avgMs).toFixed(0)}ms`);
	const totalSpeedup = (extractA.avgMs + updateA.avgMs) / (extractB.avgMs + updateB.avgMs);
	console.log(`  Total speedup: ${totalSpeedup.toFixed(2)}x`);
	console.log('='.repeat(60));
}

main().catch(console.error);
