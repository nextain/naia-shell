import {
	type ReactNode,
	useCallback,
	useEffect,
	useState,
} from "react";
import {
	type CliDetectionResult,
	type CliReadinessStatus,
	SHELL_GESTURES,
	getEnabledClis,
	isGestureDisabled,
	openCliLogin,
	refreshCliDetection,
	refreshCliDetectionOne,
	setCliEnabled,
	setGestureEnabled,
} from "../lib/cli-detection";
import { loadConfig } from "../lib/config";
import { t } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import { Logger } from "../lib/logger";
import { isWebMode } from "../lib/web-runtime/web-assets";
import { useSkillsStore } from "../stores/skills";

interface WebBuiltInSkill {
	id: string;
	name: string;
	description: string;
	tools: string;
	badge?: string;
}

const KIOSK_WEB_SKILLS: readonly WebBuiltInSkill[] = [
	{
		id: "knowledge",
		name: "지식",
		description: "저장된 지식 베이스 검색·질의",
		tools: "skill_knowledge_search · skill_knowledge_ask",
	},
];

const COMMON_WEB_SKILLS: readonly WebBuiltInSkill[] = [
	{
		id: "weather",
		name: "날씨",
		description: "날씨 정보 조회",
		tools: "get_weather",
		badge: "지원 예정",
	},
];

function getWebBuiltInSkills(kioskDemo: boolean): readonly WebBuiltInSkill[] {
	return kioskDemo
		? [...KIOSK_WEB_SKILLS, ...COMMON_WEB_SKILLS]
		: COMMON_WEB_SKILLS;
}

/** Built-in skills available inside the web runtime (no CLI detection). */
function WebBuiltInSkillList({ kioskDemo }: { kioskDemo: boolean }) {
	const webSkills = getWebBuiltInSkills(kioskDemo);
	return (
		<>
			<div
				className="skills-section-title"
				data-testid="skills-web-builtin-section"
			>
				{t("skills.builtInSection")} ({webSkills.length})
			</div>
			{webSkills.map((skill) => (
				<div
					key={skill.id}
					className="skill-card"
					data-testid="web-builtin-skill-card"
					data-skill-id={skill.id}
				>
					<div className="skill-card-header">
						<div className="skill-card-info">
							<div className="skill-card-name">{skill.name}</div>
							<div className="skill-card-desc-short">
								{skill.description} · {skill.tools}
							</div>
							<div className="skill-card-badges">
								<span className="skill-badge built-in">
									{skill.badge ?? t("skills.builtIn")}
								</span>
							</div>
						</div>
					</div>
				</div>
			))}
		</>
	);
}

const STATUS_LABEL: Record<CliReadinessStatus, string> = {
	ready: "skills.cliStatusReady",
	"not-installed": "skills.cliStatusNotInstalled",
	"login-required": "skills.cliStatusLoginRequired",
	"waiting-input": "skills.cliStatusWaitingInput",
	error: "skills.cliStatusError",
};

function statusLabelKey(status: string): string {
	return STATUS_LABEL[status as CliReadinessStatus] ?? STATUS_LABEL.error;
}

export function SkillsTab({
	onAskAI: _onAskAI,
	children,
}: {
	onAskAI?: (message: string) => void;
	children?: ReactNode;
}) {
	useSkillsStore((s) => s.configVersion);
	const webMode = isWebMode();
	const kioskDemo = isKioskDemo();
	const [results, setResults] = useState<CliDetectionResult[]>(() => {
		return webMode ? [] : (loadConfig()?.cliDetection?.results ?? []);
	});
	const [loading, setLoading] = useState(!webMode);
	const [checkingId, setCheckingId] = useState<string | null>(null);
	const [loadError, setLoadError] = useState(false);

	const refresh = useCallback(async () => {
		if (isWebMode()) {
			setLoading(false);
			return;
		}
		setLoading(true);
		setLoadError(false);
		try {
			const snapshot = await refreshCliDetection();
			setResults(snapshot.results);
			useSkillsStore.getState().bumpConfigVersion();
		} catch (err) {
			setLoadError(true);
			Logger.warn("SkillsTab", "CLI detection refresh failed", {
				error: String(err),
			});
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (webMode) return;
		void refresh();
	}, [refresh, webMode]);

	const installed = results.filter((r) => r.installed);
	const enabled = new Set(getEnabledClis());

	async function handleRecheck(id: string) {
		setCheckingId(id);
		try {
			const next = await refreshCliDetectionOne(id);
			setResults((prev) => {
				const others = prev.filter((r) => r.id !== id);
				return [...others, next];
			});
			useSkillsStore.getState().bumpConfigVersion();
		} catch (err) {
			Logger.warn("SkillsTab", "CLI recheck failed", {
				id,
				error: String(err),
			});
		} finally {
			setCheckingId(null);
		}
	}

	async function handleLogin(id: string) {
		try {
			await openCliLogin(id);
		} catch (err) {
			Logger.warn("SkillsTab", "CLI login open failed", {
				id,
				error: String(err),
			});
		}
	}

	function handleToggleCli(id: string, checked: boolean) {
		setCliEnabled(id, checked);
		useSkillsStore.getState().bumpConfigVersion();
	}

	function handleToggleGesture(id: (typeof SHELL_GESTURES)[number]["id"], checked: boolean) {
		setGestureEnabled(id, checked);
		useSkillsStore.getState().bumpConfigVersion();
	}

	if (!webMode && loading && results.length === 0) {
		return (
			<div className="skills-tab" data-testid="skills-tab">
				<div className="skills-loading">{t("skills.loading")}</div>
			</div>
		);
	}

	return (
		<div className="skills-tab" data-testid="skills-tab">
			{webMode ? (
				<div
					role="status"
					className="settings-coming-soon-banner"
					data-testid="skills-web-notice"
				>
					향후 앱과 동일하게 지원 예정
				</div>
			) : (
				<div className="skills-header">
					<div className="skills-header-actions">
						<button
							type="button"
							className="skills-action-btn"
							data-testid="skills-cli-refresh"
							onClick={() => void refresh()}
							disabled={loading || checkingId !== null}
						>
							{t("skills.refresh")}
						</button>
					</div>
				</div>
			)}

			<div className="skills-list">
				{webMode ? (
					<WebBuiltInSkillList kioskDemo={kioskDemo} />
				) : (
					<>
						{loadError && (
							<div className="skills-error" data-testid="skills-load-error">
								{t("skills.cliDetectError")}
							</div>
						)}

						<div className="skills-section-title" data-testid="skills-cli-section">
							{t("skills.cliSection")} ({installed.length})
						</div>
						{installed.length === 0 ? (
							<div className="skills-empty" data-testid="skills-cli-empty">
								{t("skills.cliEmpty")}
							</div>
						) : (
							installed.map((cli) => (
								<div
									key={cli.id}
									className="skill-card"
									data-testid="cli-skill-card"
									data-cli-id={cli.id}
								>
									<div className="skill-card-header">
										<div className="skill-card-info">
											<div className="skill-card-name">{cli.displayName}</div>
											<div className="skill-card-desc-short">
												{t(statusLabelKey(cli.status) as Parameters<typeof t>[0])}
												{cli.version ? ` · ${cli.version}` : ""}
											</div>
										</div>
										<div className="skill-card-actions">
											<label
												className="skill-toggle"
												onClick={(e) => e.stopPropagation()}
											>
												<input
													type="checkbox"
													data-testid={`cli-enable-${cli.id}`}
													checked={enabled.has(cli.id)}
													onChange={(e) =>
														handleToggleCli(cli.id, e.target.checked)
													}
												/>
											</label>
										</div>
									</div>
									<div className="skill-card-detail" style={{ display: "block" }}>
										<div className="skills-header-actions">
											<span
												aria-live="polite"
												data-testid={`cli-status-${cli.id}`}
											>
												{t(statusLabelKey(cli.status) as Parameters<typeof t>[0])}
											</span>
											<button
												type="button"
												className="skills-action-btn"
												data-testid={`cli-recheck-${cli.id}`}
												disabled={checkingId === cli.id}
												onClick={() => void handleRecheck(cli.id)}
											>
												{checkingId === cli.id
													? t("skills.cliChecking")
													: t("skills.cliRecheck")}
											</button>
											{(cli.status === "login-required" ||
												cli.status === "waiting-input") && (
												<button
													type="button"
													className="skills-action-btn"
													data-testid={`cli-login-${cli.id}`}
													onClick={() => void handleLogin(cli.id)}
												>
													{t("skills.cliLogin")}
												</button>
											)}
										</div>
									</div>
								</div>
							))
						)}
					</>
				)}

				<div
					className="skills-section-title"
					data-testid="skills-gesture-section"
				>
					{t("skills.gestureSection")} ({SHELL_GESTURES.length})
				</div>
				{SHELL_GESTURES.map((gesture) => {
					const disabled = isGestureDisabled(gesture.id);
					return (
						<div
							key={gesture.id}
							className={`skill-card${disabled ? " disabled" : ""}`}
							data-testid="gesture-skill-card"
							data-gesture-id={gesture.id}
						>
							<div className="skill-card-header">
								<div className="skill-card-info">
									<div className="skill-card-name">
										{t(gesture.labelKey)}
									</div>
									<div className="skill-card-desc-short">
										{t(gesture.hintKey)}
									</div>
								</div>
								<div className="skill-card-actions">
									<label
										className="skill-toggle"
										onClick={(e) => e.stopPropagation()}
									>
										<input
											type="checkbox"
											data-testid={`gesture-enable-${gesture.id}`}
											checked={!disabled}
											onChange={(e) =>
												handleToggleGesture(gesture.id, e.target.checked)
											}
										/>
									</label>
								</div>
							</div>
							{gesture.id === "youtube" && children}
						</div>
					);
				})}

				{webMode && (
					<div
						className="skills-section-title"
						data-testid="skills-web-unavailable"
					>
						코딩 CLI 등 데스크톱 전용 스킬 · 웹버전 통합 진행중
					</div>
				)}
			</div>
		</div>
	);
}
