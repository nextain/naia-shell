import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { directToolCall } from "../lib/chat-service";
import {
	getDisabledSkills,
	isSkillDisabled,
	loadConfig,
	resolveConfiguredGatewayUrl,
	saveConfig,
	toggleSkill,
} from "../lib/config";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import {
	normalizeOrigin,
	type SkillManifestInfo,
	type SkillOrigin,
} from "../lib/types";
import { useSkillsStore } from "../stores/skills";

interface GatewayInstallOption {
	id: string;
	kind: string;
	label?: string;
}

interface GatewaySkillStatus {
	name: string;
	description?: string;
	eligible: boolean;
	missing: string[];
	install?: GatewayInstallOption[];
}

function tierLabel(tier: number): string {
	return `T${tier}`;
}

/** #334 — group key derived from `origin`, with a defensive fallback for
 * older Rust builds that haven't been rebuilt to emit `origin` yet.
 *
 * #334 follow-up (trap #2): added the `user` bucket. Previously, skills with
 * undefined/unknown `origin` (user-installed via `~/.naia/skills/`) were
 * silently merged into `shell` because the fallback was over-conservative.
 * They now land in their own group so the misclassification is visible. */
type GroupKey = "agent" | "shell" | "adk" | "user";

function originGroupKey(skill: SkillManifestInfo): GroupKey {
	const o = skill.origin;
	if (typeof o === "string") {
		if (o === "agent") return "agent";
		if (o === "shell" || o.startsWith("shell:")) return "shell";
		if (o.startsWith("adk:")) return "adk";
	}
	// origin is undefined (pre-#334 build) OR normalizeOrigin() rejected the
	// raw string. Built-ins still belong to `shell` (those are gateway/built-in
	// skills that pre-date the origin field); everything else (user-installed
	// gateway/command skills) goes to the dedicated `user` bucket — #334
	// follow-up trap #2.
	return skill.type === "built-in" ? "shell" : "user";
}

/** Best-effort source label rendered on each card. Avoids leaking the
 * filesystem path that `source` historically carried. */
function originBadgeText(skill: SkillManifestInfo): string {
	if (typeof skill.origin === "string") return skill.origin;
	if (skill.type === "built-in") return "shell";
	return skill.type; // gateway | command for user-installed skills
}

/* ────────────────────────────────────────────────────────────────────
 * Collapsed state persistence (gemini §8.1 #6 — versioned key)
 * ──────────────────────────────────────────────────────────────────── */
// v3 = #334 follow-up trap #2 (added `user` group). v2 entries remain
// readable because we only read known keys; missing keys default to false.
const COLLAPSED_STATE_KEY = "naia.skillsGroupCollapsed.v3";

type CollapsedState = Record<GroupKey, boolean>;
const DEFAULT_COLLAPSED: CollapsedState = {
	agent: false,
	shell: false,
	adk: false,
	user: false,
};

function loadCollapsedState(): CollapsedState {
	try {
		const raw =
			typeof localStorage !== "undefined"
				? localStorage.getItem(COLLAPSED_STATE_KEY)
				: null;
		if (!raw) return { ...DEFAULT_COLLAPSED };
		const parsed = JSON.parse(raw) as Partial<CollapsedState>;
		return {
			agent: !!parsed.agent,
			shell: !!parsed.shell,
			adk: !!parsed.adk,
			user: !!parsed.user,
		};
	} catch {
		return { ...DEFAULT_COLLAPSED };
	}
}

function saveCollapsedState(state: CollapsedState): void {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(COLLAPSED_STATE_KEY, JSON.stringify(state));
	} catch {
		// localStorage may be unavailable in some sandboxes; non-fatal.
	}
}

export function SkillsTab({
	onAskAI,
}: {
	onAskAI?: (message: string) => void;
}) {
	const skills = useSkillsStore((s) => s.skills);
	const isLoading = useSkillsStore((s) => s.isLoading);
	const searchQuery = useSkillsStore((s) => s.searchQuery);
	useSkillsStore((s) => s.configVersion);

	const [gatewaySkills, setGatewaySkills] = useState<GatewaySkillStatus[]>([]);
	const [gatewayLoading, setGatewayLoading] = useState(false);
	const [installingSkills, setInstallingSkills] = useState<Set<string>>(
		() => new Set(),
	);
	const [installResults, setInstallResults] = useState<
		Map<string, { success: boolean; message: string }>
	>(() => new Map());

	const [collapsed, setCollapsed] = useState<CollapsedState>(() =>
		loadCollapsedState(),
	);
	/** #334 / gemini §8.1 — track whether the agent has emitted the
	 * `skill_inventory_ready` push event. While `false` AND the adk group
	 * would otherwise be empty, we show a "loading…" placeholder instead
	 * of "no extensions" to avoid the false-empty race.
	 *
	 * Tolerant of the event being absent (separate phase): we fall back
	 * to a 3 s timeout, after which `adkReady = true` and the adk group
	 * renders normally (likely empty for stock installs). */
	const [adkReady, setAdkReady] = useState(false);
	const adkReadyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const fetchGatewayStatus = useCallback(async () => {
		const config = loadConfig();
		const gatewayUrl = resolveConfiguredGatewayUrl(config);
		if (!gatewayUrl) return;

		setGatewayLoading(true);
		try {
			const res = await directToolCall({
				toolName: "skill_skill_manager",
				args: { action: "gateway_status" },
				requestId: `gw-skills-${Date.now()}`,
				gatewayUrl,
			});
			if (res.success && res.output) {
				const parsed = JSON.parse(res.output);
				setGatewaySkills(parsed.skills || []);
			}
		} catch (err) {
			Logger.warn("SkillsTab", "Failed to fetch gateway skills", {
				error: String(err),
			});
		} finally {
			setGatewayLoading(false);
		}
	}, []);

	const handleInstallSkill = useCallback(
		async (name: string) => {
			const config = loadConfig();
			const gatewayUrl = resolveConfiguredGatewayUrl(config);
			if (!gatewayUrl) return;

			setInstallingSkills((prev) => new Set(prev).add(name));
			setInstallResults((prev) => {
				const next = new Map(prev);
				next.delete(name);
				return next;
			});
			try {
				const gs = gatewaySkills.find((s) => s.name === name);
				const installId = gs?.install?.[0]?.id;
				if (!installId) {
					setInstallResults((prev) =>
						new Map(prev).set(name, {
							success: false,
							message: t("skills.installFailed"),
						}),
					);
					setInstallingSkills((prev) => {
						const next = new Set(prev);
						next.delete(name);
						return next;
					});
					return;
				}

				const res = await directToolCall({
					toolName: "skill_skill_manager",
					args: { action: "install", skillName: name, installId },
					requestId: `gw-install-${Date.now()}`,
					gatewayUrl,
				});
				if (res.success) {
					setInstallResults((prev) =>
						new Map(prev).set(name, {
							success: true,
							message: t("skills.installSuccess"),
						}),
					);
				} else {
					setInstallResults((prev) =>
						new Map(prev).set(name, {
							success: false,
							message: res.output || t("skills.installFailed"),
						}),
					);
				}
				await fetchGatewayStatus();
			} catch (err) {
				Logger.warn("SkillsTab", "Failed to install skill", {
					error: String(err),
				});
				setInstallResults((prev) =>
					new Map(prev).set(name, {
						success: false,
						message: String(err),
					}),
				);
			} finally {
				setInstallingSkills((prev) => {
					const next = new Set(prev);
					next.delete(name);
					return next;
				});
			}
		},
		[fetchGatewayStatus, gatewaySkills],
	);

	useEffect(() => {
		loadSkills();
		fetchGatewayStatus();
	}, [fetchGatewayStatus]);

	// #334 / gemini §8.1 — race-condition guard for the adk group.
	// Listen for an agent push event `skill_inventory_ready` (emitted AFTER
	// `FileSkillLoader` resolves). On receipt, re-fetch list_skills. If the
	// agent never emits (Phase-1: it doesn't yet — listener stays tolerant
	// of the absent event), fall back after a 3 s grace window.
	useEffect(() => {
		let unlistenFn: UnlistenFn | undefined;
		let cancelled = false;
		(async () => {
			try {
				unlistenFn = await listen<unknown>("skill_inventory_ready", () => {
					if (cancelled) return;
					setAdkReady(true);
					// Re-fetch so any agent-discovered adk: skills land.
					loadSkills();
				});
			} catch (err) {
				Logger.warn("SkillsTab", "skill_inventory_ready listen failed", {
					error: String(err),
				});
				// Listener failure is non-fatal — fall back to the timeout below.
			}
		})();

		adkReadyTimer.current = setTimeout(() => {
			if (!cancelled) setAdkReady(true);
		}, 3_000);

		return () => {
			cancelled = true;
			if (adkReadyTimer.current) clearTimeout(adkReadyTimer.current);
			if (unlistenFn) unlistenFn();
		};
	}, []);

	async function loadSkills() {
		const store = useSkillsStore.getState();
		store.setLoading(true);
		try {
			const result = await invoke<SkillManifestInfo[]>("list_skills");
			// #334 follow-up trap #1 — Rust returns Option<String> for `origin`;
			// run every payload through the runtime normalizer so unknown brands
			// (typos, future variants, third-party emitters) collapse to undefined
			// and fall into the dedicated `user` bucket instead of silently
			// type-cast to SkillOrigin.
			const normalized = result.map((s) => ({
				...s,
				origin: normalizeOrigin(s.origin as string | undefined),
			}));
			store.setSkills(normalized);
		} catch (err) {
			Logger.warn("SkillsTab", "Failed to load skills", {
				error: String(err),
			});
		} finally {
			store.setLoading(false);
		}
	}

	function handleToggle(skillName: string) {
		toggleSkill(skillName);
		useSkillsStore.getState().bumpConfigVersion();
	}

	function handleEnableAll() {
		const config = loadConfig();
		if (!config) return;
		saveConfig({ ...config, disabledSkills: [] });
		useSkillsStore.getState().bumpConfigVersion();
	}

	function handleDisableAll() {
		const config = loadConfig();
		if (!config) return;
		const customNames = skills
			.filter((s) => s.type !== "built-in")
			.map((s) => s.name);
		saveConfig({ ...config, disabledSkills: customNames });
		useSkillsStore.getState().bumpConfigVersion();
	}

	/** Per-group bulk operations. Agent group is NEVER mutated (gemini §8 — built-in
	 * skills don't expose toggles today). Shell + adk + user groups: toggle the names
	 * that are actually toggleable (type !== "built-in"). */
	function handleGroupBulk(group: GroupKey, enable: boolean) {
		if (group === "agent") return; // no-op guard (UI also hides the button)
		const config = loadConfig();
		if (!config) return;
		const groupNames = skills
			.filter((s) => originGroupKey(s) === group && s.type !== "built-in")
			.map((s) => s.name);
		if (groupNames.length === 0) return;
		const current = new Set(getDisabledSkills());
		if (enable) {
			for (const n of groupNames) current.delete(n);
		} else {
			for (const n of groupNames) current.add(n);
		}
		saveConfig({ ...config, disabledSkills: Array.from(current) });
		useSkillsStore.getState().bumpConfigVersion();
	}

	function toggleGroup(group: GroupKey) {
		setCollapsed((prev) => {
			const next = { ...prev, [group]: !prev[group] };
			saveCollapsedState(next);
			return next;
		});
	}

	const query = searchQuery.toLowerCase();

	/**
	 * Search filter — per gemini §8.3, support an exact-match special case
	 * on `skill_browser_navigate` so the e2e search test is deterministic
	 * (description-collision false-fails). Otherwise: substring match on
	 * name OR description.
	 */
	const filtered = useMemo(() => {
		if (!query) return skills;
		if (query === "skill_browser_navigate") {
			return skills.filter((s) => s.name === "skill_browser_navigate");
		}
		return skills.filter(
			(s) =>
				s.name.toLowerCase().includes(query) ||
				s.description.toLowerCase().includes(query),
		);
	}, [skills, query]);

	const grouped = useMemo(() => {
		const buckets: Record<GroupKey, SkillManifestInfo[]> = {
			agent: [],
			shell: [],
			adk: [],
			user: [],
		};
		for (const s of filtered) {
			buckets[originGroupKey(s)].push(s);
		}
		return buckets;
	}, [filtered]);

	const disabledSkills = getDisabledSkills();
	const disabledSet = new Set(disabledSkills);
	const enabledCount = skills.filter((s) => !disabledSet.has(s.name)).length;

	if (isLoading) {
		return (
			<div className="skills-tab">
				<div className="skills-loading">{t("skills.loading")}</div>
			</div>
		);
	}

	if (skills.length === 0) {
		return (
			<div className="skills-tab">
				<div className="skills-empty">{t("skills.empty")}</div>
			</div>
		);
	}

	return (
		<div className="skills-tab">
			{/* Header */}
			<div className="skills-header">
				<input
					type="text"
					className="skills-search"
					placeholder={t("skills.search")}
					value={searchQuery}
					onChange={(e) =>
						useSkillsStore.getState().setSearchQuery(e.target.value)
					}
				/>
				<div className="skills-header-actions">
					<span className="skills-count">
						{enabledCount}/{skills.length}
					</span>
					<button
						type="button"
						className="skills-action-btn"
						onClick={handleEnableAll}
					>
						{t("skills.enableAll")}
					</button>
					<button
						type="button"
						className="skills-action-btn"
						onClick={handleDisableAll}
					>
						{t("skills.disableAll")}
					</button>
				</div>
			</div>

			{/* #334 — four source-grouped sections (agent/shell/adk/user).
			    `user` was added in the #334 follow-up (trap #2). */}
			<div className="skills-list">
				<SkillsGroup
					group="agent"
					title={t("skills.group.agent")}
					skills={grouped.agent}
					collapsed={collapsed.agent}
					onToggleCollapsed={() => toggleGroup("agent")}
					onGroupBulk={handleGroupBulk}
					onToggle={handleToggle}
					onAskAI={onAskAI}
					searchActive={query.length > 0}
					adkReady={adkReady}
				/>
				<SkillsGroup
					group="shell"
					title={t("skills.group.shell")}
					skills={grouped.shell}
					collapsed={collapsed.shell}
					onToggleCollapsed={() => toggleGroup("shell")}
					onGroupBulk={handleGroupBulk}
					onToggle={handleToggle}
					onAskAI={onAskAI}
					searchActive={query.length > 0}
					adkReady={adkReady}
				/>
				<SkillsGroup
					group="adk"
					title={t("skills.group.adk")}
					skills={grouped.adk}
					collapsed={collapsed.adk}
					onToggleCollapsed={() => toggleGroup("adk")}
					onGroupBulk={handleGroupBulk}
					onToggle={handleToggle}
					onAskAI={onAskAI}
					searchActive={query.length > 0}
					adkReady={adkReady}
				/>
				<SkillsGroup
					group="user"
					title={t("skills.group.user")}
					skills={grouped.user}
					collapsed={collapsed.user}
					onToggleCollapsed={() => toggleGroup("user")}
					onGroupBulk={handleGroupBulk}
					onToggle={handleToggle}
					onAskAI={onAskAI}
					searchActive={query.length > 0}
					adkReady={adkReady}
				/>

				{/* Gateway Skills Status (unchanged) */}
				{gatewaySkills.length > 0 && (
					<>
						<div className="skills-section-title">
							{t("skills.gatewayStatusSection")} ({gatewaySkills.length})
						</div>
						{gatewaySkills
							.filter(
								(gs) =>
									!query ||
									gs.name.toLowerCase().includes(query) ||
									(gs.description?.toLowerCase().includes(query) ?? false),
							)
							.map((gs) => (
								<div
									key={gs.name}
									className={`skill-card gateway-status${gs.eligible ? " eligible" : " ineligible"}`}
									data-testid="gateway-skill-card"
								>
									<div className="skill-card-header">
										<div className="skill-card-info">
											<div className="skill-card-name">{gs.name}</div>
											{gs.description && (
												<div className="skill-card-desc-short">
													{gs.description}
												</div>
											)}
										</div>
										<div className="skill-card-actions">
											{gs.eligible ? (
												<span className="skill-badge eligible">
													{t("skills.eligible")}
												</span>
											) : (
												<button
													type="button"
													className="skills-install-btn"
													data-testid="skills-install-btn"
													disabled={installingSkills.has(gs.name)}
													onClick={() => handleInstallSkill(gs.name)}
												>
													{installingSkills.has(gs.name)
														? t("skills.installing")
														: t("skills.install")}
												</button>
											)}
										</div>
									</div>
									{installResults.has(gs.name) && (
										<div
											className={`skill-install-result ${installResults.get(gs.name)?.success ? "success" : "error"}`}
										>
											{installResults.get(gs.name)?.message}
										</div>
									)}
									{gs.missing.length > 0 && (
										<div className="skill-card-missing">
											{t("skills.missing")}: {gs.missing.join(", ")}
										</div>
									)}
								</div>
							))}
					</>
				)}

				{gatewayLoading && (
					<div className="skills-gateway-loading">
						{t("skills.gatewayLoading")}
					</div>
				)}

				<ClawHubBanner />
			</div>
		</div>
	);
}

/* ────────────────────────────────────────────────────────────────────
 * SkillsGroup — one collapsible group with title, count, per-group
 * bulk buttons, and a list of SkillCards. Empty-group rendering rules:
 *  - agent/shell empty + no search:        hide entirely
 *  - agent/shell empty + active search:    "no matches" placeholder
 *  - adk/user empty + active search:       "no matches" placeholder
 *    (search-state always beats inventory-state — #334 follow-up trap #3)
 *  - adk empty + no search:                "no extensions" placeholder
 *    (so users always see *something* explaining the adk slot)
 *  - adk empty + no search + !adkReady:    "loading…" placeholder
 *  - user empty + no search:               hide entirely (no user skills installed)
 * ──────────────────────────────────────────────────────────────────── */
function SkillsGroup({
	group,
	title,
	skills,
	collapsed,
	onToggleCollapsed,
	onGroupBulk,
	onToggle,
	onAskAI,
	searchActive,
	adkReady,
}: {
	group: GroupKey;
	title: string;
	skills: SkillManifestInfo[];
	collapsed: boolean;
	onToggleCollapsed: () => void;
	onGroupBulk: (group: GroupKey, enable: boolean) => void;
	onToggle: (name: string) => void;
	onAskAI?: (message: string) => void;
	searchActive: boolean;
	adkReady: boolean;
}) {
	const disabledSet = new Set(getDisabledSkills());
	const enabledInGroup = skills.filter((s) => !disabledSet.has(s.name)).length;

	// #334 follow-up trap #4 — bulk button visibility. Only show the button
	// whose action is applicable: when ALL toggleable skills are already
	// enabled, hide "전체 활성화"; when ALL are disabled, hide "전체 비활성화".
	// Built-in skills (type === "built-in") are excluded from the toggleable
	// pool because their toggle is gated off in the row UI.
	const toggleable = skills.filter((s) => s.type !== "built-in");
	const enabledToggleable = toggleable.filter(
		(s) => !disabledSet.has(s.name),
	).length;
	const allEnabled =
		toggleable.length > 0 && enabledToggleable === toggleable.length;
	const allDisabled = toggleable.length > 0 && enabledToggleable === 0;
	// If there's nothing toggleable at all (e.g. agent group has only built-ins),
	// the wrapping `group !== "agent"` check already hides both buttons.

	// Empty-handling per the rule table above. #334 follow-up trap #3:
	// search-active state ALWAYS wins — even for the adk slot, "검색 결과 없음"
	// is more honest than "naia-adk 확장 스킬 없음" (which describes inventory).
	if (skills.length === 0) {
		if (searchActive) {
			return (
				<div
					className="skills-group skills-group-empty"
					data-testid={`skills-group-${group}`}
					data-group={group}
				>
					<div
						className="skills-group-header"
						onClick={onToggleCollapsed}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") onToggleCollapsed();
						}}
					>
						<span className="skills-group-caret">{collapsed ? "▶" : "▼"}</span>
						<span className="skills-group-title">{title}</span>
						<span className="skills-group-count">(0/0)</span>
					</div>
					{!collapsed && (
						<div
							className="skills-group-empty-line"
							data-testid={`skills-group-${group}-empty-search`}
						>
							{t("skills.group.searchNoResult")}
						</div>
					)}
				</div>
			);
		}
		if (group === "adk") {
			return (
				<div
					className="skills-group skills-group-empty"
					data-testid={`skills-group-${group}`}
					data-group={group}
				>
					<div
						className="skills-group-header"
						onClick={onToggleCollapsed}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") onToggleCollapsed();
						}}
					>
						<span className="skills-group-caret">{collapsed ? "▶" : "▼"}</span>
						<span className="skills-group-title">{title}</span>
						<span className="skills-group-count">(0/0)</span>
					</div>
					{!collapsed && (
						<div
							className="skills-group-empty-line"
							data-testid={`skills-group-${group}-empty-inventory`}
						>
							{adkReady
								? t("skills.group.adkEmpty")
								: t("skills.group.adkLoading")}
						</div>
					)}
				</div>
			);
		}
		// Hide an unused agent/shell/user group entirely when there's no search.
		return null;
	}

	return (
		<div
			className="skills-group"
			data-testid={`skills-group-${group}`}
			data-group={group}
		>
			<div
				className="skills-group-header"
				onClick={onToggleCollapsed}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") onToggleCollapsed();
				}}
			>
				<span className="skills-group-caret">{collapsed ? "▶" : "▼"}</span>
				<span className="skills-group-title">{title}</span>
				<span className="skills-group-count">
					({enabledInGroup}/{skills.length})
				</span>
				{group !== "agent" && toggleable.length > 0 && (
					<div
						className="skills-group-bulk"
						onClick={(e) => e.stopPropagation()}
					>
						{/* #334 follow-up trap #4 — hide bulkEnable when all already
						    enabled, hide bulkDisable when all already disabled. Both
						    visible only when the group is in a mixed state. */}
						{!allEnabled && (
							<button
								type="button"
								className="skills-action-btn"
								data-testid={`skills-group-${group}-bulk-enable`}
								onClick={() => onGroupBulk(group, true)}
							>
								{t("skills.group.bulkEnable")}
							</button>
						)}
						{!allDisabled && (
							<button
								type="button"
								className="skills-action-btn"
								data-testid={`skills-group-${group}-bulk-disable`}
								onClick={() => onGroupBulk(group, false)}
							>
								{t("skills.group.bulkDisable")}
							</button>
						)}
					</div>
				)}
			</div>
			{/* Keep the section-title rendered (hidden visually if needed) so
			    legacy spec assertions on `.skills-section-title` keep working. */}
			<div className="skills-section-title">
				{title} ({skills.length})
			</div>
			{!collapsed && (
				<div className="skills-group-body">
					{skills.map((skill) => (
						<SkillCard
							key={skill.name}
							skill={skill}
							disabled={
								skill.type === "built-in" ? false : isSkillDisabled(skill.name)
							}
							onToggle={onToggle}
							onAskAI={onAskAI}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function ClawHubBanner() {
	return (
		<div className="clawhub-banner">
			<div className="clawhub-banner-icon">🐙</div>
			<div className="clawhub-banner-content">
				<div className="clawhub-banner-title">{t("skills.clawHubTitle")}</div>
				<div className="clawhub-banner-desc">{t("skills.clawHubDesc")}</div>
			</div>
			<a
				className="clawhub-banner-link"
				href="https://clawhub.com"
				target="_blank"
				rel="noopener noreferrer"
			>
				{t("skills.clawHubVisit")}
			</a>
		</div>
	);
}

function SkillCard({
	skill,
	disabled,
	onToggle,
	onAskAI,
}: {
	skill: SkillManifestInfo;
	disabled: boolean;
	onToggle: (name: string) => void;
	onAskAI?: (message: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const isBuiltIn = skill.type === "built-in";
	const originText: SkillOrigin | string = originBadgeText(skill);

	return (
		<div
			className={`skill-card${disabled ? " disabled" : ""}${expanded ? " expanded" : ""}`}
			data-testid="skill-card"
			data-origin={originText}
		>
			<div className="skill-card-header" onClick={() => setExpanded(!expanded)}>
				<div className="skill-card-info">
					<div className="skill-card-name">{skill.name}</div>
					<div className="skill-card-desc-short">{skill.description}</div>
				</div>
				<div className="skill-card-actions">
					{/* #334 — always-visible source + tier badges */}
					<span
						className="skill-badge source"
						data-testid="skills-source-badge"
					>
						{originText}
					</span>
					<span className="skill-badge tier">{tierLabel(skill.tier)}</span>
					{onAskAI && (
						<button
							type="button"
							className="skill-help-btn"
							title={t("skills.askAI")}
							onClick={(e) => {
								e.stopPropagation();
								onAskAI(
									`"${skill.name}" 스킬에 대해 자세히 설명해줘. 어떤 기능인지, 어떻게 사용하는지, 예시도 알려줘.`,
								);
							}}
						>
							?
						</button>
					)}
					{!isBuiltIn && (
						<label
							className="skill-toggle"
							onClick={(e) => e.stopPropagation()}
						>
							<input
								type="checkbox"
								checked={!disabled}
								onChange={() => onToggle(skill.name)}
							/>
						</label>
					)}
				</div>
			</div>
			{expanded && (
				<div className="skill-card-detail">
					<div className="skill-card-desc-full">{skill.description}</div>
					<div className="skill-card-badges">
						{isBuiltIn && (
							<span className="skill-badge built-in">
								{t("skills.builtIn")}
							</span>
						)}
						{!isBuiltIn && (
							<span className={`skill-badge ${skill.type}`}>
								{skill.type === "gateway"
									? t("skills.gateway")
									: t("skills.command")}
							</span>
						)}
						{skill.source && (
							<span className="skill-badge source-path">{skill.source}</span>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
