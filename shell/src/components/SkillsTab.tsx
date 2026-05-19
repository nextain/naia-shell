import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { directToolCall } from "../lib/chat-service";
import {
	getDisabledSkills,
	isSkillDisabled,
	loadConfig,
	resolveGatewayUrl,
	saveConfig,
	toggleSkill,
} from "../lib/config";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import type { SkillManifestInfo } from "../lib/types";
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

	const fetchGatewayStatus = useCallback(async () => {
		const config = loadConfig();
		const gatewayUrl = resolveGatewayUrl(config);
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
			const gatewayUrl = resolveGatewayUrl(config);
			if (!gatewayUrl) return;

			setInstallingSkills((prev) => new Set(prev).add(name));
			setInstallResults((prev) => {
				const next = new Map(prev);
				next.delete(name);
				return next;
			});
			try {
				// Resolve installId from gateway skill status
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

	async function loadSkills() {
		const store = useSkillsStore.getState();
		store.setLoading(true);
		try {
			const result = await invoke<SkillManifestInfo[]>("list_skills");
			store.setSkills(result);
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

	const query = searchQuery.toLowerCase();
	const filtered = query
		? skills.filter(
				(s) =>
					s.name.toLowerCase().includes(query) ||
					s.description.toLowerCase().includes(query),
			)
		: skills;

	const builtInSkills = filtered.filter((s) => s.type === "built-in");
	const customSkills = filtered.filter((s) => s.type !== "built-in");

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

			{/* Skill list */}
			<div className="skills-list">
				{builtInSkills.length > 0 && (
					<>
						<div className="skills-section-title">
							{t("skills.builtInSection")} ({builtInSkills.length})
						</div>
						{builtInSkills.map((skill) => (
							<SkillCard
								key={skill.name}
								skill={skill}
								disabled={false}
								onToggle={handleToggle}
								onAskAI={onAskAI}
							/>
						))}
					</>
				)}

				{customSkills.length > 0 && (
					<>
						<div className="skills-section-title">
							{t("skills.customSection")} ({customSkills.length})
						</div>
						{customSkills.map((skill) => (
							<SkillCard
								key={skill.name}
								skill={skill}
								disabled={isSkillDisabled(skill.name)}
								onToggle={handleToggle}
								onAskAI={onAskAI}
							/>
						))}
					</>
				)}

				{/* Gateway Skills Status */}
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

	return (
		<div
			className={`skill-card${disabled ? " disabled" : ""}${expanded ? " expanded" : ""}`}
		>
			<div className="skill-card-header" onClick={() => setExpanded(!expanded)}>
				<div className="skill-card-info">
					<div className="skill-card-name">{skill.name}</div>
					<div className="skill-card-desc-short">{skill.description}</div>
				</div>
				<div className="skill-card-actions">
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
						<span className="skill-badge tier">{tierLabel(skill.tier)}</span>
						{skill.source && (
							<span className="skill-badge source">{skill.source}</span>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
