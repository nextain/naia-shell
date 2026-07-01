import { SettingsTab } from "../../components/SettingsTab";
import { appRegistry } from "../../lib/app-registry";

function SettingsCenterPanel() {
	return (
		<div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
			<SettingsTab />
		</div>
	);
}

appRegistry.register({
	id: "settings",
	name: "설정",
	names: { ko: "설정", en: "Settings" },
	icon: "⚙️",
	builtIn: true,
	keepAlive: true, // SettingsTab must stay mounted during browser-panel login to keep naia_auth_complete listener alive
	center: SettingsCenterPanel,
});
