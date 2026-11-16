import React from "react";
import { createRoot } from "react-dom/client";
import { Logger } from "../../lib/logger";
import { IeumOfficeApp } from "./IeumOfficeApp";
import "./ieumoffice.css";

const TAG = "IeumOfficeStandalone";

function bootstrap(): void {
	Logger.debug(TAG, "bootstrapping standalone ieumoffice studio");
	const root = document.getElementById("root");
	if (!root) return;
	createRoot(root).render(
		<React.StrictMode>
			<IeumOfficeApp />
		</React.StrictMode>,
	);
}

bootstrap();
