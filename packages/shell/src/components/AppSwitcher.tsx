import { appRegistry } from "../lib/app-registry";
import { useAppStore } from "../stores/app";

export function AppSwitcher() {
	const { activeApp, setActiveApp } = useAppStore();
	const apps = appRegistry.list();

	if (apps.length <= 1) return null;

	return (
		<div className="app-switcher">
			{apps.map((app) => (
				<button
					key={app.id}
					type="button"
					className={`app-switcher-tab${activeApp === app.id ? " app-switcher-tab--active" : ""}`}
					onClick={() =>
						setActiveApp(activeApp === app.id ? null : app.id)
					}
					title={app.name}
				>
					{app.icon && (
						<span className="app-switcher-icon">{app.icon}</span>
					)}
					<span className="app-switcher-label">{app.name}</span>
				</button>
			))}
		</div>
	);
}
