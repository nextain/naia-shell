import { Suspense, lazy } from "react";
import { appRegistry } from "../../lib/app-registry";

const ProjectsApp = lazy(() =>
	import("./ProjectsApp").then(({ ProjectsApp }) => ({
		default: ProjectsApp,
	})),
);

function ProjectsCenterArea() {
	return (
		<Suspense fallback={null}>
			<ProjectsApp />
		</Suspense>
	);
}

appRegistry.register({
	id: "projects",
	name: "프로젝트",
	names: { ko: "프로젝트", en: "Projects" },
	icon: "📁",
	builtIn: true,
	keepAlive: true,
	center: ProjectsCenterArea,
});
