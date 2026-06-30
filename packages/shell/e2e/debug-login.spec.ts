import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const MOCK = `
(function() {
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = { currentWindow:{label:"main"}, currentWebview:{windowLabel:"main",label:"main"} };
  var callbacks=new Map(), nextId=1;
  window.__TAURI_INTERNALS__.transformCallback=function(fn,once){var id=nextId++;callbacks.set(id,function(d){if(once)callbacks.delete(id);return fn&&fn(d);});return id;};
  window.__TAURI_INTERNALS__.unregisterCallback=function(id){callbacks.delete(id);};
  window.__TAURI_INTERNALS__.runCallback=function(id,d){var cb=callbacks.get(id);if(cb)cb(d);};
  window.__TAURI_INTERNALS__.callbacks=callbacks;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener=function(){};
  window.__TAURI_INTERNALS__.convertFileSrc=function(p,proto){return (proto||"asset")+"://localhost/"+p;};
  window.__ipcLog=[];
  window.__TAURI_INTERNALS__.invoke=async function(cmd,args){
    window.__ipcLog.push({cmd,args:args||{}});
    if(cmd==="plugin:event|listen"){var el=window.__TAURI_EVENT_PLUGIN_INTERNALS__;el.__ls=el.__ls||{};el.__ls[args.event]=el.__ls[args.event]||[];el.__ls[args.event].push(args.handler);return args.handler;}
    if(cmd.startsWith("plugin:event|")) return null;
    if(cmd.startsWith("plugin:window|")) return null;
    if(cmd.startsWith("plugin:store|")) return null;
    if(cmd==="frontend_log") return;
    if(cmd==="list_skills") return [];
    if(cmd==="list_stt_models") return [];
    if(cmd==="panel_list_installed") return [];
    if(cmd==="browser_check") return true;
    if(cmd==="browser_embed_port") return 19222;
    if(cmd==="browser_embed_navigate") return;
    if(cmd.startsWith("browser_embed")) return;
    if(cmd==="check_gateway_status") return false;
    if(cmd.startsWith("workspace_")) return [];
    if(cmd==="list_audio_output_devices") return [];
    if(cmd==="plugin:opener|open_url") return;
    return undefined;
  };
})();
`;

test("debug: settings lab login IPC trace", async ({ page }) => {
	await page.addInitScript(MOCK);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript(() => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "e2e-mock",
				locale: "ko",
				onboardingComplete: true,
			}),
		);
	});

	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 15000 });

	// Open settings via the AppBar settings button (.app-bar-settings)
	const gearBtn = page.locator(".app-bar-settings");
	await gearBtn.click();
	await page.waitForTimeout(800);
	await page.screenshot({ path: "_results_/s1-settings-open.png" });

	// Scroll down to find Naia Lab section
	const settingsPanel = page
		.locator(".settings-panel, [class*='settings'], [class*='Settings']")
		.first();
	if ((await settingsPanel.count()) > 0) {
		await settingsPanel.evaluate((el) => (el.scrollTop = 0));
	}

	// Find all buttons visible now
	const allBtns = await page.locator("button:visible").all();
	const btnTexts = await Promise.all(allBtns.map((b) => b.textContent()));
	console.log(
		"Visible buttons:",
		btnTexts.filter((t) => t?.trim()).join(" | "),
	);

	// Clear log and click the Naia/Lab login button
	await page.evaluate(() => {
		(window as any).__ipcLog = [];
	});

	const loginBtn = page
		.locator("button:visible")
		.filter({ hasText: /Naia|Lab|로그인|Login|연결|Connect/i })
		.first();
	const cnt = await loginBtn.count();
	console.log("Login btn count:", cnt);

	if (cnt > 0) {
		console.log("Login btn text:", await loginBtn.textContent());
		const disabled = await loginBtn.getAttribute("disabled");
		console.log("Disabled:", disabled);
		await loginBtn.click({ force: true });
		await page.waitForTimeout(1500);

		const ipcLog = await page.evaluate(() =>
			((window as any).__ipcLog as { cmd: string; args: any }[]).map(
				(e) => `${e.cmd}${e.args?.url ? "(" + e.args.url + ")" : ""}`,
			),
		);
		console.log("IPC after click:", ipcLog.join(" -> "));
		await page.screenshot({ path: "_results_/s2-after-login-click.png" });
	} else {
		// Look in the whole page text
		const bodyText = await page.locator("body").innerText();
		console.log("Body snippet:", bodyText.slice(0, 1000));
		await page.screenshot({ path: "_results_/s1-settings-open.png" });
	}
});
