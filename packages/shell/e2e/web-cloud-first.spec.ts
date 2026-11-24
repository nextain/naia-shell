import { expect, test } from "@playwright/test";
import { waitWebWorkspaceReady } from "./helpers/web-bgm";

test.skip(
	process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "webllm",
	"requires the regular web runtime with the browser model available",
);

test.use({ serviceWorkers: "block" });

test("the first visit with an available GPU selects cloud without loading the browser model", async ({
	page,
	context,
	baseURL,
}) => {
	const origin = new URL(baseURL ?? "http://invalid.invalid").origin;
	const localModelRequests: string[] = [];
	await context.route(/^https?:\/\//, (route) => {
		const request = new URL(route.request().url());
		if (
			request.pathname.endsWith("/web-worker/webllm-engine.ts") ||
			/(^|\.)(huggingface\.co|hf\.co|mlc\.ai)$/.test(request.hostname)
		) {
			localModelRequests.push(request.pathname);
		}
		return request.origin === origin ? route.continue() : route.abort();
	});
	await page.route("**/web-adk/*.json", async (route) => {
		if (new URL(route.request().url()).origin !== origin) {
			await route.abort();
			return;
		}
		const response = await route.fetch();
		const bundle = await response.json();
		const agents = bundle.files.find((file: { path: string }) => file.path === "AGENTS.md");
		if (!agents) throw new Error("workspace bundle lacks AGENTS.md");
		await route.fulfill({ json: { ...bundle, files: [agents], dirs: [] } });
	});
	await page.addInitScript(() => {
		const starts: (string | null)[] = [];
		let adapterChecks = 0;
		Object.defineProperty(navigator, "gpu", {
			configurable: true,
			value: {
				async requestAdapter() {
					adapterChecks++;
					return { features: new Set(["shader-f16"]) };
				},
			},
		});
		const postMessage = Worker.prototype.postMessage;
		Worker.prototype.postMessage = function (message: unknown, _options?: StructuredSerializeOptions | Transferable[]) {
			const data = message as { kind?: string; model?: string | null } | null;
			if (data?.kind === "naia-agent-connect" || data?.kind === "naia-agent-select-model") {
				starts.push(data.model === null ? null : data.model ?? "missing-model");
			}
			Reflect.apply(postMessage, this, arguments);
		};
		Object.defineProperty(window, "readCloudStartEvidence", {
			value: () => ({ starts: [...starts], adapterChecks }),
		});
	});

	await page.goto("/", { waitUntil: "domcontentloaded" });
	await page.getByTestId("web-workspace-start-default").click();
	await waitWebWorkspaceReady(page);
	await expect.poll(() => page.evaluate(() => {
		const readEvidence = (window as typeof window & {
			readCloudStartEvidence: () => { starts: (string | null)[]; adapterChecks: number };
		}).readCloudStartEvidence;
		const cached = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		return { provider: cached.provider, ...readEvidence() };
	})).toEqual({ provider: "nextain", starts: [null], adapterChecks: 0 });
	expect(localModelRequests).toEqual([]);
});
