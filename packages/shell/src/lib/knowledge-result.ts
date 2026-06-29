// knowledge-result — 지식 도구(skill_knowledge_ask/search) tool-result(JSON 문자열) 파싱 + 출처 분류(순수 로직).
// naia-agent knowledge-skill 어댑터가 output=JSON 으로 내보낸 것을 UI(KnowledgeToolResult)가 칩으로 렌더하기 전 해석.
// 출처(sourceUris)는 "근거→원문" 키 — URL 이면 브라우저, 워크스페이스 경로면 파일뷰어로 연다(분류만 여기, 실행은 컴포넌트).

export interface KnowledgeSource {
	title: string;
	sourceUris: string[];
}
export interface KnowledgeHit {
	title: string;
	snippet: string;
	score: number;
	sourceUris: string[];
}
export interface ParsedKnowledgeAsk {
	kind: "ask";
	abstained: boolean;
	answer: string;
	sources: KnowledgeSource[];
}
export interface ParsedKnowledgeSearch {
	kind: "search";
	hits: KnowledgeHit[];
}
export type ParsedKnowledge = ParsedKnowledgeAsk | ParsedKnowledgeSearch;

export const KNOWLEDGE_TOOL_NAMES = ["skill_knowledge_ask", "skill_knowledge_search"] as const;
export function isKnowledgeTool(toolName: string): boolean {
	return toolName === "skill_knowledge_ask" || toolName === "skill_knowledge_search";
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function parseSources(v: unknown): KnowledgeSource[] | null {
	if (!Array.isArray(v)) return null;
	const out: KnowledgeSource[] = [];
	for (const s of v) {
		if (!isObj(s) || typeof s.title !== "string" || !isStrArr(s.sourceUris)) return null;
		out.push({ title: s.title, sourceUris: s.sourceUris });
	}
	return out;
}

/**
 * 지식 도구 tool-result(JSON 문자열) → 구조화. 형태 불일치/파싱실패 = null(호출부가 기본 렌더로 폴백).
 * ask: {abstained, answer, sources:[{title, sourceUris}]} / search: {hits:[{title, snippet, score, sourceUris}]}
 */
export function parseKnowledgeResult(toolName: string, output: string | undefined): ParsedKnowledge | null {
	if (!output || !isKnowledgeTool(toolName)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(output);
	} catch {
		return null;
	}
	if (!isObj(raw)) return null;

	if (toolName === "skill_knowledge_ask") {
		const sources = parseSources(raw.sources);
		if (typeof raw.answer !== "string" || typeof raw.abstained !== "boolean" || sources === null) return null;
		return { kind: "ask", abstained: raw.abstained, answer: raw.answer, sources };
	}
	// skill_knowledge_search
	if (!Array.isArray(raw.hits)) return null;
	const hits: KnowledgeHit[] = [];
	for (const h of raw.hits) {
		if (!isObj(h) || typeof h.title !== "string" || typeof h.snippet !== "string" || typeof h.score !== "number" || !isStrArr(h.sourceUris)) return null;
		hits.push({ title: h.title, snippet: h.snippet, score: h.score, sourceUris: h.sourceUris });
	}
	return { kind: "search", hits };
}

export type SourceKind = "url" | "file";
/** 출처 URI 분류 — http(s) = 브라우저, 그 외(절대경로/file:) = 워크스페이스 파일뷰어. */
export function classifySourceUri(uri: string): SourceKind {
	return /^https?:\/\//i.test(uri) ? "url" : "file";
}
/** file:// 접두 제거 등 워크스페이스 openFile 이 받을 경로로 정규화. */
export function toFilePath(uri: string): string {
	return uri.replace(/^file:\/\//i, "");
}

// ── K3: 지식 그래프 데이터(skill_knowledge_graph tool-result) 파싱 — 2D/3D 뷰어 입력 ──
export interface KnowledgeGraphNode { id: string; label: string; type: string; deg: number; community: number; }
export interface KnowledgeGraphEdge { from: string; to: string; type: string; weight: number; }
export interface KnowledgeGraph { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[]; communityCount: number; }

export function isKnowledgeGraphTool(toolName: string): boolean {
	return toolName === "skill_knowledge_graph";
}

/** skill_knowledge_graph tool-result(JSON) → 그래프 데이터. 형태 불일치/파싱실패 = null(기본 렌더 폴백). */
export function parseKnowledgeGraph(toolName: string, output: string | undefined): KnowledgeGraph | null {
	if (!output || !isKnowledgeGraphTool(toolName)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(output);
	} catch {
		return null;
	}
	if (!isObj(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
	const nodes: KnowledgeGraphNode[] = [];
	for (const n of raw.nodes) {
		if (!isObj(n) || typeof n.id !== "string" || typeof n.label !== "string") return null;
		nodes.push({
			id: n.id,
			label: n.label,
			type: typeof n.type === "string" ? n.type : "",
			deg: typeof n.deg === "number" ? n.deg : 0,
			community: typeof n.community === "number" ? n.community : 0,
		});
	}
	const edges: KnowledgeGraphEdge[] = [];
	for (const e of raw.edges) {
		if (!isObj(e) || typeof e.from !== "string" || typeof e.to !== "string") return null;
		edges.push({
			from: e.from,
			to: e.to,
			type: typeof e.type === "string" ? e.type : "",
			weight: typeof e.weight === "number" ? e.weight : 1,
		});
	}
	return { nodes, edges, communityCount: typeof raw.communityCount === "number" ? raw.communityCount : 0 };
}

// 군집 색 팔레트(examples/cms graph-common.js 동일 — 어두운 배경 대비 밝은 톤).
export const COMMUNITY_PALETTE = [
	"#4c8bf5", "#3fb950", "#a371f7", "#f778ba", "#e5984d", "#56d4dd", "#f5d44c", "#ff6b6b",
	"#9b8cff", "#4dd4ac", "#d98cff", "#ff9f5a", "#73c2ff", "#bce04f", "#ff7eb6", "#7ee0d0",
];
export function communityColor(i: number): string {
	const n = COMMUNITY_PALETTE.length;
	return COMMUNITY_PALETTE[((i % n) + n) % n];
}
