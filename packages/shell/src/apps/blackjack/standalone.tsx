import React from "react";
import { createRoot } from "react-dom/client";
import { Logger } from "../../lib/logger";
import { BlackjackStudioApp } from "./BlackjackStudioApp";

const TAG = "BlackjackStandalone";

function bootstrap() {
	Logger.debug(TAG, "bootstrapping standalone blackjack studio app");
	const root = document.getElementById("root");
	if (!root) return;
	createRoot(root).render(
		<React.StrictMode>
			<BlackjackStudioApp />
		</React.StrictMode>,
	);
}

bootstrap();
