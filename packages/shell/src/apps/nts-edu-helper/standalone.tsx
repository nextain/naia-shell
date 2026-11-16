import React from "react";
import { createRoot } from "react-dom/client";
import { Logger } from "../../lib/logger";
import { AxLectureStudioApp } from "./AxLectureStudioApp";

const TAG = "AxLectureStandalone";

function bootstrap() {
	Logger.debug(TAG, "bootstrapping standalone public-sector AX studio app");
	const root = document.getElementById("root");
	if (!root) return;
	createRoot(root).render(
		<React.StrictMode>
			<AxLectureStudioApp />
		</React.StrictMode>,
	);
}

bootstrap();
