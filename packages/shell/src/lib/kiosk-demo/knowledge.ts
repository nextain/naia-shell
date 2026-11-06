/** UC-KIOSK-KNOWLEDGE-S1: portable local compiler and desktop-compatible serving. */
import { Logger } from "../logger";
import {
	parseKnowledgeConfig,
	serializeKnowledgeConfig,
} from "../knowledge-config";
import type { WebFs } from "../web-runtime/web-fs";
import { webAdkOpfsPath } from "../web-runtime/web-adk-path";
import { isKioskDemo } from "./flag";
import { compile } from "./kb-compiler/core/compile";
import { KnowledgeService } from "./kb-compiler/core/serve";
import { IngestAdapter } from "./kb-compiler/adapters/ingest/text";
import { MarkdownExtractAdapter } from "./kb-compiler/adapters/extract/markdown";
import { Bm25RetrievalAdapter } from "./kb-compiler/adapters/retrieval/bm25";
import { MemoryStoreAdapter } from "./kb-compiler/adapters/store/memory";
import type { Kb } from "./kb-compiler/domain/types";
import kbRaw from "./knowledge/kb.json?raw";

export const KIOSK_SCOPE = "kiosk-demo";
export const KIOSK_SOURCE = "opfs://naia-adk/kiosk-demo/knowledge";
const manuscripts = import.meta.glob<string>("./knowledge/*.md", {
	eager: true,
	query: "?raw",
	import: "default",
});
const configPath = webAdkOpfsPath("naia-settings/knowledge.json");
export const kbPath = (scope: string) =>
	webAdkOpfsPath(`naia-settings/knowledge/${safeScope(scope)}/kb.json`);
export const KNOWLEDGE_COMMANDS = new Set([
	"compile_knowledge",
	"read_naia_knowledge_kb",
	"read_naia_knowledge_config",
	"write_naia_knowledge_config",
]);
export function safeScope(scope: string): string {
	if (!/^[a-zA-Z0-9_-]{1,80}$/.test(scope))
		throw new Error("invalid_knowledge_scope");
	return scope;
}

const SENSITIVE_KNOWLEDGE_PATTERN =
	/\x2fhome\x2f|\bmin\x68o\b|nextain\x2dadk|매\s*출|영업\s*이익|당기\s*순\s*이익|순\s*이익|밸류에이션|기업\s*가치|투자\s*(?:금|유치\s*금|유치\s*액|금액)|(?:지분(?:\s*율)?\s*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%\s*지분)|(?:(?:[₩$€¥]|USD|KRW)\s*\d)|(?:[일이삼사오육칠팔구십백천만억조]+\s*(?:원|달러|유로))|(?:\d[\d,.]*\s*(?:조|억|천만|백만|십만|만|천|백)?\s*(?:원|달러|USD|KRW|유로))|(?:[일이삼사오육칠팔구십백천]+\s*(?:조|억|천만|백만|십만)(?![가-힣]))|(?:\d[\d,.]*\s*(?:조|억|천만|백만|십만)(?![가-힣]))/iu;

export function assertPublicKnowledge(text: string): void {
	if (SENSITIVE_KNOWLEDGE_PATTERN.test(text)) {
		throw new Error("sensitive_knowledge_content");
	}
}

export interface KioskKnowledgeManuscript {
	name: string;
	uri: string;
	title: string;
	text: string;
}

export function listKioskKnowledgeManuscripts(): KioskKnowledgeManuscript[] {
	return Object.entries(manuscripts)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([path, text]) => {
			const name = path.split("/").pop()!;
			return {
				name,
				uri: `${KIOSK_SOURCE}/${name}`,
				title: text.match(/^# (.+)/m)?.[1] ?? name,
				text,
			};
		});
}

export async function compileKioskKnowledge() {
	Logger.debug("KioskKnowledge", "compile bundled public sources");
	const sources = listKioskKnowledgeManuscripts().map((item) => {
		assertPublicKnowledge(item.text);
		return {
			kind: "text" as const,
			uri: item.uri,
			title: item.title,
			text: item.text,
		};
	});
	const result = await compile(
		{ sources, safety: "block" },
		{
			ingest: new IngestAdapter(),
			extract: new MarkdownExtractAdapter(),
			retrieval: new Bm25RetrievalAdapter(),
			store: new MemoryStoreAdapter(),
		},
	);
	if (
		!result.safety ||
		result.safety.findings.length > 0 ||
		result.safety.piiCount > 0 ||
		result.safety.confidentialCount > 0
	) {
		throw new Error("sensitive_knowledge_content");
	}
	const json = JSON.stringify({ version: 1, kb: result.kb }, null, 2);
	assertPublicKnowledge(json);
	return { json, report: result.report, safety: result.safety };
}

export function parseKioskKb(raw: string): Kb {
	assertPublicKnowledge(raw);
	const parsed = JSON.parse(raw);
	if (
		parsed.version !== 1 ||
		!Array.isArray(parsed.kb?.cards) ||
		!Array.isArray(parsed.kb?.entities) ||
		!Array.isArray(parsed.kb?.relations)
	)
		throw new Error("invalid_knowledge_kb");
	return parsed.kb;
}
export async function kioskKnowledgeService(raw: string = kbRaw) {
	return KnowledgeService.create(parseKioskKb(raw), new Bm25RetrievalAdapter());
}

/** Idempotent per WebFs; failures remain retryable. OFF does not touch storage. */
const seeding = new WeakMap<WebFs, Promise<void>>();
export async function seedKioskKnowledge(fs: WebFs): Promise<void> {
	if (!isKioskDemo()) return;
	let pending = seeding.get(fs);
	if (!pending) {
		pending = (async () => {
			Logger.debug("KioskKnowledge", "seed public KB", { scope: KIOSK_SCOPE });
			parseKioskKb(kbRaw);
			for (const [path, text] of Object.entries(manuscripts)) {
				const sourcePath = webAdkOpfsPath(
					`kiosk-demo/knowledge/${path.split("/").pop()!}`,
				);
				if (!(await fs.readText(sourcePath)))
					await fs.writeBytes(sourcePath, text);
			}
			if (!(await fs.readText(kbPath(KIOSK_SCOPE))))
				await fs.writeBytes(kbPath(KIOSK_SCOPE), kbRaw);
			if (!(await fs.readText(configPath)))
				await fs.writeBytes(
					configPath,
					serializeKnowledgeConfig({
						version: 1,
						scope: KIOSK_SCOPE,
						sources: [
							{ path: KIOSK_SOURCE, label: "넥스테인·나이아 공개 지식" },
						],
					}),
				);
		})();
		seeding.set(fs, pending);
		pending.catch(() => seeding.delete(fs));
	}
	await pending;
}

export async function handleKioskKnowledgeCommand(
	cmd: string,
	args: unknown,
	fs: WebFs,
): Promise<unknown> {
	if (!isKioskDemo() || !KNOWLEDGE_COMMANDS.has(cmd))
		throw new Error(`desktop_only:${cmd}`);
	await seedKioskKnowledge(fs);
	const data = (args ?? {}) as { json?: string; scope?: string };
	Logger.debug("KioskKnowledge", "command", { cmd });
	if (cmd === "read_naia_knowledge_config") return fs.readText(configPath);
	if (cmd === "write_naia_knowledge_config") {
		if (typeof data.json !== "string")
			throw new Error("invalid_knowledge_config");
		const input = JSON.parse(data.json);
		if (
			input?.version !== 1 ||
			typeof input.scope !== "string" ||
			!Array.isArray(input.sources)
		)
			throw new Error("invalid_knowledge_config");
		const config = parseKnowledgeConfig(data.json);
		safeScope(config.scope);
		if (config.sources.some((s) => s.path !== KIOSK_SOURCE))
			throw new Error("kiosk_knowledge_bundled_sources_only");
		await fs.writeBytes(configPath, serializeKnowledgeConfig(config));
		return null;
	}
	const config = parseKnowledgeConfig(await fs.readText(configPath));
	if (cmd === "read_naia_knowledge_kb")
		return (await fs.readText(kbPath(data.scope ?? config.scope))) ?? "";
	if (config.sources.length !== 1 || config.sources[0].path !== KIOSK_SOURCE)
		throw new Error("kiosk_knowledge_bundled_sources_only");
	const { json, report } = await compileKioskKnowledge();
	await fs.writeBytes(kbPath(config.scope), json);
	return { ok: true, scope: config.scope, ...report };
}

/** Worker refresh uses the same OPFS config/KB as commands. */
export async function readKioskKnowledgeService(fs: WebFs) {
	await seedKioskKnowledge(fs);
	const config = parseKnowledgeConfig(await fs.readText(configPath));
	const raw = await fs.readText(kbPath(config.scope));
	return raw ? kioskKnowledgeService(raw) : null;
}
