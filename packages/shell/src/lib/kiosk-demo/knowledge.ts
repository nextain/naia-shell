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
export const KIOSK_ADK_KNOWLEDGE_DIR = "opfs://naia-adk/knowledge";

export const KIOSK_AGENTS_MD = `# AGENTS.md — ADK 하네스 지침

이 \`AGENTS.md\`는 화면에 보여 주기 위한 꾸밈 글이 아니라, 매 대화 턴마다 에이전트 워커가 실제로 읽어 시스템 지침으로 결합하는 하네스 정본(Single Source of Truth)입니다.

## 1. 캐릭터 정체성 (페르소나)

지금 캐릭터는 페르소나 설정(캐릭터 카드)을 따른다.

## 2. 무엇을 읽고 대답하는가 (참조 경로)

대답을 만들 때 아래 ADK 작업 공간 파일들과 페르소나 설정(캐릭터 카드)을 실제로 읽고 결합합니다:

- \`AGENTS.md\`: 하네스 최상위 지침 (역할·참조 경로·응답 원칙)
- 페르소나 설정(캐릭터 카드): 지금 적용된 캐릭터의 이름·소개·성격·상황·첫 인사·예시 대화·로어북
- \`memory/guest-memory.md\`: 이번 방문에서 기억한 사실과 최근 대화 흐름
- \`knowledge/*.md\`: 넥스테인·나이아·성장·제품·가능성에 관한 공개 지식 원고 카드 (21종)
- \`rules/response-rules.md\`: 근거 보존·기준일 명시·비공개 추측 금지 규칙

## 3. 어떤 규칙으로 대답하는가 (응답 원칙)

1. 넥스테인·나이아·성장·제품·가능성 질문에는 \`skill_knowledge_search\` 또는 \`skill_knowledge_ask\` 도구로 \`knowledge/*.md\` 공개 지식을 먼저 확인합니다.
2. 대답할 때 참고한 지식 원고의 **기준일**을 보존하되 대답 글에 파일 이름·근거 줄을 쓰지 않고, 계획은 확정 사실이 아닌 계획으로 구분해 설명합니다.
3. 공개 지식 원고에 없는 수치나 비공개 내부 정보는 추측하지 않고 공개 가능한 범위만 정직하게 안내합니다.
4. 음성 합성(TTS)으로 자연스럽게 읽히도록 핵심부터 또렷하고 간결한 한국어 문장으로 답합니다.
`;

export const KIOSK_RULES_MD = `# 대답 및 근거 규칙 (Response Rules)

1. **공개 지식 우선 확인**: 넥스테인·나이아·제품·기술·비전 질문에는 반드시 \`knowledge/*.md\` 공개 지식 원고를 먼저 조회합니다.
2. **근거·기준일 보존**: 지식 카드에 적힌 기준일은 보존하되, 대답 글에 파일 이름·근거 줄을 쓰지 않습니다.
3. **계획과 사실 구분**: 로드맵·향후 일정은 현재 완료된 사실과 구분하여 계획으로 안내합니다.
4. **비공개 정보 추측 금지**: 원고에 없는 내부 수치·열쇠·비공개 주소는 추측하거나 만들어 내지 않습니다.
`;

export const KIOSK_INITIAL_MEMORY_MD = `# 게스트 기억 (Guest Memory)

## 기억된 사실 (Facts)
- 사용자 호칭은 게스트님이다.

## 최근 대화 (Episodes)
- 아직 기록된 대화가 없습니다.
`;
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

const adkSeeding = new WeakMap<WebFs, Promise<void>>();
export const seedKioskAdkWorkspace = async (
	fs: WebFs,
	opts?: { overwriteMemory?: boolean },
): Promise<void> => {
	if (!isKioskDemo()) return;
	let pending = adkSeeding.get(fs);
	if (!pending || opts?.overwriteMemory) {
		pending = (async () => {
			assertPublicKnowledge(KIOSK_AGENTS_MD);
			assertPublicKnowledge(KIOSK_RULES_MD);
			assertPublicKnowledge(KIOSK_INITIAL_MEMORY_MD);

			const agentsPath = webAdkOpfsPath("AGENTS.md");
			const existingAgents = await fs.readText(agentsPath);
			if (
				!existingAgents ||
				existingAgents.includes("**근거와 기준일**을 보존하고") ||
				existingAgents.includes("## 1. 지나가 누구인가")
			) {
				await fs.writeBytes(agentsPath, KIOSK_AGENTS_MD);
			}
			const rulesPath = webAdkOpfsPath("rules/response-rules.md");
			const existingRules = await fs.readText(rulesPath);
			if (
				!existingRules ||
				existingRules.includes("출처(`knowledge/*.md`)를 대답 근거로 남깁니다")
			) {
				await fs.writeBytes(rulesPath, KIOSK_RULES_MD);
			}
			const memoryPath = webAdkOpfsPath("memory/guest-memory.md");
			const existingMemory = await fs.readText(memoryPath);
			if (
				opts?.overwriteMemory ||
				!existingMemory ||
				existingMemory.includes("- [kiosk-guest]")
			) {
				await fs.writeBytes(memoryPath, KIOSK_INITIAL_MEMORY_MD);
			}
			for (const [path, text] of Object.entries(manuscripts)) {
				const fileName = path.split("/").pop()!;
				const adkDocPath = webAdkOpfsPath(`knowledge/${fileName}`);
				if (!(await fs.readText(adkDocPath))) {
					await fs.writeBytes(adkDocPath, text);
				}
			}
		})();
		adkSeeding.set(fs, pending);
		pending.catch(() => adkSeeding.delete(fs));
	}
	await pending;
};

/** Worker refresh uses the same OPFS config/KB as commands and syncs naia-adk/knowledge/*.md edits. */
export async function readKioskKnowledgeService(fs: WebFs) {
	await seedKioskKnowledge(fs);
	await seedKioskAdkWorkspace(fs);
	const config = parseKnowledgeConfig(await fs.readText(configPath));
	let raw = await fs.readText(kbPath(config.scope));
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed?.kb?.cards)) {
				let updated = false;
				for (const card of parsed.kb.cards) {
					const uri =
						typeof card?.source?.uri === "string" ? card.source.uri : "";
					const fileName = uri.split("/").pop();
					if (fileName && fileName.endsWith(".md")) {
						const adkText = await fs.readText(
							webAdkOpfsPath(`knowledge/${fileName}`),
						);
						const bundled = manuscripts[`./knowledge/${fileName}`];
						if (adkText && bundled && adkText.trim() !== bundled.trim()) {
							const stripped = adkText
								.replace(/^---[\s\S]*?---\n?/, "")
								.replace(/^#\s+.+\n?/, "")
								.trim();
							if (stripped && card.summary !== stripped) {
								card.summary = stripped;
								updated = true;
							}
						}
					}
				}
				if (updated) {
					raw = JSON.stringify(parsed);
				}
			}
		} catch {
			// keep original raw
		}
	}
	return raw ? kioskKnowledgeService(raw) : null;
}
