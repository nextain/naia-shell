import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/global.css";

if (
	import.meta.env.DEV &&
	new URLSearchParams(window.location.search).has("reset")
) {
	localStorage.clear();
}

// biome-ignore lint/style/noNonNullAssertion: root element always exists
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
