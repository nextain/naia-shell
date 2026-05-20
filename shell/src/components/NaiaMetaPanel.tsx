import { useState } from "react";
import { AgentsTab } from "./AgentsTab";
import { DiagnosticsTab } from "./DiagnosticsTab";
import { SettingsTab } from "./SettingsTab";
import { SkillsTab } from "./SkillsTab";
import { WorkProgressPanel } from "./WorkProgressPanel";

type MetaTabId =
	| "progress"
	| "skills"
	| "channels"
	| "agents"
	| "diagnostics"
	| "settings";

const TABS: { id: MetaTabId; icon: string; label: string }[] = [
	{ id: "progress", icon: "📊", label: "Progress" },
	{ id: "skills", icon: "🧩", label: "Skills" },
	{ id: "channels", icon: "🌐", label: "Channels" },
	{ id: "agents", icon: "🤖", label: "Agents" },
	{ id: "diagnostics", icon: "🔬", label: "Diagnostics" },
	{ id: "settings", icon: "⚙️", label: "Settings" },
];

/** Dispatch message to ChatPanel's input via custom event */
function askAI(message: string) {
	window.dispatchEvent(new CustomEvent("naia:ask-ai", { detail: message }));
}

export function NaiaMetaPanel() {
	const [activeTab, setActiveTab] = useState<MetaTabId>("progress");

	return (
		<div className="naia-meta-panel">
			<div className="naia-meta-panel__tabs">
				{TABS.map((tab) => (
					<button
						key={tab.id}
						type="button"
						className={`naia-meta-panel__tab${activeTab === tab.id ? " naia-meta-panel__tab--active" : ""}`}
						onClick={() => setActiveTab(tab.id)}
						title={tab.label}
					>
						<span>{tab.icon}</span>
					</button>
				))}
			</div>
			<div className="naia-meta-panel__body">
				{activeTab === "progress" && <WorkProgressPanel />}
				{activeTab === "skills" && <SkillsTab onAskAI={askAI} />}
		{activeTab === "channels" && (
			<div style={{ padding: "16px", color: "var(--cream-dim)", fontSize: 13 }}>
				채널 기능은 현재 안정화 작업 중입니다.
			</div>
		)}
					{activeTab === "agents" && <AgentsTab />}
				{activeTab === "diagnostics" && <DiagnosticsTab />}
				{activeTab === "settings" && <SettingsTab />}
			</div>
		</div>
	);
}
