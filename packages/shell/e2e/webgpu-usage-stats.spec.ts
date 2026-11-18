import { writeFile } from "node:fs/promises";
import { type Page, expect, test } from "@playwright/test";

async function saveRequestCounts(
	testInfo: import("@playwright/test").TestInfo,
	counts: unknown,
) {
	await writeFile(
		testInfo.outputPath("google-request-counts.json"),
		`${JSON.stringify(counts, null, 2)}\n`,
	);
}

const mockGtag = `(() => {
  const layer = window.dataLayer = window.dataLayer || [];
  let config = {};
  const send = (command) => {
    const args = Array.from(command || []);
    if (args[0] === "config") config = args[2] || {};
    if (args[0] === "event") {
      fetch("https://www.google-analytics.com/g/collect", {
        method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({event: args, config})
      }).catch(() => {});
    }
  };
  const push = layer.push.bind(layer);
  layer.forEach(send);
  layer.push = (...commands) => { const n = push(...commands); commands.forEach(send); return n; };
})();`;

function watchAnalyticsRequests(
	page: Page,
	requests: Array<{ url: string; body: string | null }>,
) {
	page.on("request", (request) => {
		if (
			request.url().includes("google-analytics.com") ||
			request.url().includes("googletagmanager.com")
		) {
			requests.push({ url: request.url(), body: request.postData() });
		}
	});
}

async function mockReceiver(page: Page) {
	await page.context().route("https://www.googletagmanager.com/**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/javascript",
			body: mockGtag,
		}),
	);
	await page
		.context()
		.route("https://www.google-analytics.com/**", (route) =>
			route.fulfill({ status: 204, body: "" }),
		);
}

test("T-01: unselected and declined WebGPU analytics make zero Google requests", async ({
	page,
}, testInfo) => {
	const requests: Array<{ url: string; body: string | null }> = [];
	watchAnalyticsRequests(page, requests);
	await mockReceiver(page);
	await page.goto(
		"/?email=PRIVATE_EMAIL&question=PRIVATE_QUESTION&state=PRIVATE_STATE&gclid=PRIVATE_AD_ID",
	);
	await expect(
		page.getByRole("dialog", { name: "WebGPU usage statistics" }),
	).toBeVisible();
	await page.evaluate(async () => {
		const mod = await import("/src/lib/web-runtime/usage-analytics.ts");
		mod.trackWebGpuAnalyticsEvent("webgpu_model_ready");
	});
	await expect.poll(() => requests.length).toBe(0);
	await page.getByRole("button", { name: "Decline" }).click();
	await expect.poll(() => requests.length).toBe(0);
	await saveRequestCounts(testInfo, {
		beforeConsent: 0,
		afterDecline: requests.length,
	});
});

test("T-03/T-05: withdrawal stops both tabs and the mocked payload has only fixed values", async ({
	page,
	context,
}, testInfo) => {
	const requests: Array<{ url: string; body: string | null }> = [];
	watchAnalyticsRequests(page, requests);
	await mockReceiver(page);
	await page.goto(
		"/?email=PRIVATE_EMAIL&question=PRIVATE_QUESTION&state=PRIVATE_STATE&gclid=PRIVATE_AD_ID",
	);
	await page.getByRole("button", { name: "Allow statistics" }).click();
	await expect
		.poll(() =>
			requests.some((request) => request.url.includes("googletagmanager.com")),
		)
		.toBe(true);

	const secondTab = await context.newPage();
	watchAnalyticsRequests(secondTab, requests);
	await mockReceiver(secondTab);
	await secondTab.goto(
		"/?email=PRIVATE_SECOND_EMAIL&state=PRIVATE_SECOND_STATE",
	);
	await expect
		.poll(
			() =>
				requests.filter((request) =>
					request.url.includes("googletagmanager.com"),
				).length,
		)
		.toBeGreaterThanOrEqual(2);

	await page.evaluate(async () => {
		const mod = await import("/src/lib/web-runtime/usage-analytics.ts");
		mod.trackWebGpuAnalyticsEvent("webgpu_first_reply", {
			elapsed_seconds: 2.36,
			email: "PRIVATE_EMAIL",
			question: "PRIVATE_QUESTION",
			query: "PRIVATE_QUERY",
		});
		mod.trackWebGpuAnalyticsEvent("webgpu_model_ready", {
			answer: "PRIVATE_ANSWER",
			url: "https://private.invalid/?PRIVATE_QUERY",
		});
	});
	await expect
		.poll(
			() =>
				requests.filter((request) =>
					request.url.includes("google-analytics.com/g/collect"),
				).length,
		)
		.toBe(2);
	const payloads = requests.filter((request) =>
		request.url.includes("google-analytics.com/g/collect"),
	);
	expect(
		payloads.map((request) => JSON.parse(request.body ?? "{}").event[1]),
	).toEqual(["webgpu_first_reply", "webgpu_model_ready"]);
	const firstReply = JSON.parse(payloads[0].body ?? "{}");
	expect(firstReply.event[2]).toEqual({ elapsed_seconds: 2.4 });
	expect(firstReply.config).toMatchObject({
		page_location: `${new URL(page.url()).origin}/webgpu`,
		page_referrer: "",
	});
	expect(
		`${payloads.map((request) => request.url + request.body).join("\n")}`,
	).not.toMatch(
		/PRIVATE_EMAIL|PRIVATE_QUESTION|PRIVATE_ANSWER|PRIVATE_QUERY|PRIVATE_STATE|PRIVATE_AD_ID/,
	);

	await page.getByRole("button", { name: /Usage data/ }).click();
	await page.getByRole("button", { name: "Decline" }).click();
	await expect
		.poll(() =>
			secondTab.evaluate(() =>
				localStorage.getItem("naia_webgpu_analytics_consent"),
			),
		)
		.toBe("essential-only");
	const requestsAtWithdrawal = requests.length;
	const collectionCountAfterWithdrawal = requests.filter((request) =>
		request.url.includes("google-analytics.com/g/collect"),
	).length;
	await page.evaluate(async () => {
		const mod = await import("/src/lib/web-runtime/usage-analytics.ts");
		mod.trackWebGpuAnalyticsEvent("webgpu_model_ready");
	});
	await secondTab.evaluate(async () => {
		const mod = await import("/src/lib/web-runtime/usage-analytics.ts");
		mod.trackWebGpuAnalyticsEvent("webgpu_model_ready");
	});
	await page.reload();
	await secondTab.reload();
	await expect
		.poll(
			() =>
				requests.filter((request) =>
					request.url.includes("google-analytics.com/g/collect"),
				).length,
		)
		.toBe(collectionCountAfterWithdrawal);
	const collectionCountAfterReload = requests.filter((request) =>
		request.url.includes("google-analytics.com/g/collect"),
	).length;
	const tagCountAfterReload = requests.filter((request) =>
		request.url.includes("googletagmanager.com"),
	).length;
	await saveRequestCounts(testInfo, {
		beforeWithdrawal: {
			gtag: requests.filter((request) =>
				request.url.includes("googletagmanager.com"),
			).length,
			collection: collectionCountAfterWithdrawal,
		},
		afterReload: {
			gtag: tagCountAfterReload,
			collection: collectionCountAfterReload,
		},
		newRequestsAfterWithdrawal: requests.length - requestsAtWithdrawal,
	});
	await secondTab.close();
});
