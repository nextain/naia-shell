import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import StudioNvaApplyHost from "./components/StudioNvaApplyHost";

// Loaded by main.tsx after the first render. Studio NVA apply links wait in the
// native queue until acknowledged, so this separate root (listener, dialog,
// and apply flow) stays out of the entry chunk without losing a link.
const container = document.createElement("div");
container.dataset.studioNvaApplyRoot = "";
document.body.append(container);
createRoot(container).render(
	<StrictMode>
		<StudioNvaApplyHost />
	</StrictMode>,
);
