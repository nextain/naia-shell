/** 지식 소스 관리 — 순수 로직(영속화·폴더 다이얼로그·invoke 는 KnowledgeSettingsTab).
 *
 *  설정 정본 = `naia-settings/knowledge.json`(셸 전용 write, 에이전트 읽기전용 — FR-KB-OS.9).
 *  kb 정본 = `knowledge/<scope>/kb.json`(naia-adk, kb-compiler `{version:1,kb}` envelope).
 *  본 모듈은 Tauri 비의존(순수) → vitest 단위 검증 대상. FR-KB-OS.5~7.
 */

export interface KnowledgeSource {
	/** 자료 폴더 경로. */
	path: string;
	/** 표시용 라벨(미설정 시 경로 basename). */
	label?: string;
}

export interface KnowledgeConfig {
	version: number;
	/** 지식 스코프(프로젝트). kb 정본 = `knowledge/<scope>/kb.json`. */
	scope: string;
	sources: KnowledgeSource[];
}

export const KNOWLEDGE_CONFIG_VERSION = 1;
export const DEFAULT_KNOWLEDGE_SCOPE = "default";

export function emptyKnowledgeConfig(): KnowledgeConfig {
	return {
		version: KNOWLEDGE_CONFIG_VERSION,
		scope: DEFAULT_KNOWLEDGE_SCOPE,
		sources: [],
	};
}

/** 경로 정규화 — dedup 키. 역슬래시→슬래시, 말미 슬래시 제거(루트 제외), trim.
 *  대소문자는 보존(리눅스 대소문자 구분 파일시스템 호환). */
export function normalizeSourcePath(p: string): string {
	const trimmed = (p ?? "").trim().replace(/\\/g, "/");
	if (trimmed.length > 1) return trimmed.replace(/\/+$/, "");
	return trimmed;
}

/** 표시 라벨 — label 우선, 없으면 경로 마지막 세그먼트. */
export function sourceLabel(src: KnowledgeSource): string {
	if (src.label && src.label.trim()) return src.label.trim();
	const norm = normalizeSourcePath(src.path);
	const seg = norm.split("/").filter(Boolean);
	return seg.length ? seg[seg.length - 1] : norm;
}

/** 관대한 파서 — 빈/깨진 JSON = 기본 config(throw 안 함, UI 무붕괴). 로드 중 dedup. */
export function parseKnowledgeConfig(
	json: string | null | undefined,
): KnowledgeConfig {
	if (!json || !json.trim()) return emptyKnowledgeConfig();
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return emptyKnowledgeConfig();
	}
	if (!parsed || typeof parsed !== "object") return emptyKnowledgeConfig();
	const obj = parsed as Record<string, unknown>;
	const scope =
		typeof obj.scope === "string" && obj.scope.trim()
			? obj.scope.trim()
			: DEFAULT_KNOWLEDGE_SCOPE;
	const rawSources = Array.isArray(obj.sources) ? obj.sources : [];
	const sources: KnowledgeSource[] = [];
	const seen = new Set<string>();
	for (const s of rawSources) {
		if (!s || typeof s !== "object") continue;
		const rec = s as Record<string, unknown>;
		const path = typeof rec.path === "string" ? rec.path : "";
		const norm = normalizeSourcePath(path);
		if (!norm || seen.has(norm)) continue;
		seen.add(norm);
		const label = typeof rec.label === "string" ? rec.label : undefined;
		sources.push(label ? { path, label } : { path });
	}
	return { version: KNOWLEDGE_CONFIG_VERSION, scope, sources };
}

export function serializeKnowledgeConfig(cfg: KnowledgeConfig): string {
	return JSON.stringify(
		{
			version: KNOWLEDGE_CONFIG_VERSION,
			scope: cfg.scope || DEFAULT_KNOWLEDGE_SCOPE,
			sources: cfg.sources,
		},
		null,
		2,
	);
}

/** 폴더 추가 — 정규화 dedup(이미 있으면 무변, 같은 객체 반환). */
export function addSource(
	cfg: KnowledgeConfig,
	path: string,
	label?: string,
): KnowledgeConfig {
	const norm = normalizeSourcePath(path);
	if (!norm) return cfg;
	if (cfg.sources.some((s) => normalizeSourcePath(s.path) === norm)) return cfg;
	const next: KnowledgeSource =
		label && label.trim() ? { path, label: label.trim() } : { path };
	return { ...cfg, sources: [...cfg.sources, next] };
}

/** 폴더 제거 — 정규화 매칭. */
export function removeSource(
	cfg: KnowledgeConfig,
	path: string,
): KnowledgeConfig {
	const norm = normalizeSourcePath(path);
	return {
		...cfg,
		sources: cfg.sources.filter((s) => normalizeSourcePath(s.path) !== norm),
	};
}

// ── 컴파일 상태(kb.json envelope) ────────────────────────────────────────────

export interface KnowledgeKbStats {
	cards: number;
	entities: number;
	relations: number;
	/** status==="accepted" 카드 수(서빙 권장 단위). */
	accepted: number;
}

/** kb.json envelope(`{version,kb:{cards,entities,relations}}`) → 통계.
 *  부재/깨짐 = null(= "미컴파일"). kb-compiler WorkspaceStoreAdapter 와 동일 envelope. */
export function parseKbStats(
	json: string | null | undefined,
): KnowledgeKbStats | null {
	if (!json || !json.trim()) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	const kb = (parsed as { kb?: unknown } | null)?.kb as
		| { cards?: unknown; entities?: unknown; relations?: unknown }
		| undefined;
	if (
		!kb ||
		!Array.isArray(kb.cards) ||
		!Array.isArray(kb.entities) ||
		!Array.isArray(kb.relations)
	) {
		return null;
	}
	const accepted = (kb.cards as unknown[]).filter(
		(c) =>
			typeof c === "object" &&
			c !== null &&
			(c as { status?: string }).status === "accepted",
	).length;
	return {
		cards: kb.cards.length,
		entities: kb.entities.length,
		relations: kb.relations.length,
		accepted,
	};
}
