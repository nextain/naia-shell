import { SettingsTab } from "../../components/SettingsTab";
import { panelRegistry } from "../../lib/panel-registry";

function SettingsCenterPanel() {
	return (
		<div style={{ height: "100%", overflowY: "auto" }}>
			<SettingsTab />
		</div>
	);
}

panelRegistry.register({
	id: "settings",
	name: "설정",
	names: { ko: "설정", en: "Settings" },
	icon: "⚙️",
	builtIn: true,
	keepAlive: false,
	center: SettingsCenterPanel,
});
