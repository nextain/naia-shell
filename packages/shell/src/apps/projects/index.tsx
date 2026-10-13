import { Suspense, lazy } from "react";
import { appRegistry } from "../../lib/app-registry";
import { useAppStore } from "../../stores/app";

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
	names: { ko: "프로젝트" },
	icon: "🤖",
	builtIn: true,
	keepAlive: true,
	deferMountUntilActive: true,
	center: ProjectsCenterArea,
});
useAppStore.getState().bumpAppListVersion();
