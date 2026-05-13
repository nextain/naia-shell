/**
 * echo-aec.spec.ts — Browser-level AEC (Acoustic Echo Cancellation) test
 *
 * Issue #22: Audio echo — speaker output feeds back into microphone
 *
 * Verifies that browser's WebRTC AEC filters speaker output from mic input
 * when echoCancellation constraint is enabled in getUserMedia.
 *
 * How it works:
 *   1. pactl module-remap-source creates a mic source from speaker monitor
 *   2. Browser plays 440Hz sine tone via Web Audio API
 *   3. Tone goes to speakers → monitor → echo_source → getUserMedia
 *   4. FFT analysis checks if 440Hz is present in the mic capture
 *   5. WITHOUT echoCancellation: tone leaks through (echo bug)
 *   6. WITH echoCancellation: browser AEC filters the tone
 *
 * Prerequisites:
 *   - PipeWire + PulseAudio compat (pactl)
 *   - Vite dev server on :1420 (auto-started by playwright config)
 *
 * Run: pnpm test:e2e -- echo-aec.spec.ts
 */

import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const TONE_HZ = 440;
const SAMPLE_RATE = 48000;
const CAPTURE_DURATION_MS = 3000;
const ORIGINAL_SOURCE = "alsa_input.pci-0000_05_00.6.HiFi__Mic1__source";

let moduleId: string | null = null;

test.use({
	launchOptions: {
		args: [
			"--autoplay-policy=no-user-gesture-required",
			"--use-fake-ui-for-media-stream",
		],
	},
});

// Requires PipeWire/PulseAudio (pactl) + the physical ALSA mic referenced in
// ORIGINAL_SOURCE. Gated on NAIA_E2E_AUDIO=1 — without it the test fails on
// missing audio gear and reports misleading -Infinity dB ratios.
test.describe("Echo Cancellation (Issue #22)", () => {
	test.skip(!process.env.NAIA_E2E_AUDIO, "skipped without NAIA_E2E_AUDIO=1 (needs PipeWire + ALSA mic)");
	test.beforeAll(() => {
		// Create a PulseAudio source from the speaker's monitor output
		// This is Chromium-compatible (unlike pw-loopback virtual sources)
		try {
			const result = execSync(
				"pactl load-module module-remap-source " +
					"master=alsa_output.pci-0000_05_00.6.HiFi__Speaker__sink.monitor " +
					"source_name=echo_source " +
					"source_properties=device.description=EchoMonitorSource",
				{ encoding: "utf-8" },
			).trim();
			moduleId = result;
		} catch {
			// Module might already be loaded
		}
		execSync("pactl set-default-source echo_source");
	});

	test.afterAll(() => {
		// Restore original default source and unload module
		try {
			execSync(`pactl set-default-source ${ORIGINAL_SOURCE}`);
		} catch {
			/* best effort */
		}
		if (moduleId) {
			try {
				execSync(`pactl unload-module ${moduleId}`);
			} catch {
				/* best effort */
			}
		}
	});

	test("without echoCancellation — tone SHOULD leak into mic", async ({
		page,
	}) => {
		await page.goto("/");
		await page.waitForTimeout(2000);
		await page.click("body");

		const result = await page.evaluate(
			async (opts) => {
				const { toneHz, sampleRate, durationMs } = opts;

				// Find EchoMonitorSource device
				const devices = await navigator.mediaDevices.enumerateDevices();
				const echoDevice = devices.find(
					(d) => d.kind === "audioinput" && d.label.includes("EchoMonitor"),
				);
				if (!echoDevice) {
					return {
						error: "EchoMonitorSource not found",
						inputs: devices
							.filter((d) => d.kind === "audioinput")
							.map((d) => d.label),
						peak: 0,
						noiseFloor: 0,
						ratio: 0,
					};
				}

				// Play sine tone
				const playCtx = new AudioContext({ sampleRate });
				if (playCtx.state === "suspended") await playCtx.resume();
				const osc = playCtx.createOscillator();
				osc.frequency.value = toneHz;
				const gain = playCtx.createGain();
				gain.gain.value = 0.5;
				osc.connect(gain);
				gain.connect(playCtx.destination);
				osc.start();

				// Capture WITHOUT echoCancellation from echo monitor
				const stream = await navigator.mediaDevices.getUserMedia({
					audio: {
						deviceId: { exact: echoDevice.deviceId },
						echoCancellation: false,
						noiseSuppression: false,
						autoGainControl: false,
					},
				});
				const captureCtx = new AudioContext({ sampleRate });
				if (captureCtx.state === "suspended") await captureCtx.resume();
				const source = captureCtx.createMediaStreamSource(stream);
				const analyser = captureCtx.createAnalyser();
				analyser.fftSize = 4096;
				analyser.smoothingTimeConstant = 0;
				source.connect(analyser);

				await new Promise((r) => setTimeout(r, durationMs));

				const freqData = new Float32Array(analyser.frequencyBinCount);
				analyser.getFloatFrequencyData(freqData);

				const binWidth = sampleRate / analyser.fftSize;
				const targetBin = Math.round(toneHz / binWidth);

				// Peak at tone frequency ±3 bins
				let peak = Number.NEGATIVE_INFINITY;
				for (let i = targetBin - 3; i <= targetBin + 3; i++) {
					if (i >= 0 && i < freqData.length && freqData[i] > peak) {
						peak = freqData[i];
					}
				}

				// Noise floor: median of bins far from tone
				const noiseBins: number[] = [];
				for (let i = 20; i < freqData.length; i++) {
					if (
						Math.abs(i - targetBin) > 30 &&
						freqData[i] > Number.NEGATIVE_INFINITY
					) {
						noiseBins.push(freqData[i]);
					}
				}
				noiseBins.sort((a, b) => a - b);
				const noiseFloor =
					noiseBins.length > 0
						? noiseBins[Math.floor(noiseBins.length / 2)]
						: -100;

				osc.stop();
				stream.getTracks().forEach((t) => t.stop());
				await playCtx.close();
				await captureCtx.close();

				return {
					peak: Math.round(peak * 10) / 10,
					noiseFloor: Math.round(noiseFloor * 10) / 10,
					ratio: Math.round((peak - noiseFloor) * 10) / 10,
				};
			},
			{
				toneHz: TONE_HZ,
				sampleRate: SAMPLE_RATE,
				durationMs: CAPTURE_DURATION_MS,
			},
		);

		console.log("WITHOUT echoCancellation:", result);

		// 440Hz tone should be clearly above noise floor (>60dB = echo exists)
		expect(result.ratio).toBeGreaterThan(60);
	});

	test("with echoCancellation — tone should be filtered by AEC", async ({
		page,
	}) => {
		await page.goto("/");
		await page.waitForTimeout(2000);
		await page.click("body");

		const result = await page.evaluate(
			async (opts) => {
				const { toneHz, sampleRate, durationMs } = opts;

				const devices = await navigator.mediaDevices.enumerateDevices();
				const echoDevice = devices.find(
					(d) => d.kind === "audioinput" && d.label.includes("EchoMonitor"),
				);
				if (!echoDevice) {
					return {
						error: "EchoMonitorSource not found",
						peak: 0,
						noiseFloor: 0,
						ratio: 0,
					};
				}

				// Play sine tone
				const playCtx = new AudioContext({ sampleRate });
				if (playCtx.state === "suspended") await playCtx.resume();
				const osc = playCtx.createOscillator();
				osc.frequency.value = toneHz;
				const gain = playCtx.createGain();
				gain.gain.value = 0.5;
				osc.connect(gain);
				gain.connect(playCtx.destination);
				osc.start();

				// Capture WITH echoCancellation
				const stream = await navigator.mediaDevices.getUserMedia({
					audio: {
						deviceId: { exact: echoDevice.deviceId },
						echoCancellation: true,
						noiseSuppression: false,
						autoGainControl: false,
					},
				});
				const captureCtx = new AudioContext({ sampleRate });
				if (captureCtx.state === "suspended") await captureCtx.resume();
				const source = captureCtx.createMediaStreamSource(stream);
				const analyser = captureCtx.createAnalyser();
				analyser.fftSize = 4096;
				analyser.smoothingTimeConstant = 0;
				source.connect(analyser);

				await new Promise((r) => setTimeout(r, durationMs));

				const freqData = new Float32Array(analyser.frequencyBinCount);
				analyser.getFloatFrequencyData(freqData);

				const binWidth = sampleRate / analyser.fftSize;
				const targetBin = Math.round(toneHz / binWidth);

				let peak = Number.NEGATIVE_INFINITY;
				for (let i = targetBin - 3; i <= targetBin + 3; i++) {
					if (i >= 0 && i < freqData.length && freqData[i] > peak) {
						peak = freqData[i];
					}
				}

				const noiseBins: number[] = [];
				for (let i = 20; i < freqData.length; i++) {
					if (
						Math.abs(i - targetBin) > 30 &&
						freqData[i] > Number.NEGATIVE_INFINITY
					) {
						noiseBins.push(freqData[i]);
					}
				}
				noiseBins.sort((a, b) => a - b);
				const noiseFloor =
					noiseBins.length > 0
						? noiseBins[Math.floor(noiseBins.length / 2)]
						: -100;

				osc.stop();
				stream.getTracks().forEach((t) => t.stop());
				await playCtx.close();
				await captureCtx.close();

				return {
					peak: Math.round(peak * 10) / 10,
					noiseFloor: Math.round(noiseFloor * 10) / 10,
					ratio: Math.round((peak - noiseFloor) * 10) / 10,
				};
			},
			{
				toneHz: TONE_HZ,
				sampleRate: SAMPLE_RATE,
				durationMs: CAPTURE_DURATION_MS,
			},
		);

		console.log("WITH echoCancellation:", result);

		// AEC should suppress the tone — ratio should drop significantly
		// Digital loopback has residual (~30dB) but real acoustic echo is suppressed more.
		// The key: WITHOUT=128dB vs WITH=31dB → 94dB suppression proves AEC works.
		expect(result.ratio).toBeLessThan(60);
	});
});
