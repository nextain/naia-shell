import { describe, expect, it, vi } from "vitest";
import {
	SPEECH_UNITS,
	validateSpeechPlan,
} from "../../avatar/nva-speech/vendor/speech-plan.js";
import {
	AZURE_VISEME_TABLE,
	type AvatarLipSyncFrame,
	AzureVisemeTimelineDriver,
	Pcm16AmplitudeTracker,
	azureTicksToMs,
	azureTicksToUs,
	computePcm16Rms,
	getAzureVisemeSpec,
	normalizeAzureVisemeId,
	sampleAnalyserNodeLipSync,
	visemeIdToAvatarFrame,
	visemesToSpeechPlan,
} from "../azure-speech-viseme";

describe("azure-speech-viseme", () => {
	it("maps every Microsoft Viseme ID 0..21 to valid mouthOpen, VRM weights, and canonical NVA SpeechUnit", () => {
		expect(AZURE_VISEME_TABLE).toHaveLength(22);
		const validUnits = new Set<string>(SPEECH_UNITS);

		for (let id = 0; id <= 21; id++) {
			const spec = getAzureVisemeSpec(id);
			expect(spec.visemeId).toBe(id);
			expect(spec.mouthOpen).toBeGreaterThanOrEqual(0);
			expect(spec.mouthOpen).toBeLessThanOrEqual(1);
			expect(validUnits.has(spec.nvaUnit)).toBe(true);
			for (const weight of Object.values(spec.vrmWeights)) {
				expect(weight).toBeGreaterThanOrEqual(0);
				expect(weight).toBeLessThanOrEqual(1);
			}
		}

		// Viseme 0: silence -> closed & not talking
		const sil = visemeIdToAvatarFrame(0);
		expect(sil.mouthOpen).toBe(0);
		expect(sil.talking).toBe(false);
		expect(sil.nvaUnit).toBe("sil");

		// Viseme 2: open vowel /aa/ -> wide jaw opening + strong `aa`
		const aa = visemeIdToAvatarFrame(2, 120);
		expect(aa.mouthOpen).toBeGreaterThan(0.85);
		expect(aa.vrmWeights.aa).toBeGreaterThan(0.9);
		expect(aa.talking).toBe(true);
		expect(aa.nvaUnit).toBe("vowel-open");

		// Viseme 7: rounded /w, uw/ -> strong `ou` + negative rounded mouthForm
		const uw = visemeIdToAvatarFrame(7, 200);
		expect(uw.vrmWeights.ou).toBeGreaterThan(0.85);
		expect(uw.live2dMouthForm).toBeLessThan(-0.5);
		expect(uw.nvaUnit).toBe("vowel-round");

		// Viseme 21: bilabial /p, b, m/ -> mouthOpen 0 for crisp closure while talking=true
		const bilabial = visemeIdToAvatarFrame(21, 300);
		expect(bilabial.mouthOpen).toBe(0);
		expect(bilabial.talking).toBe(true);
		expect(bilabial.nvaUnit).toBe("closed");

		// Out-of-bounds clamp safely to 0
		expect(normalizeAzureVisemeId(-5)).toBe(0);
		expect(normalizeAzureVisemeId(99)).toBe(0);
		expect(normalizeAzureVisemeId(Number.NaN)).toBe(0);
	});

	it("converts Azure 100ns AudioOffset ticks to milliseconds and microseconds", () => {
		expect(azureTicksToMs(0)).toBe(0);
		expect(azureTicksToMs(500_000)).toBe(50);
		expect(azureTicksToMs(12_345_000)).toBeCloseTo(1234.5, 5);
		expect(azureTicksToUs(500_000)).toBe(50_000);
		expect(azureTicksToMs(-100)).toBe(0);
	});

	it("builds a canonical NVA SpeechPlan that passes validateSpeechPlan", () => {
		const audioSha = "a".repeat(64);
		const plan = visemesToSpeechPlan(
			[
				{ offsetMs: 60, visemeId: 2 },
				{ offsetMs: 180, visemeId: 21 },
				{ offsetMs: 195, visemeId: 6 }, // 15ms short event -> normalized cleanly
				{ offsetMs: 360, visemeId: 8 },
				{ offsetMs: 520, visemeId: 0 },
			],
			{
				text: "안녕하세요",
				durationMs: 650,
				audioSha256: audioSha,
			},
		);

		expect(plan).not.toBeNull();
		const check = validateSpeechPlan(plan);
		expect(check).toEqual({ ok: true, errors: [] });
		expect(plan?.audio.sha256).toBe(audioSha);
		expect(plan?.audio.duration_us).toBe(650_000);
		expect(plan?.events[0].start_us).toBe(0);
		expect(plan?.events[plan.events.length - 1].end_us).toBe(650_000);
	});

	it("synchronizes Viseme timeline to SpeechClock with coarticulation, silence hold, and stop reset", () => {
		const frames: AvatarLipSyncFrame[] = [];
		const talkingTransitions: boolean[] = [];
		const tickHolder: { current: (() => void) | null } = { current: null };
		let currentSec = 0;

		const driver = new AzureVisemeTimelineDriver({
			coarticulationMs: 40,
			silenceHoldMs: 100,
			onFrame: (f) => frames.push(f),
			onTalkingChange: (t) => talkingTransitions.push(t),
			scheduler: {
				request: (cb) => {
					tickHolder.current = cb;
					return 1;
				},
				cancel: () => {
					tickHolder.current = null;
				},
			},
		});

		// Push out-of-order viseme events to verify automatic sorting
		driver.pushVisemes([
			{ offsetMs: 200, visemeId: 6 },
			{ offsetMs: 50, visemeId: 2 },
			{ offsetMs: 300, visemeId: 21 },
			{ offsetMs: 400, visemeId: 0 },
		]);

		driver.start(() => currentSec);
		expect(driver.getCurrentFrame().talking).toBe(false);

		// Advance clock to 70ms -> active Viseme 2 (/aa/)
		currentSec = 0.07;
		tickHolder.current?.();
		expect(driver.getCurrentFrame().visemeId).toBe(2);
		expect(driver.getCurrentFrame().talking).toBe(true);
		expect(driver.getCurrentFrame().mouthOpen).toBeGreaterThan(0.85);
		expect(talkingTransitions).toEqual([true]);

		// Advance clock to 220ms -> halfway through 40ms coarticulation from 2 -> 6
		currentSec = 0.22;
		tickHolder.current?.();
		const blended = driver.getCurrentFrame();
		expect(blended.visemeId).toBe(6);
		expect(blended.mouthOpen).toBeGreaterThan(getAzureVisemeSpec(6).mouthOpen);
		expect(blended.mouthOpen).toBeLessThan(getAzureVisemeSpec(2).mouthOpen);

		// Advance clock to 305ms -> Viseme 21 (/p,b,m/) snaps mouthOpen to 0 immediately
		currentSec = 0.305;
		tickHolder.current?.();
		expect(driver.getCurrentFrame().visemeId).toBe(21);
		expect(driver.getCurrentFrame().mouthOpen).toBe(0);
		expect(driver.getCurrentFrame().talking).toBe(true);

		// Advance clock to 450ms -> 50ms into silence (< 100ms silenceHoldMs -> still talking)
		currentSec = 0.45;
		tickHolder.current?.();
		expect(driver.getCurrentFrame().mouthOpen).toBe(0);
		expect(driver.getCurrentFrame().talking).toBe(true);

		// Advance clock to 520ms -> 120ms into silence (>= 100ms -> talking becomes false)
		currentSec = 0.52;
		tickHolder.current?.();
		expect(driver.getCurrentFrame().talking).toBe(false);
		expect(talkingTransitions).toEqual([true, false]);

		// Restart speech then force stop() -> immediate reset to idle
		currentSec = 0.1;
		driver.sampleAt(100);
		expect(driver.getCurrentFrame().talking).toBe(true);
		driver.stop();
		expect(driver.getCurrentFrame().mouthOpen).toBe(0);
		expect(driver.getCurrentFrame().talking).toBe(false);
		expect(talkingTransitions).toEqual([true, false, true, false]);
		expect(frames.length).toBeGreaterThan(5);
	});

	it("generates fallback amplitude lip-sync cues from PCM16 audio and Web Audio AnalyserNode", () => {
		const sampleRate = 24000;
		const activeChunk = new Int16Array(2400); // 100ms of 440Hz loud sine wave
		for (let i = 0; i < activeChunk.length; i++) {
			activeChunk[i] = Math.round(
				Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 18000,
			);
		}
		const silentChunk = new Int16Array(2400); // 100ms digital silence

		expect(computePcm16Rms(activeChunk)).toBeGreaterThan(0.35);
		expect(computePcm16Rms(silentChunk)).toBe(0);

		const tracker = new Pcm16AmplitudeTracker(sampleRate, { windowMs: 25 });
		const activeCues = tracker.pushChunk(activeChunk);
		const silentCues = tracker.pushChunk(silentChunk);
		const tailCues = tracker.flush();

		expect(activeCues.length).toBe(4);
		expect(activeCues.some((c) => c.talking && c.mouthOpen > 0.3)).toBe(true);
		expect(tailCues[tailCues.length - 1].mouthOpen).toBe(0);

		// Drive timeline driver purely via fallback amplitude cues (no visemes)
		const driver = new AzureVisemeTimelineDriver();
		driver.pushAmplitudeCues([...activeCues, ...silentCues, ...tailCues]);
		expect(driver.hasVisemes()).toBe(false);

		const midActive = driver.sampleAt(60);
		expect(midActive.source).toBe("amplitude");
		expect(midActive.talking).toBe(true);
		expect(midActive.mouthOpen).toBeGreaterThan(0.25);

		// Web Audio AnalyserNode fallback (both Float32 and Uint8 time-domain APIs)
		const floatAnalyser = {
			fftSize: 128,
			getFloatTimeDomainData: vi.fn((arr: Float32Array) => {
				for (let i = 0; i < arr.length; i++) {
					arr[i] = Math.sin((2 * Math.PI * i) / 16) * 0.5;
				}
			}),
		};
		const floatFrame = sampleAnalyserNodeLipSync(floatAnalyser, 150);
		expect(floatFrame.source).toBe("amplitude");
		expect(floatFrame.talking).toBe(true);
		expect(floatFrame.mouthOpen).toBeGreaterThan(0.4);

		const byteAnalyser = {
			fftSize: 128,
			getByteTimeDomainData: vi.fn((arr: Uint8Array) => {
				arr.fill(128); // centered silence
			}),
		};
		const byteSilentFrame = sampleAnalyserNodeLipSync(byteAnalyser, 200);
		expect(byteSilentFrame.talking).toBe(false);
		expect(byteSilentFrame.mouthOpen).toBe(0);
	});
});
