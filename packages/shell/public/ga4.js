(() => {
	const loc = window.location;
	const protocol = loc && loc.protocol;
	const host = (loc && loc.hostname ? loc.hostname : "").toLowerCase();
	if (protocol !== "http:" && protocol !== "https:") return;
	if (window.__TAURI__ || window.__TAURI_INTERNALS__) return;
	if (!host || host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "[::1]" || host === "::1" || host === "tauri.localhost" || host.endsWith(".localhost")) return;

	const id = "G-R3HHTFQNGS";
	const src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
	window.dataLayer = window.dataLayer || [];
	function gtag() {
		window.dataLayer.push(arguments);
	}
	window.gtag = window.gtag || gtag;
	window.gtag("consent", "default", {
		analytics_storage: "denied",
		ad_storage: "denied",
		ad_user_data: "denied",
		ad_personalization: "denied",
	});
	const doc = window.document;
	if (doc && !doc.querySelector(`script[src="${src}"]`)) {
		const script = doc.createElement("script");
		script.async = true;
		script.src = src;
		(doc.head || doc.documentElement).appendChild(script);
	}
	window.gtag("js", new Date());
	window.gtag("config", id);
})();
