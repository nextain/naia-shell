/**
 * Latency test: direct Gemini API vs Gateway + mini mem0 run (10 facts)
 *
 * Run: pnpm exec tsx src/memory/benchmark/test-latency.ts
 */
import OpenAI from "openai";
import { Memory } from "mem0ai/oss";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "";
const GATEWAY_KEY = process.env.GATEWAY_MASTER_KEY ?? "";
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";
const MODEL_CHAT = "gemini-2.5-flash";
const MODEL_EMBED = "text-embedding-004";
const RUNS = 3;

const SAMPLE_PROMPT = [
	{ role: "system" as const, content: "You are a helpful assistant. Reply in JSON: {\"facts\": [\"fact1\", \"fact2\"]}" },
	{ role: "user" as const, content: "My name is Kim Haneul. I use Neovim and prefer dark mode. My cat is Mungchi." },
];

const SAMPLE_TEXT = "My name is Kim Haneul. I use Neovim and prefer dark mode. My cat is Mungchi.";

async function measureLatency(
	label: string,
	client: OpenAI,
	chatModel: string,
	embedModel: string,
	runs: number,
) {
	console.log(`\n[${label}]`);
	const chatTimes: number[] = [];
	const embedTimes: number[] = [];

	for (let i = 0; i < runs; i++) {
		// Chat
		let t = Date.now();
		try {
			await client.chat.completions.create({
				model: chatModel,
				messages: SAMPLE_PROMPT,
				response_format: { type: "json_object" },
			});
			const ms = Date.now() - t;
			chatTimes.push(ms);
			process.stdout.write(`  chat ${i+1}: ${ms}ms  `);
		} catch (e: any) {
			process.stdout.write(`  chat ${i+1}: ERR(${e.status})  `);
		}

		// Embed
		t = Date.now();
		try {
			await client.embeddings.create({ model: embedModel, input: SAMPLE_TEXT });
			const ms = Date.now() - t;
			embedTimes.push(ms);
			process.stdout.write(`embed ${i+1}: ${ms}ms\n`);
		} catch (e: any) {
			process.stdout.write(`embed ${i+1}: ERR(${e.status})\n`);
		}

		await new Promise(r => setTimeout(r, 1500));
	}

	const avg = (arr: number[]) => arr.length ? (arr.reduce((a,b) => a+b,0) / arr.length).toFixed(0) : "N/A";
	const min = (arr: number[]) => arr.length ? Math.min(...arr) : "N/A";
	const max = (arr: number[]) => arr.length ? Math.max(...arr) : "N/A";
	console.log(`  -> chat  avg=${avg(chatTimes)}ms min=${min(chatTimes)} max=${max(chatTimes)}`);
	console.log(`  -> embed avg=${avg(embedTimes)}ms min=${min(embedTimes)} max=${max(embedTimes)}`);
	return { chatAvg: Number(avg(chatTimes)), embedAvg: Number(avg(embedTimes)) };
}

async function measureMem0(label: string, mem0Config: any, facts: string[]) {
	console.log(`\n[mem0 mini-run: ${label}]`);
	const m = new Memory(mem0Config);
	const times: number[] = [];

	for (let i = 0; i < facts.length; i++) {
		const t = Date.now();
		try {
			await m.add([{ role: "user", content: facts[i] }], { userId: "test" });
			const ms = Date.now() - t;
			times.push(ms);
			console.log(`  F${String(i+1).padStart(2,'0')}: ${ms}ms`);
		} catch (e: any) {
			console.log(`  F${String(i+1).padStart(2,'0')}: ERR ${e.message?.slice(0,60)}`);
			times.push(0);
		}
		await new Promise(r => setTimeout(r, 1000));
	}

	const valid = times.filter(t => t > 0);
	const avg = valid.length ? (valid.reduce((a,b) => a+b,0) / valid.length).toFixed(0) : "N/A";
	console.log(`  -> avg per fact: ${avg}ms (${valid.length}/${facts.length} success)`);
	return Number(avg);
}

const MINI_FACTS = [
	"My name is Kim Haneul. I run a startup.",
	"I mainly code in TypeScript and Python.",
	"My cat's name is Mungchi. She hates summer heat.",
	"I use Neovim as my editor. Dark mode only.",
	"My girlfriend is Seoyeon. We met in college.",
	"I run Tuesday, Wednesday, Thursday mornings.",
	"Monthly retro on first Monday of each month.",
	"Office router is ASUS RT-AX88U.",
];  // using first 5 only

async function main() {
	console.log("=" .repeat(60));
	console.log(" Latency Test: Direct API vs Gateway + mem0 mini-run");
	console.log("=" .repeat(60));

	const useGateway = !!(GATEWAY_URL && GATEWAY_KEY);
	const useGemini = !!GEMINI_KEY;

	if (!useGemini && !useGateway) {
		console.error("Need GEMINI_API_KEY or GATEWAY_URL+GATEWAY_MASTER_KEY");
		process.exit(1);
	}

	let directResult: any = null;
	let gatewayResult: any = null;

	if (useGemini) {
		const direct = new OpenAI({ apiKey: GEMINI_KEY, baseURL: GEMINI_BASE });
		directResult = await measureLatency("Direct Gemini AI Studio", direct, MODEL_CHAT, MODEL_EMBED, RUNS);
		await new Promise(r => setTimeout(r, 3000));
	}

	if (useGateway) {
		const gw = new OpenAI({ apiKey: GATEWAY_KEY, baseURL: `${GATEWAY_URL}/v1/` });
		gatewayResult = await measureLatency("Gateway (Vertex AI)", gw, `vertexai:${MODEL_CHAT}`, `vertexai:${MODEL_EMBED}`, RUNS);
		await new Promise(r => setTimeout(r, 3000));
	}

	// mem0 mini-run with whichever backend is available
	const dbPath = `/tmp/latency-test-${Date.now()}`;
	const backendLabel = useGateway ? "gateway" : "direct";
	const mem0Config = useGateway ? {
		embedder: { provider: "openai", config: { apiKey: GATEWAY_KEY, baseURL: `${GATEWAY_URL}/v1/`, model: "vertexai:text-embedding-004" } },
		vectorStore: { provider: "memory", config: { collectionName: "test", dimension: 768, dbPath: `${dbPath}-vec.db` } },
		llm: { provider: "openai", config: { apiKey: GATEWAY_KEY, baseURL: `${GATEWAY_URL}/v1/`, model: "vertexai:gemini-2.5-flash" } },
		historyDbPath: `${dbPath}-hist.db`,
	} : {
		embedder: { provider: "openai", config: { apiKey: GEMINI_KEY, baseURL: GEMINI_BASE, model: MODEL_EMBED } },
		vectorStore: { provider: "memory", config: { collectionName: "test", dimension: 768, dbPath: `${dbPath}-vec.db` } },
		llm: { provider: "openai", config: { apiKey: GEMINI_KEY, baseURL: GEMINI_BASE, model: MODEL_CHAT } },
		historyDbPath: `${dbPath}-hist.db`,
	};

	const mem0Avg = await measureMem0(backendLabel, mem0Config, MINI_FACTS);

	console.log("\n" + "=" .repeat(60));
	console.log(" SUMMARY");
	console.log("=" .repeat(60));
	if (directResult) console.log(`Direct:  chat ${directResult.chatAvg}ms | embed ${directResult.embedAvg}ms`);
	if (gatewayResult) console.log(`Gateway: chat ${gatewayResult.chatAvg}ms | embed ${gatewayResult.embedAvg}ms`);
	console.log(`mem0 add() avg: ${mem0Avg}ms/fact (${backendLabel})`);
	console.log(`Extrapolated 1000 facts: ${(mem0Avg * 1000 / 60000).toFixed(1)} min`);
	console.log("=" .repeat(60));
}

main().catch(console.error);
