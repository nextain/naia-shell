import { AvatarCanvas } from "../../components/AvatarCanvas";
import {
	type AppCenterProps,
	type AppContext,
	appRegistry,
} from "../../lib/app-registry";

function AvatarCenterPanel(_props: AppCenterProps) {
	return <AvatarCanvas />;
}

function getContext(): AppContext {
	return {
		type: "avatar",
		data: {},
	};
}

appRegistry.register({
	id: "avatar",
	name: "Naia",
	icon: "✦",
	center: AvatarCenterPanel,
	getContext,
});
