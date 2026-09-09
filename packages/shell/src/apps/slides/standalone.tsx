import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppContext, NaiaContextBridge, ToolHandler } from "../../lib/app-registry";
import { initializeI18n } from "../../lib/i18n";
import {
	SLIDES_HOST_ENVIRONMENT_EVENT,
	startSlidesHostClientBridge,
} from "../../lib/slides-host";
import { SlidesCenterArea } from "./SlidesCenterArea";
import "./standalone.css";

const handlers = new Map<string, ToolHandler>();

const bridge: NaiaContextBridge = {
	pushContext(context: AppContext) {
		window.parent.postMessage({ type: "naia-app:context", context }, "*");
	},
	onToolCall(name, handler) {
		handlers.set(name, handler);
		return () => handlers.delete(name);
	},
	async logBehavior() {},
	async queryBehavior() { return []; },
	async getSecret() { return null; },
	async setSecret() {},
	async readFile() { throw new Error("Use the Slides file picker"); },
	async runShell() { throw new Error("Shell access is not required by Naia Slides"); },
};

window.addEventListener("message", async (event) => {
	const message = event.data;
	if (event.source !== window.parent || message?.type !== "naia-tool-call") return;
	const handler = handlers.get(message.tool);
	try {
		const result = handler ? await handler(message.args ?? {}) : `No handler registered for tool: ${message.tool}`;
		window.parent.postMessage({ type: "naia-tool-result", id: message.id, result }, "*");
	} catch (error) {
		window.parent.postMessage({ type: "naia-tool-result", id: message.id, error: error instanceof Error ? error.message : String(error) }, "*");
	}
});

function StandaloneSlides() {
	const [, forceRender] = useState(0);
	useEffect(() => {
		const onEnvironment = () => forceRender((value) => value + 1);
		window.addEventListener(SLIDES_HOST_ENVIRONMENT_EVENT, onEnvironment);
		return () => window.removeEventListener(SLIDES_HOST_ENVIRONMENT_EVENT, onEnvironment);
	}, []);
	// Re-rendering this stable component applies translated labels and CSS
	// variables without remounting SlidesCenterArea or losing the current deck.
	return <SlidesCenterArea naia={bridge} />;
}

async function bootstrap() {
	await initializeI18n();
	const host = startSlidesHostClientBridge();
	await host.ready;
	const root = document.getElementById("root");
	if (!root) return;
	createRoot(root).render(
		<React.StrictMode><StandaloneSlides /></React.StrictMode>,
	);
}

void bootstrap();
