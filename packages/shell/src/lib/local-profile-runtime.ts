const DEFAULT_UNLOAD_TIMEOUT_MS = 5_000;

export async function unloadOllamaModel(
	host: string,
	model: string,
	timeoutMs = DEFAULT_UNLOAD_TIMEOUT_MS,
): Promise<void> {
	const normalizedHost = host.trim().replace(/\/$/, "");
	const normalizedModel = model.trim();
	if (!normalizedHost || !normalizedModel) return;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${normalizedHost}/api/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: normalizedModel, keep_alive: 0 }),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Ollama unload failed: HTTP ${response.status}`);
		}
	} finally {
		clearTimeout(timeout);
	}
}
