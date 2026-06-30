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

// ── K4: 설정 지식 탭 — 컴파일된 kb.json(envelope)에서 직접 그래프 데이터 생성.
//    셸은 kb-compiler 를 직접 호출 못 하므로 엔진 toGraphData(core/graph.ts)를 **의존성0으로 포팅**.
//    채팅 경로(parseKnowledgeGraph, 에이전트가 toGraphData 호출)와 동일 KnowledgeGraph 산출(동형).

/** 라벨 전파 군집 탐지(의존성0·결정론 — id 순서 고정 + 동률 시 작은 라벨 우선). 엔진 graph.ts 포팅. */
function detectCommunities(
	nodes: readonly { id: string }[],
	edges: readonly { from: string; to: string; weight: number }[],
	iters = 14,
): { comm: Map<string, number>; count: number } {
	const adj = new Map<string, [string, number][]>(nodes.map((n) => [n.id, []]));
	for (const e of edges) {
		if (!adj.has(e.from) || !adj.has(e.to)) continue;
		const w = e.weight || 1;
		(adj.get(e.from) as [string, number][]).push([e.to, w]);
		(adj.get(e.to) as [string, number][]).push([e.from, w]);
	}
	const order = nodes.map((n) => n.id);
	const label = new Map<string, string>(order.map((id) => [id, id]));
	for (let it = 0; it < iters; it++) {
		let changed = false;
		for (const id of order) {
			const nb = adj.get(id) as [string, number][];
			if (!nb.length) continue;
			const cnt = new Map<string, number>();
			for (const [to, w] of nb) {
				const l = label.get(to) as string;
				cnt.set(l, (cnt.get(l) ?? 0) + w);
			}
			let best = label.get(id) as string;
			let bv = -1;
			for (const [l, v] of cnt) {
				if (v > bv || (v === bv && l < best)) {
					bv = v;
					best = l;
				}
			}
			if (best !== label.get(id)) {
				label.set(id, best);
				changed = true;
			}
		}
		if (!changed) break;
	}
	const groups = new Map<string, string[]>();
	for (const id of order) {
		const l = label.get(id) as string;
		if (!groups.has(l)) groups.set(l, []);
		(groups.get(l) as string[]).push(id);
	}
	const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
	const comm = new Map<string, number>();
	sorted.forEach((ids, i) => ids.forEach((id) => comm.set(id, i)));
	return { comm, count: sorted.length };
}

/** kb.json envelope(`{version,kb:{entities,relations}}`) → 2D/3D 뷰어 입력 그래프.
 *  부재/깨짐/노드0 = null(그래프 섹션 미표시). 댕글링 관계(미존재 엔티티) 제외. */
export function graphFromKbJson(
	json: string | null | undefined,
): KnowledgeGraph | null {
	if (!json || !json.trim()) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	const kb = (parsed as { kb?: unknown } | null)?.kb as
		| {
				entities?: { id?: unknown; name?: unknown; type?: unknown }[];
				relations?: { from?: unknown; to?: unknown; type?: unknown; weight?: unknown }[];
		  }
		| undefined;
	if (!kb || !Array.isArray(kb.entities) || !Array.isArray(kb.relations)) return null;

	const deg = new Map<string, number>();
	const base: { id: string; label: string; type: string; deg: number }[] = [];
	for (const e of kb.entities) {
		if (!e || typeof e.id !== "string") continue;
		deg.set(e.id, 0);
		base.push({
			id: e.id,
			label: typeof e.name === "string" ? e.name : e.id,
			type: typeof e.type === "string" ? e.type : "",
			deg: 0,
		});
	}
	if (!base.length) return null;

	const edges: KnowledgeGraphEdge[] = [];
	for (const r of kb.relations) {
		if (!r || typeof r.from !== "string" || typeof r.to !== "string") continue;
		if (!deg.has(r.from) || !deg.has(r.to)) continue; // 양끝 엔티티 실재해야 엣지
		deg.set(r.from, (deg.get(r.from) ?? 0) + 1);
		deg.set(r.to, (deg.get(r.to) ?? 0) + 1);
		edges.push({
			from: r.from,
			to: r.to,
			type: typeof r.type === "string" ? r.type : "",
			weight: typeof r.weight === "number" ? r.weight : 1,
		});
	}

	const { comm, count } = detectCommunities(base, edges);
	const nodes: KnowledgeGraphNode[] = base.map((n) => ({
		...n,
		deg: deg.get(n.id) ?? 0,
		community: comm.get(n.id) ?? 0,
	}));
	return { nodes, edges, communityCount: count };
}
