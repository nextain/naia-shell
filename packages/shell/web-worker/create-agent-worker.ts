export function createAgentWorker(): Worker {
	return new Worker(new URL("./agent-worker.ts", import.meta.url), {
		type: "module",
		name: "naia-agent",
	});
}
