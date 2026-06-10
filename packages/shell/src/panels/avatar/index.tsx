import { AvatarCanvas } from "../../components/AvatarCanvas";
import {
	type PanelCenterProps,
	type PanelContext,
	panelRegistry,
} from "../../lib/panel-registry";

function AvatarCenterPanel(_props: PanelCenterProps) {
	return <AvatarCanvas />;
}

function getContext(): PanelContext {
	return {
		type: "avatar",
		data: {},
	};
}

panelRegistry.register({
	id: "avatar",
	name: "Naia",
	icon: "✦",
	center: AvatarCenterPanel,
	getContext,
});
