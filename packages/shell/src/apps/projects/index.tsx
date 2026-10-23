import { Suspense, lazy } from "react";
import { appRegistry } from "../../lib/app-registry";
import { useAppStore } from "../../stores/app";
import { PROJECT_APP_NAMES } from "./locales/projects";

const ProjectsApp = lazy(() => import("./ProjectsApp"));

function ProjectsCenterArea() {
	return (
		<Suspense fallback={null}>
			<ProjectsApp />
		</Suspense>
	);
}

appRegistry.register({
	id: "projects",
	name: "Projects",
	names: PROJECT_APP_NAMES,
	icon: "🤖",
	builtIn: true,
	keepAlive: true,
	deferMountUntilActive: true,
	center: ProjectsCenterArea,
});
useAppStore.getState().bumpAppListVersion();
