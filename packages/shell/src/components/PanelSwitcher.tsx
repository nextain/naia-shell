import { panelRegistry } from "../lib/panel-registry";
import { usePanelStore } from "../stores/panel";

export function PanelSwitcher() {
	const { activePanel, setActivePanel } = usePanelStore();
	const panels = panelRegistry.list();

	if (panels.length <= 1) return null;

	return (
		<div className="panel-switcher">
			{panels.map((panel) => (
				<button
					key={panel.id}
					type="button"
					className={`panel-switcher-tab${activePanel === panel.id ? " panel-switcher-tab--active" : ""}`}
					onClick={() =>
						setActivePanel(activePanel === panel.id ? null : panel.id)
					}
					title={panel.name}
				>
					{panel.icon && (
						<span className="panel-switcher-icon">{panel.icon}</span>
					)}
					<span className="panel-switcher-label">{panel.name}</span>
				</button>
			))}
		</div>
	);
}
