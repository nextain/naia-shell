import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Logger } from "../../lib/logger";

export interface SkillEntry {
	name: string;
	path: string;
	description: string;
	trigger: Option<string>;
	management: Option<string>;
	has_frontmatter: boolean;
}

export interface SkillTemplate {
	tools: string[];
	model?: string;
	timeoutMin?: number;
	maxTurns?: number;
}

type Option<T> = T | null;

const SKILL_TEMPLATES: Record<string, SkillTemplate> = {
	"review-pass": {
		tools: ["Read", "Glob", "Grep", "Bash"],
		maxTurns: 30,
	},
	"verify-implementation": {
		tools: ["Read", "Glob", "Grep", "Bash"],
		maxTurns: 20,
	},
	"manage-skills": {
		tools: ["Read", "Glob", "Grep", "Edit", "Write"],
		maxTurns: 15,
	},
	"webapp-testing": {
		tools: ["Read", "Glob", "Grep", "Bash"],
		timeoutMin: 10,
	},
	"doc-coauthoring": {
		tools: ["Read", "Glob", "Grep", "Edit", "Write"],
		maxTurns: 25,
	},
	"patent-draft": {
		tools: ["Read", "Glob", "Grep", "Edit", "Write"],
		maxTurns: 30,
	},
	"patent-pipeline": {
		tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
		maxTurns: 40,
	},
	"copyright-reg": {
		tools: ["Read", "Glob", "Grep", "Edit", "Write"],
		maxTurns: 20,
	},
	payroll: {
		tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
		maxTurns: 15,
	},
	"press-release": {
		tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
		maxTurns: 25,
	},
	"weekly-report": {
		tools: ["Read", "Glob", "Grep", "Bash"],
		maxTurns: 15,
	},
	"merge-worktree": {
		tools: ["Read", "Glob", "Grep", "Bash"],
		maxTurns: 10,
	},
	"read-doc": {
		tools: ["Read", "Bash"],
		maxTurns: 5,
	},
};

const DEFAULT_TEMPLATE: SkillTemplate = {
	tools: ["Read", "Glob", "Grep"],
	maxTurns: 20,
};

export function getSkillTemplate(skillName: string): SkillTemplate {
	return SKILL_TEMPLATES[skillName] ?? DEFAULT_TEMPLATE;
}

export function SkillLauncher({
	onLaunchSkill,
}: {
	onLaunchSkill?: (
		skill: SkillEntry,
		content: string,
		template: SkillTemplate,
	) => void;
}) {
	const [skills, setSkills] = useState<SkillEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState("");

	useEffect(() => {
		loadSkills();
	}, []);

	async function loadSkills() {
		try {
			const result = await invoke<SkillEntry[]>("workspace_discover_skills");
			// Rust handler always returns Vec<SkillEntry>; defensive coercion only
			// matters under partial e2e mocks where unhandled cmds return undefined.
			setSkills(Array.isArray(result) ? result : []);
		} catch (e) {
			Logger.warn("SkillLauncher", "Failed to discover skills", {
				error: String(e),
			});
		} finally {
			setLoading(false);
		}
	}

	const filtered = filter
		? skills.filter(
				(s) =>
					s.name.toLowerCase().includes(filter.toLowerCase()) ||
					s.description.toLowerCase().includes(filter.toLowerCase()),
			)
		: skills;

	const autoSkills = filtered.filter((s) => s.management === "Auto");
	const manualSkills = filtered.filter((s) => s.management !== "Auto");

	async function handleLaunch(skill: SkillEntry) {
		try {
			const content = await invoke<string>("workspace_read_skill_content", {
				path: skill.path,
			});
			const template = getSkillTemplate(skill.name);
			onLaunchSkill?.(skill, content, template);
		} catch (e) {
			Logger.warn("SkillLauncher", "Failed to read skill", {
				skill: skill.name,
				error: String(e),
			});
		}
	}

	function SkillSection({
		label,
		skills: sectionSkills,
	}: {
		label: string;
		skills: SkillEntry[];
	}) {
		return (
			<div className="skill-launcher__section">
				<div className="skill-launcher__section-label">{label}</div>
				{sectionSkills.map((skill) => {
					const tmpl = getSkillTemplate(skill.name);
					return (
						<div
							key={skill.name}
							className={`skill-launcher__item ${!skill.has_frontmatter ? "skill-launcher__item--no-fm" : ""}`}
							title={skill.trigger || skill.description}
						>
							<div className="skill-launcher__item-name">
								{skill.name}
								{!skill.has_frontmatter && (
									<span
										className="skill-launcher__item-warn"
										title="frontmatter 없음"
									>
										⚠
									</span>
								)}
							</div>
							<div className="skill-launcher__item-desc">
								{skill.description || "(설명 없음)"}
							</div>
							<div className="skill-launcher__item-meta">
								{tmpl.tools.length <= 4
									? tmpl.tools.join(", ")
									: `${tmpl.tools.slice(0, 3).join(", ")} +${tmpl.tools.length - 3}`}
							</div>
							{onLaunchSkill && (
								<button
									type="button"
									className="skill-launcher__launch"
									onClick={() => handleLaunch(skill)}
								>
									실행
								</button>
							)}
						</div>
					);
				})}
			</div>
		);
	}

	if (loading) {
		return (
			<div className="skill-launcher skill-launcher--loading">
				스킬 로딩 중…
			</div>
		);
	}

	return (
		<div className="skill-launcher">
			<div className="skill-launcher__header">
				<span className="skill-launcher__title">Skills</span>
				<span className="skill-launcher__count">{skills.length}</span>
			</div>
			<input
				className="skill-launcher__filter"
				type="text"
				placeholder="필터…"
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
			/>
			{autoSkills.length > 0 && (
				<SkillSection label="자동" skills={autoSkills} />
			)}
			{manualSkills.length > 0 && (
				<SkillSection label="수동" skills={manualSkills} />
			)}
			{filtered.length === 0 && (
				<div className="skill-launcher__empty">
					{skills.length === 0
						? "skills/ 디렉토리에 SKILL.md 파일이 없습니다"
						: "필터 결과 없음"}
				</div>
			)}
		</div>
	);
}
