async function invoke(command: string, args: Record<string, unknown>) {
 return browser.execute(async (name: string, input: Record<string, unknown>) => {
  const candidate = window as typeof window & { __TAURI_INTERNALS__?: { invoke: (n: string, a: unknown) => Promise<unknown> }; __TAURI__?: { core?: { invoke: (n: string, a: unknown) => Promise<unknown> } } };
  const fn = candidate.__TAURI_INTERNALS__?.invoke ?? candidate.__TAURI__?.core?.invoke;
  if (!fn) throw new Error("Tauri invoke unavailable");
  return fn(name, input);
 }, command, args);
}

describe("Radio queue through the isolated native Tauri Shell", () => {
 it("starts the owned built BGM sidecar without using the user port", async () => {
  const port = Number(process.env.NAIA_E2E_BGM_PORT ?? "18772");
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  expect(response.status).toBe(200);
  const health = await response.json();
  expect(health).toMatchObject({ ok: true });
  expect(health.nonce).toEqual(expect.any(String));
 });
 it("keeps B queued until the active fixture reports ended, then advances to B", async () => {
  const appRoot = await $(".app-root");
  await appRoot.waitForExist({ timeout: 30_000 });
  expect(await appRoot.getAttribute("data-ui-mode")).not.toBe("setup");
  const player = await $(".bgm-player");
  try {
   await player.waitForExist({ timeout: 30_000 });
  } catch (error) {
   const documentState = await browser.execute(() => ({ href: document.location.href, bodyText: document.body?.innerText?.slice(0, 2000) ?? "", rootHtml: document.getElementById("root")?.innerHTML.slice(0, 4000) ?? "" }));
   let browserLogs: unknown = [];
   try { browserLogs = await browser.getLogs("browser"); } catch { /* browser log endpoint is optional */ }
   throw new Error(`BGM player did not mount: ${String(error)}; document=${JSON.stringify(documentState)}; browserLogs=${JSON.stringify(browserLogs)}`);
  }
  await invoke("e2e_emit_bgm_event", { action: "play", videoId: "native-a", title: "Native Queue A" });
  await browser.waitUntil(async () => (await player.getAttribute("data-bgm-current-title")) === "Native Queue A", { timeout: 30_000, timeoutMsg: "A did not mount" });
  await invoke("e2e_emit_bgm_event", { action: "enqueue", videoId: "native-b", title: "Native Queue B" });
  expect(await player.getAttribute("data-bgm-current-title")).toBe("Native Queue A");
  expect(await player.getAttribute("data-bgm-queue-length")).toBe("1");
  const iframe = await $(".app-bg-iframe");
  await iframe.waitForExist({ timeout: 30_000 });
  expect(await iframe.getAttribute("src")).toContain("bgm-playback-fixture.html");
  await browser.switchToFrame(iframe);
  await $("#report-playing").click();
  await $("#report-ended").click();
  await browser.switchToParentFrame();
  await browser.waitUntil(async () => (await player.getAttribute("data-bgm-current-title")) === "Native Queue B", { timeout: 30_000, timeoutMsg: "B did not advance after observed end" });
  expect(await player.getAttribute("data-bgm-queue-length")).toBe("0");
  await invoke("e2e_emit_bgm_event", { action: "stop" });
  await browser.waitUntil(async () => (await player.getAttribute("data-bgm-playback-status")) === "ended", { timeout: 30_000, timeoutMsg: "stop did not end the active playback" });
  expect(await player.getAttribute("data-bgm-queue-length")).toBe("0");
 });
});