import { expect, test } from "@playwright/test";

test("kiosk knowledge uses real browser OPFS and desktop-compatible search", async ({
	page,
}) => {
	test.skip(process.env.VITE_NAIA_KIOSK_DEMO !== "1", "Requires the demo build");
	await page.goto("/");
	const result = await page.evaluate(async () => {
		// @ts-expect-error Vite serves the actual source module in this browser probe.
		const { routeCommand } = await import("/src/lib/web-runtime/router.ts");
		// @ts-expect-error Vite source module.
		const { getWebFs } = await import("/src/lib/web-runtime/web-fs.ts");
		// @ts-expect-error Vite source module.
		const { readKioskKnowledgeService, KIOSK_SCOPE, KIOSK_SOURCE } =
			await import("/src/lib/kiosk-demo/knowledge.ts");
		// @ts-expect-error Real Worker entry served by Vite.
		const { createAgentWorker } = await import(
			"/web-worker/create-agent-worker.ts"
		);
		const worker = createAgentWorker();
		const channel = new MessageChannel();
		const workerTools = await new Promise<string[]>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("worker skill list timeout")),
				15000,
			);
			channel.port1.onmessage = (event) => {
				const message = JSON.parse(event.data);
				if (message.type === "skill_list_response") {
					clearTimeout(timer);
					resolve(message.tools.map((tool: { name: string }) => tool.name));
				}
			};
			worker.postMessage({ kind: "naia-agent-connect", model: null }, [
				channel.port2,
			]);
			channel.port1.postMessage(
				JSON.stringify({ type: "skill_list", requestId: "s1-tools" }),
			);
		});
		worker.terminate();
		channel.port1.close();
		if (
			!workerTools.includes("skill_knowledge_search") ||
			!workerTools.includes("skill_knowledge_ask")
		)
			throw new Error("knowledge tools missing in actual worker");
		const config = JSON.parse(await routeCommand("read_naia_knowledge_config"));
		const raw = await routeCommand("read_naia_knowledge_kb", {
			scope: KIOSK_SCOPE,
		});
		const compiled = await routeCommand("compile_knowledge");
		const service = await readKioskKnowledgeService(getWebFs());
		// @ts-expect-error Vite source module and actual desktop executor, no model.
		const { makeKioskKnowledgeTools } = await import(
			"/web-worker/kiosk-knowledge.ts"
		);
		const tools = makeKioskKnowledgeTools({
			specs: () => [],
			execute: async () => ({ output: "unused" }),
		});
		await tools.refresh();
		const toolResult = await tools.executor.execute(
			{
				id: "s1-probe",
				name: "skill_knowledge_search",
				args: { query: "넥스테인은 뭘 하는 회사예요?" },
			},
			{},
		);
		if (!JSON.parse(toolResult.output).hits.length)
			throw new Error("desktop knowledge executor returned no hits");
		const hits = await service.search("넥스테인은 뭘 하는 회사예요?");
		await routeCommand("write_naia_knowledge_config", {
			json: JSON.stringify(config),
		});
		return {
			config,
			cards: JSON.parse(raw).kb.cards.length,
			compiled: compiled.ok,
			hit: hits.some((h: { sourceUris: string[] }) =>
				h.sourceUris.includes(`${KIOSK_SOURCE}/company.md`),
			),
		};
	});
	expect(result.config.scope).toBe("kiosk-demo");
	expect(result.cards).toBe(21);
	expect(result.compiled).toBe(true);
	expect(result.hit).toBe(true);
	await page.reload();
	const count = await page.evaluate(async () => {
		// @ts-expect-error Vite source module.
		const { routeCommand } = await import("/src/lib/web-runtime/router.ts");
		return JSON.parse(
			await routeCommand("read_naia_knowledge_kb", { scope: "kiosk-demo" }),
		).kb.cards.length;
	});
	expect(count).toBe(21);
});

test("ordinary web keeps knowledge blocked without seeding a KB", async ({ page }) => {
	test.skip(process.env.VITE_NAIA_KIOSK_DEMO === "1", "Run this isolation probe with the demo flag disabled");
	await page.goto("/");
	const isolated = await page.evaluate(async () => {
		// @ts-expect-error Vite source module.
		const { routeCommand } = await import("/src/lib/web-runtime/router.ts");
		// @ts-expect-error Vite source module.
		const { getWebFs } = await import("/src/lib/web-runtime/web-fs.ts");
		for (const command of ["compile_knowledge", "read_naia_knowledge_kb", "read_naia_knowledge_config", "write_naia_knowledge_config"]) {
			try { await routeCommand(command); return false; }
			catch (error) { if (String(error) !== `Error: desktop_only:${command}`) return false; }
		}
		return await getWebFs().readText("naia-adk/naia-settings/knowledge/kiosk-demo/kb.json") === null;
	});
	expect(isolated).toBe(true);
});
