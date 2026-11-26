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
import KIOSK_AGENTS_MD from "./workspace/harness.md?raw";
import KIOSK_RULES_MD from "./workspace/response-rules.md?raw";

export { KIOSK_AGENTS_MD, KIOSK_RULES_MD };

export const KIOSK_SCOPE = "nextain-public";
/** 번들 원고 사본. 점으로 시작하는 폴더라 탐색기에는 보이지 않는다(보이는 사본은 naia-adk/knowledge). */
const KIOSK_SOURCE_DIR = ".bundle/knowledge";
export const KIOSK_SOURCE = `opfs://naia-adk/${KIOSK_SOURCE_DIR}`;
/** 12판까지 쓰던 이름. 이미 방문한 브라우저의 OPFS 를 옮길 때만 쓴다. */
const LEGACY_SCOPE = "kiosk-demo";
const LEGACY_DIR = "kiosk-demo";
const LEGACY_SOURCE = `opfs://naia-adk/${LEGACY_DIR}/knowledge`;
/** 12판 knowledge/web.md 에서 바뀐 문장(옛 글 → 새 글). 방문자가 고친 다른 부분은 건드리지 않는다. */
const LEGACY_MANUSCRIPT_TEXT: Record<string, readonly [string, string][]> = {
	"web.md": [
		["이번 IR 키오스크는 웹판에서", "이번 IR 시연은 웹판에서"],
		[
			"시연 화면의 기능은 이 키오스크 범위와 연결된 것부터 안내합니다.",
			"시연 화면의 기능은 이번 시연 범위에 든 것부터 안내합니다.",
		],
	],
};
export const KIOSK_ADK_KNOWLEDGE_DIR = "opfs://naia-adk/knowledge";

/** 10판까지 OPFS 에 심은 AGENTS.md(웹판 능력 안내 없음). 이 글 그대로일 때만 새 지침으로 바꾼다. */
const KIOSK_AGENTS_MD_R10 = KIOSK_AGENTS_MD.slice(
	0,
	KIOSK_AGENTS_MD.indexOf("\n## 4. 웹판에서 할 수 있는 일과 없는 일"),
);

const manuscripts = import.meta.glob<string>("./knowledge/*.md", {
	eager: true,
	query: "?raw",
	import: "default",
});

// Upgrade only the untouched bundled web manuscript and its compiled card.
const R13_OLD_WEB = "# 웹판 브라우저 입구\n\n설치 없이 웹에서 쓸 수 있나요라는 질문에 답하면, 웹판은 가벼운 사용자가 **설치 없이 브라우저에서 시작**하는 기본 입구이며 웹판과 이번 시연의 지원 범위를 구분해 안내합니다. 휴대폰 화면 배치와 파일 탐색기, 기억 내보내기 등이 개발되었습니다. 2026년 11월 기준 웹판 0.2.5는 핵심 기능 개발을 마치고 공개 전 마무리 단계입니다. 이번 IR 시연은 웹판에서 시연 전용 계정과 준비된 회사 지식을 사용하는 구성입니다. 일반 서비스 전체의 공개 출시나 모든 데스크톱 명령 지원을 뜻하지 않습니다. 시연 화면의 기능은 이번 시연 범위에 든 것부터 안내합니다.\n";
async function upgradeBundledWebKnowledge(fs: WebFs): Promise<void> {
 const updated = manuscripts["./knowledge/web.md"];
 for (const path of [webAdkOpfsPath(`${KIOSK_SOURCE_DIR}/web.md`), webAdkOpfsPath("knowledge/web.md")]) {
  if ((await fs.readText(path))?.trim() === R13_OLD_WEB.trim()) await fs.writeBytes(path, updated);
 }
 const path = kbPath(KIOSK_SCOPE);
 const raw = await fs.readText(path);
 if (!raw) return;
 try {
  const current = JSON.parse(raw);
  const fresh = JSON.parse(kbRaw);
  const card = current.kb?.cards?.find((item: { sourceUris?: string[] }) => item.sourceUris?.some((uri) => uri.endsWith("/web.md")));
  const replacement = fresh.kb?.cards?.find((item: { sourceUris?: string[] }) => item.sourceUris?.some((uri) => uri.endsWith("/web.md")));
  if (card?.fields?.content === R13_OLD_WEB.split("\n").slice(1).join("\n").trim() && replacement) {
   card.fields = replacement.fields;
   await fs.writeBytes(path, JSON.stringify(current, null, 2));
  }
 } catch { /* Leave custom or invalid data untouched. */ }
}

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

/**
 * 12판까지 방문한 브라우저의 OPFS 를 새 이름으로 옮긴다. 옮길 것이 없으면 아무것도 쓰지 않으므로
 * 사실상 한 번만 돈다. 어느 단계가 실패해도 시연은 떠야 하므로 던지지 않는다.
 */
export async function migrateLegacyKioskKnowledge(fs: WebFs): Promise<void> {
	const step = async (name: string, run: () => Promise<void>) => {
		try {
			await run();
		} catch (error) {
			Logger.warn("KioskKnowledge", "legacy migration step failed", {
				name,
				error: String(error),
			});
		}
	};
	await step("config", async () => {
		const raw = await fs.readText(configPath);
		if (!raw) return;
		const config = parseKnowledgeConfig(raw);
		const scope = config.scope === LEGACY_SCOPE ? KIOSK_SCOPE : config.scope;
		const sources = config.sources.map((source) =>
			source.path === LEGACY_SOURCE
				? { ...source, path: KIOSK_SOURCE }
				: source,
		);
		const moved =
			scope !== config.scope ||
			sources.some((source, index) => source !== config.sources[index]);
		if (moved) {
			await fs.writeBytes(
				configPath,
				serializeKnowledgeConfig({ ...config, scope, sources }),
			);
		}
		// 옛 출처 경로가 적힌 카드는 번들 KB 로 바꾼다. 카드는 번들 원고에서만 만들어지므로 잃는 것이 없다.
		const kb = await fs.readText(kbPath(safeScope(scope)));
		if (kb?.includes(`${LEGACY_SOURCE}/`))
			await fs.writeBytes(kbPath(scope), kbRaw);
	});
	await step("manuscripts", async () => {
		for (const [fileName, pairs] of Object.entries(LEGACY_MANUSCRIPT_TEXT)) {
			const path = webAdkOpfsPath(`knowledge/${fileName}`);
			const text = await fs.readText(path);
			if (!text) continue;
			let next = text;
			for (const [before, after] of pairs)
				next = next.split(before).join(after);
			if (next !== text) await fs.writeBytes(path, next);
		}
	});
	await step("remove", async () => {
		for (const dir of [
			webAdkOpfsPath(LEGACY_DIR),
			webAdkOpfsPath(`naia-settings/knowledge/${LEGACY_SCOPE}`),
		]) {
			if (await fs.exists(dir)) await fs.removeDir?.(dir);
		}
	});
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
			await migrateLegacyKioskKnowledge(fs);
			await upgradeBundledWebKnowledge(fs);
			for (const [path, text] of Object.entries(manuscripts)) {
				const sourcePath = webAdkOpfsPath(
					`${KIOSK_SOURCE_DIR}/${path.split("/").pop()!}`,
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

/** 코드에 들어 있는 원본(AGENTS.md·rules·knowledge 원고). 번들 파일이면 null. */
export function getKioskBundledOriginalText(rel: string): string | null {
	if (rel === "AGENTS.md") return KIOSK_AGENTS_MD;
	if (rel === "rules/response-rules.md") return KIOSK_RULES_MD;
	const m = /^knowledge\/([^/]+\.md)$/.exec(rel);
	if (m) return manuscripts[`./knowledge/${m[1]}`] ?? null;
	return null;
}

/** 방문 초기화용: 손님이 고쳤을 수 있는 코드 원본 파일을 모두 원본으로 덮어쓴다. */
export async function writeKioskBundledOriginals(fs: WebFs): Promise<void> {
	await fs.writeBytes(webAdkOpfsPath("AGENTS.md"), KIOSK_AGENTS_MD);
	await fs.writeBytes(webAdkOpfsPath("rules/response-rules.md"), KIOSK_RULES_MD);
	for (const [path, text] of Object.entries(manuscripts)) {
		await fs.writeBytes(webAdkOpfsPath(`knowledge/${path.split("/").pop()}`), text);
	}
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

			const agentsPath = webAdkOpfsPath("AGENTS.md");
			const existingAgents = await fs.readText(agentsPath);
			if (
				!existingAgents ||
				existingAgents.includes("**근거와 기준일**을 보존하고") ||
				existingAgents.includes("## 1. 지나가 누구인가") ||
				existingAgents.includes("skill_memory_save") ||
				existingAgents === KIOSK_AGENTS_MD_R10
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
