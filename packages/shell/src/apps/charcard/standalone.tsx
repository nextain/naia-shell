import React from "react";
import { createRoot } from "react-dom/client";
import { Logger } from "../../lib/logger";
import { CharCardApp, type CharCardContextBridge } from "./CharCardApp";
import { resolveCharCardLocale } from "./locales/messages";
import "./standalone.css";

const TAG = "CharCardStandalone";

const bridge: CharCardContextBridge = {
	pushContext(context) {
		Logger.debug(TAG, "posting charcard context to parent", {
			active: context !== null,
		});
		window.parent.postMessage({ type: "naia-app:context", context }, "*");
	},
};

function bootstrap() {
	Logger.debug(TAG, "bootstrapping standalone charcard app");
	const root = document.getElementById("root");
	if (!root) return;
	const locale = resolveCharCardLocale();
	document.documentElement.lang = locale;
	const avatarImageUrl = new URL(
		"../../avatars/03-OL_Woman.webp",
		window.location.href,
	).href;
	createRoot(root).render(
		<React.StrictMode>
			<CharCardApp
				bridge={bridge}
				localeOverride={locale}
				avatarImageUrl={avatarImageUrl}
			/>
		</React.StrictMode>,
	);
}

bootstrap();
