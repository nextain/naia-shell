/**
 * Tool permission tiers.
 * Tier 0: auto-execute (read-only)
 * Tier 1: approval needed (notice level)
 * Tier 2: approval needed (caution level)
 * Tier 3: blocked (handled by tool-bridge BLOCKED_PATTERNS)
 */

/** Dynamic overrides registered by panel tools (e.g. skill_browser_*). */
const DYNAMIC_TIERS: Record<string, number> = {};

/** Register a runtime tier for a panel tool. Call when panel skills arrive. */
export function setToolTier(toolName: string, tier: number): void {
	DYNAMIC_TIERS[toolName] = tier;
}

const TOOL_TIERS: Record<string, number> = {
	read_file: 0,
	search_files: 0,
	write_file: 1,
	apply_diff: 1,
	browser: 0,
	web_search: 1,
	sessions_spawn: 1,
	execute_command: 2,
	skill_sessions: 0,
	skill_time: 0,
	skill_system_status: 0,
	skill_weather: 1,
	skill_memo: 1,
	skill_cron: 1,
	skill_naia_discord: 1,
};

export function getToolTier(toolName: string): number {
	// Dynamic overrides (panel tools) take precedence
	if (toolName in DYNAMIC_TIERS) return DYNAMIC_TIERS[toolName];
	return TOOL_TIERS[toolName] ?? 2;
}

export function needsApproval(toolName: string): boolean {
	return getToolTier(toolName) > 0;
}

const TOOL_DESCRIPTIONS: Record<
	string,
	(args: Record<string, unknown>) => string
> = {
	execute_command: (args) => `명령 실행: ${args.command ?? ""}`,
	write_file: (args) => `파일 쓰기: ${args.path ?? ""}`,
	web_search: (args) => `웹 검색: ${args.query ?? ""}`,
	read_file: (args) => `파일 읽기: ${args.path ?? ""}`,
	search_files: (args) => `파일 검색: ${args.pattern ?? ""}`,
	apply_diff: (args) => `파일 편집: ${args.path ?? ""}`,
	browser: (args) => `웹 페이지: ${args.url ?? ""}`,
	sessions_spawn: (args) => `서브 에이전트: ${args.task ?? ""}`,
	skill_time: () => "현재 시간 조회",
	skill_system_status: () => "시스템 상태 조회",
	skill_weather: (args) => `날씨 조회: ${args.location ?? ""}`,
	skill_memo: (args) => `메모 ${args.action ?? ""}: ${args.key ?? ""}`,
	skill_cron: (args) =>
		`예약 작업 ${args.action ?? ""}: ${args.label ?? args.job_id ?? ""}`,
	skill_naia_discord: (args) =>
		`디스코드 ${args.action ?? ""}: ${(args.to as string) ?? (args.channelId as string) ?? (args.userId as string) ?? ""}`,
};

export function getToolDescription(
	toolName: string,
	args: Record<string, unknown>,
): string {
	const fn = TOOL_DESCRIPTIONS[toolName];
	if (fn) return fn(args);
	return `도구 실행: ${toolName} ${JSON.stringify(args)}`;
}
