import { expect, test } from "@playwright/test";

test("Naia leads a reading and standalone book shows a reading hint", async ({
	page,
}) => {
	await page.setViewportSize({ width: 960, height: 640 });
	await page.goto("/index.html");
	await page.evaluate(() => {
		window.postMessage({ type: "naia-app:locale", locale: "ko" }, "*");
	});
	async function call(args: Record<string, unknown>) {
		return page.evaluate(async (args) => {
			const id = String(Math.random());
			return await new Promise<Record<string, any>>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("Tool timed out")),
					15000,
				);
				const listener = (e: MessageEvent) => {
					if (e.data?.type === "naia-tool-result" && e.data.id === id) {
						clearTimeout(timer);
						window.removeEventListener("message", listener);
						resolve(e.data);
					}
				};
				window.addEventListener("message", listener);
				window.postMessage(
					{ type: "naia-tool-call", id, tool: "skill_cafelua_tarot", args },
					"*",
				);
			});
		}, args);
	}
	await expect(page.getByText("나이아에게 고민을 말해 보세요.")).toBeVisible();
	expect((await call({ action: "reveal_next" })).error).toBeTruthy();
	expect(
		(await call({ action: "start_reading", spread: "celtic" })).result
			.need_question,
	).toBe(true);
	await expect(page.locator(".card")).toHaveCount(0);
	expect(
		(
			await call({
				action: "start_reading",
				spread: "celtic",
				question: "일이 걱정돼요",
			})
		).result.total,
	).toBe(10);
	await expect(page.locator(".card")).toHaveCount(10);
	await page.locator(".card-3 .card").click();
	await expect(
		page.getByText("나이아에게 '다음'이라고 말해 보세요."),
	).toBeVisible();
	for (let i = 0; i < 10; i++) {
		expect((await call({ action: "reveal_next" })).result.number).toBe(i + 1);
		if (i === 0)
			expect((await call({ action: "get_reading" })).result).toMatchObject({
				incomplete: true,
				revealed: 1,
				remaining: 9,
			});
	}
	await page.locator(".card.flipped").last().click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.getByRole("button", { name: "닫기" }).click();
	expect((await call({ action: "get_reading" })).result.cards).toHaveLength(10);
	await call({ action: "finish" });
	await expect(page.locator(".story-buttons button")).toHaveCount(10);
	expect(
		(await call({ action: "open_story", card: 0 })).result.chapter_title,
	).toBeTruthy();
	const first = (await call({ action: "read_aloud" })).result;
	expect(first).not.toHaveProperty("text");
	expect(first.started).toBe(false);
	await expect(page.getByRole("status")).toContainText("나이아");
	await page.getByRole("button", { name: "나이아 낭독" }).click();
	await expect(page.getByRole("status")).toContainText("나이아");
	await page.setViewportSize({ width: 390, height: 760 });
	await page.getByRole("button", { name: "← 탁자로 돌아가기" }).click();
	expect(
		(
			await call({
				action: "start_reading",
				spread: "three",
				question: "일이 걱정돼요",
			})
		).result.total,
	).toBe(3);
	await expect(page.locator(".card")).toHaveCount(3);
	await expect(page.locator(".table-area")).toBeVisible();
	await call({ action: "reveal_next" });
	await page.locator(".card.flipped").click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	const box = await dialog.boundingBox();
	if (!box) throw new Error("Missing meaning panel");
	await page.mouse.move(box.x + box.width / 2, box.y + 12);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2, box.y + 75);
	await page.mouse.up();
	await expect(dialog).toHaveCount(0);
	await call({ action: "open_story", card: 0 });
	await expect(page.locator(".book-icon").first()).toBeVisible();
});

test("embedded book sends original batches and waits for each voice result", async ({
	page,
}) => {
	await page.setViewportSize({ width: 960, height: 640 });
	await page.goto("/index.html");
	await page.evaluate(() => {
		(window as any).voiceMessages = [];
		window.addEventListener("message", (event) => {
			if (event.data?.type?.startsWith("naia-cafelua-tarot:"))
				(window as any).voiceMessages.push(event.data);
		});
		const frame = document.createElement("iframe");
		frame.id = "tarot-test-frame";
		frame.style.cssText =
			"position:fixed;inset:0;width:100%;height:100%;border:0;z-index:1000";
		frame.src = "/index.html";
		document.body.append(frame);
	});
	const iframe = page.locator("#tarot-test-frame");
	await expect(iframe).toBeVisible();
	const frame = await (await iframe.elementHandle())!.contentFrame();
	if (!frame) throw new Error("Missing tarot frame");
	await frame.locator(".table-area").waitFor();
	const call = (args: Record<string, unknown>) =>
		page.evaluate(async (args) => {
			const id = `e2e-${Math.random()}`;
			return await new Promise<Record<string, any>>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("Tool timed out")),
					15000,
				);
				const listener = (e: MessageEvent) => {
					if (e.data?.type === "naia-tool-result" && e.data.id === id) {
						clearTimeout(timer);
						window.removeEventListener("message", listener);
						resolve(e.data);
					}
				};
				window.addEventListener("message", listener);
				(
					document.querySelector("#tarot-test-frame") as HTMLIFrameElement
				).contentWindow!.postMessage(
					{ type: "naia-tool-call", id, tool: "skill_cafelua_tarot", args },
					"*",
				);
			});
		}, args);
	await call({ action: "open_story", card: 0 });
	const result = (await call({ action: "read_aloud" })).result;
	expect(result.started).toBe(true);
	expect(result).not.toHaveProperty("text");
	await expect
		.poll(() => page.evaluate(() => (window as any).voiceMessages.length))
		.toBe(1);
	const first = await page.evaluate(() => (window as any).voiceMessages[0]);
	await expect(frame.locator(".naia-reading-highlight")).toHaveCount(1);
	await expect(frame.locator(".naia-reading-highlight").first()).toBeVisible();
	const original = await frame
		.locator(".naia-reading-highlight")
		.evaluateAll((nodes) =>
			nodes.map(
				(node) =>
					document.querySelector(
						`.library-reader-measure-source p[data-reader-paragraph="${(node as HTMLElement).dataset.readerParagraph}"]`,
					)?.textContent,
			),
		);
	expect(first.text).toBe(original.join("\n\n"));
	await page.waitForTimeout(250);
	expect(await page.evaluate(() => (window as any).voiceMessages.length)).toBe(
		1,
	);
	await page.evaluate(
		(id) =>
			(
				document.querySelector("#tarot-test-frame") as HTMLIFrameElement
			).contentWindow!.postMessage(
				{ type: "naia-cafelua-tarot:speech-result", id, status: "finished" },
				"*",
			),
		first.id,
	);
	await expect
		.poll(() => page.evaluate(() => (window as any).voiceMessages.length))
		.toBe(2);
	const second = await page.evaluate(() => (window as any).voiceMessages[1]);
	await frame.getByRole("button", { name: "Naia reads" }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).voiceMessages.length))
		.toBe(3);
	expect(
		await page.evaluate(() => (window as any).voiceMessages[2]),
	).toMatchObject({ type: "naia-cafelua-tarot:cancel", id: second.id });
	await frame.getByRole("button", { name: "Naia reads" }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).voiceMessages.length))
		.toBe(4);
	const retry = await page.evaluate(() => (window as any).voiceMessages[3]);
	expect(retry.text).toBe(second.text);
	await page.evaluate(
		(id) =>
			(
				document.querySelector("#tarot-test-frame") as HTMLIFrameElement
			).contentWindow!.postMessage(
				{ type: "naia-cafelua-tarot:speech-result", id, status: "failed" },
				"*",
			),
		retry.id,
	);
	await expect(frame.getByRole("status")).toContainText(
		"Could not start reading",
	);
	await frame.getByRole("button", { name: "Naia reads" }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).voiceMessages.length))
		.toBe(5);
	let count = 5;
	for (let i = 0; i < 100; i++) {
		const current = await page.evaluate(() =>
			(window as any).voiceMessages.at(-1),
		);
		await page.evaluate(
			(id) =>
				(
					document.querySelector("#tarot-test-frame") as HTMLIFrameElement
				).contentWindow!.postMessage(
					{ type: "naia-cafelua-tarot:speech-result", id, status: "finished" },
					"*",
				),
			current.id,
		);
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => (window as any).voiceMessages.length)) >
						count ||
					(await frame
						.getByRole("status")
						.filter({ hasText: "chapter is finished" })
						.isVisible()),
			)
			.toBe(true);
		const newCount = await page.evaluate(
			() => (window as any).voiceMessages.length,
		);
		if (newCount === count) break;
		count = newCount;
	}
	await expect(frame.getByRole("status")).toContainText("chapter is finished");
	await expect(frame.locator(".naia-reading-highlight")).toHaveCount(0);
});
