import React from "react";
import { createRoot } from "react-dom/client";
import { createGenericInstalledApp } from "../../src/apps/generic-installed/GenericInstalledApp";
import { initializeI18n } from "../../src/lib/i18n";

// Served only by the test's disposable Vite server. Import through Vite's
// module graph so dependency filenames are resolved by the optimizer.
await initializeI18n();
const App = createGenericInstalledApp("C:/apps/land.naia.slides/index.html");
window.addEventListener("message", (event) => {
	if (event.source === document.querySelector("iframe")?.contentWindow && event.data?.type === "naia-slides:speak") {
		(window as any).fixture.speeches.push(event.data.detail);
	}
});
createRoot(document.getElementById("host")!).render(
	<App naia={{ onToolCall: () => () => {} } as any} />,
);
