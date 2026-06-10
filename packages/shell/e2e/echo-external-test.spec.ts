import { execSync, spawn } from "node:child_process";
import { expect, test } from "@playwright/test";

test.use({
	launchOptions: {
		args: [
			"--autoplay-policy=no-user-gesture-required",
			"--use-fake-ui-for-media-stream",
		],
	},
});

// Requires pw-loopback + pactl + a working virtual source. Gated on NAIA_E2E_AUDIO=1.
test.skip(!process.env.NAIA_E2E_AUDIO, "skipped without NAIA_E2E_AUDIO=1");
test("capture external audio via loopback", async ({ page }) => {
	// Setup loopback
	const lb = spawn("pw-loopback", [
		"--capture-props=stream.capture.sink=true",
		"--playback-props=media.class=Audio/Source/Virtual,node.name=naia-echo-test",
	]);
	await new Promise((r) => setTimeout(r, 1000));
	execSync("pactl set-default-source naia-echo-test");

	await page.goto("/");
	await page.waitForTimeout(2000);
	await page.click("body");

	// Start capturing in browser, then play external audio
	const resultPromise = page.evaluate(async () => {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		const ctx = new AudioContext();
		if (ctx.state === "suspended") await ctx.resume();
		const source = ctx.createMediaStreamSource(stream);
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 256;
		source.connect(analyser);

		const maxValues: number[] = [];
		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 250));
			const data = new Uint8Array(analyser.frequencyBinCount);
			analyser.getByteFrequencyData(data);
			maxValues.push(Math.max(...data));
		}

		stream.getTracks().forEach((t) => t.stop());
		await ctx.close();
		return { maxValues, hasAudio: maxValues.some((v) => v > 10) };
	});

	// Play external audio after 1 second delay
	await new Promise((r) => setTimeout(r, 1000));
	execSync('espeak-ng "Testing echo loopback one two three" 2>/dev/null');

	const result = await resultPromise;
	console.log("External audio test:", result);

	lb.kill();
	execSync(
		"pactl set-default-source alsa_input.pci-0000_05_00.6.HiFi__Mic1__source 2>/dev/null || true",
	);

	expect(result.hasAudio).toBe(true);
});
