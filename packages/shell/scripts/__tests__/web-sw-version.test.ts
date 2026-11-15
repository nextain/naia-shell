import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	computeWebSwVersion,
	injectServiceWorkerVersion,
	stampBuiltServiceWorker,
} from "../web-sw-version.mjs";

const SW_TEMPLATE_PATH = path.resolve(
	import.meta.dirname,
	"../../public/sw.js",
);

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "web-sw-version-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function createFakeSwEnv(
	swSource: string,
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	options: { windowUrls?: string[] } = {},
) {
	const stores = new Map<string, Map<string, Response>>();
	const listeners = new Map<string, Array<(event: unknown) => void>>();
	const deletedKeys: string[] = [];
	const navigatedUrls: string[] = [];
	const matchAllCalls: Array<{ type?: string }> = [];
	const eventsOrder: string[] = [];
	let skipWaitingCount = 0;
	let claimCount = 0;
	const windowClients = (
		options.windowUrls ?? ["https://demo.example.test/"]
	).map((initialUrl) => {
		const client = {
			url: initialUrl,
			async navigate(targetUrl: string) {
				eventsOrder.push(`navigate:${targetUrl}`);
				navigatedUrls.push(targetUrl);
				client.url = targetUrl;
				return client;
			},
		};
		return client;
	});

	const caches = {
		async open(name: string) {
			let store = stores.get(name);
			if (!store) {
				store = new Map();
				stores.set(name, store);
			}
			return {
				async put(req: string | Request, res: Response) {
					const key = typeof req === "string" ? req : req.url;
					store!.set(key, res);
				},
				async match(req: string | Request) {
					const key = typeof req === "string" ? req : req.url;
					const hit = store!.get(key);
					return hit ? hit.clone() : undefined;
				},
			};
		},
		async keys() {
			return [...stores.keys()];
		},
		async delete(name: string) {
			eventsOrder.push(`delete:${name}`);
			deletedKeys.push(name);
			return stores.delete(name);
		},
	};

	const selfObj = {
		location: { origin: "https://demo.example.test" },
		skipWaiting: async () => {
			eventsOrder.push("skipWaiting");
			skipWaitingCount += 1;
		},
		clients: {
			claim: async () => {
				eventsOrder.push("claim");
				claimCount += 1;
			},
			matchAll: async (query?: { type?: string }) => {
				eventsOrder.push(`matchAll:${query?.type ?? ""}`);
				matchAllCalls.push(query ?? {});
				if (!query?.type || query.type === "window") {
					return [...windowClients];
				}
				return [];
			},
		},
		addEventListener(type: string, cb: (event: unknown) => void) {
			const arr = listeners.get(type) ?? [];
			arr.push(cb);
			listeners.set(type, arr);
		},
	};

	vm.runInNewContext(swSource, {
		self: selfObj,
		caches,
		fetch: fetchImpl,
		URL,
		Response,
		Promise,
	});

	async function dispatchLifecycle(type: string) {
		const waits: Promise<unknown>[] = [];
		for (const cb of listeners.get(type) ?? []) {
			cb({
				waitUntil(p: Promise<unknown>) {
					waits.push(p);
				},
			});
		}
		await Promise.all(waits);
	}

	async function dispatchFetch(request: {
		url: string;
		method?: string;
		mode?: string;
		headers?: Headers;
	}) {
		let responded: Promise<Response> | undefined;
		for (const cb of listeners.get("fetch") ?? []) {
			cb({
				request: {
					method: request.method ?? "GET",
					mode: request.mode ?? "cors",
					url: request.url,
					headers: request.headers ?? new Headers(),
				},
				respondWith(p: Promise<Response>) {
					responded = p;
				},
			});
		}
		return responded ? await responded : undefined;
	}

	return {
		stores,
		deletedKeys,
		navigatedUrls,
		matchAllCalls,
		eventsOrder,
		get skipWaitingCount() {
			return skipWaitingCount;
		},
		get claimCount() {
			return claimCount;
		},
		dispatchLifecycle,
		dispatchFetch,
	};
}

function makeBasicResponse(
	url: string,
	body: string,
	contentType = "text/html",
) {
	const res = new Response(body, {
		status: 200,
		headers: { "content-type": contentType, "cache-control": "no-cache" },
	});
	Object.defineProperty(res, "url", { value: url });
	Object.defineProperty(res, "type", { value: "basic" });
	return res;
}

describe("web-sw-version & sw.js", () => {
	it("computes deterministic version from revision and index.html and stamps sw.js", () => {
		const htmlA =
			'<html><script src="/assets/index-AAAAAAAA.js"></script></html>';
		const htmlB =
			'<html><script src="/assets/index-BBBBBBBB.js"></script></html>';
		const vA = computeWebSwVersion({
			revision: "3092bab6",
			indexHtml: htmlA,
			explicitVersion: "",
		});
		const vB = computeWebSwVersion({
			revision: "3092bab6",
			indexHtml: htmlB,
			explicitVersion: "",
		});
		expect(vA).toMatch(/^3092bab6-[0-9a-f]{8}$/);
		expect(vB).toMatch(/^3092bab6-[0-9a-f]{8}$/);
		expect(vA).not.toBe(vB);

		const swTemplate = fs.readFileSync(SW_TEMPLATE_PATH, "utf8");
		fs.writeFileSync(path.join(root, "index.html"), htmlA);
		fs.writeFileSync(path.join(root, "sw.js"), swTemplate);

		const stamped = stampBuiltServiceWorker({
			outDir: root,
			revision: "3092bab6",
		});
		expect(stamped.version).toBe(vA);
		const outSw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
		expect(outSw).toContain(`const SW_BUILD_VERSION = "${vA}";`);
		expect(outSw).not.toContain("__NAIA_SW_VERSION__");
	});

	it("rejects sw template missing placeholder", () => {
		expect(() => injectServiceWorkerVersion("const x = 1;", "v2")).toThrow(
			/__NAIA_SW_VERSION__/,
		);
	});

	it("purges prior caches on activate, calls skipWaiting/clients.claim, and fetches navigate requests network-first with cache no-cache", async () => {
		const swTemplate = fs.readFileSync(SW_TEMPLATE_PATH, "utf8");
		const stamped = injectServiceWorkerVersion(swTemplate, "r16-test0002");

		const fetchCalls: Array<{ url: string; cache?: RequestCache }> = [];
		let currentHtml =
			'<html><script src="/assets/index-11111111.js"></script><body>v1</body></html>';
		let offline = false;

		const env = createFakeSwEnv(stamped, async (url, init) => {
			fetchCalls.push({ url, cache: init?.cache });
			if (offline) {
				throw new Error("network down");
			}
			if (url === "https://demo.example.test/") {
				return makeBasicResponse(url, currentHtml, "text/html");
			}
			if (url.endsWith("/assets/index-11111111.js")) {
				return makeBasicResponse(
					url,
					"console.log('asset-1')",
					"application/javascript",
				);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		// Seed old caches (previous hardcoded v1 + unrelated stale cache)
		const oldV1 = await env.stores;
		oldV1.set(
			"naia-shell-v1",
			new Map([
				[
					"https://demo.example.test/",
					makeBasicResponse(
						"https://demo.example.test/",
						"<html>old-14</html>",
					),
				],
			]),
		);
		oldV1.set("legacy-cache", new Map());

		await env.dispatchLifecycle("install");
		expect(env.skipWaitingCount).toBe(1);
		expect(env.stores.has("naia-shell-r16-test0002")).toBe(true);
		expect(fetchCalls[0]).toEqual({
			url: "https://demo.example.test/",
			cache: "no-cache",
		});

		await env.dispatchLifecycle("activate");
		expect(env.claimCount).toBe(1);
		expect(env.deletedKeys.sort()).toEqual(["legacy-cache", "naia-shell-v1"]);
		expect([...env.stores.keys()]).toEqual(["naia-shell-r16-test0002"]);

		// Simulate server rolling forward to v2 while current SW answers navigate network-first
		currentHtml =
			'<html><script src="/assets/index-22222222.js"></script><body>v2</body></html>';
		const navRes = await env.dispatchFetch({
			url: "https://demo.example.test/index.html",
			mode: "navigate",
		});
		expect(navRes).toBeDefined();
		expect(await navRes!.text()).toContain("<body>v2</body>");
		expect(fetchCalls.at(-1)).toEqual({
			url: "https://demo.example.test/",
			cache: "no-cache",
		});

		// Offline fallback returns the updated v2 shell cached above
		offline = true;
		const offlineNav = await env.dispatchFetch({
			url: "https://demo.example.test/",
			mode: "navigate",
		});
		expect(offlineNav).toBeDefined();
		expect(await offlineNav!.text()).toContain("<body>v2</body>");
	});

	it("navigates each window client once after deleting stale caches and claiming clients, without repeating", async () => {
		const swTemplate = fs.readFileSync(SW_TEMPLATE_PATH, "utf8");
		const stamped = injectServiceWorkerVersion(swTemplate, "r16-nav-once");
		const html =
			'<html><script src="/assets/index-AAAAAAAA.js"></script><body>new</body></html>';

		const env = createFakeSwEnv(
			stamped,
			async (url) => {
				if (url === "https://demo.example.test/") {
					return makeBasicResponse(url, html, "text/html");
				}
				if (url.endsWith("/assets/index-AAAAAAAA.js")) {
					return makeBasicResponse(
						url,
						"console.log('new')",
						"application/javascript",
					);
				}
				throw new Error(`Unexpected fetch: ${url}`);
			},
			{
				windowUrls: [
					"https://demo.example.test/",
					"https://demo.example.test/?view=slides",
				],
			},
		);

		env.stores.set(
			"naia-shell-v1",
			new Map([
				[
					"https://demo.example.test/",
					makeBasicResponse("https://demo.example.test/", "<html>r15</html>"),
				],
			]),
		);

		await env.dispatchLifecycle("install");
		expect(env.skipWaitingCount).toBe(1);

		env.eventsOrder.length = 0;
		await env.dispatchLifecycle("activate");

		expect(env.deletedKeys).toEqual(["naia-shell-v1"]);
		expect([...env.stores.keys()]).toEqual(["naia-shell-r16-nav-once"]);
		expect(env.matchAllCalls).toEqual([{ type: "window" }]);
		expect(env.navigatedUrls).toEqual([
			"https://demo.example.test/",
			"https://demo.example.test/?view=slides",
		]);
		expect(env.eventsOrder).toEqual([
			"delete:naia-shell-v1",
			"claim",
			"matchAll:window",
			"navigate:https://demo.example.test/",
			"navigate:https://demo.example.test/?view=slides",
		]);

		// Re-running activate after stale caches were removed must NOT navigate again.
		await env.dispatchLifecycle("activate");
		expect(env.navigatedUrls).toHaveLength(2);
	});

	it("does not navigate window clients on first visit when no stale cache exists", async () => {
		const swTemplate = fs.readFileSync(SW_TEMPLATE_PATH, "utf8");
		const stamped = injectServiceWorkerVersion(swTemplate, "r16-first-visit");
		const html =
			'<html><script src="/assets/index-BBBBBBBB.js"></script><body>first</body></html>';

		const env = createFakeSwEnv(
			stamped,
			async (url) => {
				if (url === "https://demo.example.test/") {
					return makeBasicResponse(url, html, "text/html");
				}
				if (url.endsWith("/assets/index-BBBBBBBB.js")) {
					return makeBasicResponse(
						url,
						"console.log('first')",
						"application/javascript",
					);
				}
				throw new Error(`Unexpected fetch: ${url}`);
			},
			{ windowUrls: ["https://demo.example.test/"] },
		);

		await env.dispatchLifecycle("install");
		expect(env.skipWaitingCount).toBe(1);
		expect([...env.stores.keys()]).toEqual(["naia-shell-r16-first-visit"]);

		await env.dispatchLifecycle("activate");
		expect(env.claimCount).toBe(1);
		expect(env.deletedKeys).toEqual([]);
		expect(env.navigatedUrls).toEqual([]);
	});
});
