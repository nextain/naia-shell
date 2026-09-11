import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// FR-VOICE.16 Phase 2b (#420): the sentence routing policy moved from
// ChatArea.sendSentenceToTts into lib/tts/sentence-pipeline. The contract
// semantics are unchanged — this file just reads the new owner, and now ALSO
// pins ChatArea down to a pure delegation (no synthesis side channels).

function pipelineSource(): string {
	return readFileSync(
		resolve(__dirname, "../../tts/sentence-pipeline.ts"),
		"utf8",
	);
}

function chatAreaSendSentenceSource(): string {
	const chatArea = readFileSync(
		resolve(__dirname, "../../../components/ChatArea.tsx"),
		"utf8",
	);
	const start = chatArea.indexOf("function sendSentenceToTts");
	const end = chatArea.indexOf("function cleanupPipeline", start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	return chatArea.slice(start, end);
}

function slidesSource(): string {
	return readFileSync(
		resolve(__dirname, "../../../apps/slides/SlidesCenterArea.tsx"),
		"utf8",
	);
}

describe("Shell TTS single-ownership speech routing contract", () => {
	it("only bypasses Shell synthesis for an authored NVA clip match", () => {
		const source = pipelineSource();
		const authoredClipGate = source.indexOf("hasAuthoredClip(clean)");
		const authoredClipCall = source.indexOf(".playAuthoredClip(clean");
		const shellSynthesis = source.indexOf("synthesizeTts({");

		expect(authoredClipGate).toBeGreaterThanOrEqual(0);
		expect(authoredClipCall).toBeGreaterThan(authoredClipGate);
		expect(shellSynthesis).toBeGreaterThan(authoredClipCall);
		expect(source.slice(authoredClipCall, shellSynthesis)).toContain("return;");
	});

	it("never lets the NVA renderer synthesize dynamic speech itself", () => {
		const source = pipelineSource();

		// The old hijack called the renderer directly with no audio for every
		// sentence, skipping Shell synthesis entirely. That path is gone.
		expect(source).not.toContain(".speak(clean, undefined");
		expect(source).not.toContain("speakAudio(");
		expect(source).not.toContain('encoding: "LINEAR16"');
	});

	it("drives NVA visual state from Shell's own playback lifecycle, not synthesis", () => {
		const source = pipelineSource();
		expect(source).toContain("setSpeakingVisual(true)");
		expect(source).toContain("setSpeakingVisual(false)");
	});

	it("ChatArea delegates every sentence to the pipeline with no side channel", () => {
		const source = chatAreaSendSentenceSource();
		expect(source).toContain("sentencePipelineRef.current?.sendSentence(");
		// Phase 3 direction pinned now: the component must not synthesize,
		// speak, or drive the renderer directly from the send path.
		expect(source).not.toContain("synthesizeTts(");
		expect(source).not.toContain("speechSynthesis");
		expect(source).not.toContain("playAuthoredClip");
	});

	it("Phase 3: no component speaks outside the pipeline (allowlisted previews only)", () => {
		// Consumers (components, skills) must use the pipeline's public
		// interface for conversational speech. The only allowed direct speech
		// surfaces are settings/onboarding VOICE PREVIEWS — they demo a voice,
		// they do not speak chat content:
		//  - SettingsTab.tsx: TTS provider preview (getPreviewText)
		//  - OnboardingWizard.tsx: system-voice preview (FR-VOICE-ONBOARD.1)
		const componentsDir = resolve(__dirname, "../../../components");
		const previewAllowlist = new Set([
			"SettingsTab.tsx",
			"OnboardingWizard.tsx",
		]);
		const offenders: string[] = [];
		for (const file of readdirSync(componentsDir)) {
			if (!/\.tsx?$/.test(file) || previewAllowlist.has(file)) continue;
			const source = readFileSync(resolve(componentsDir, file), "utf8");
			for (const forbidden of [
				"synthesizeTts(",
				"speechSynthesis.speak(",
				".playAuthoredClip(",
			]) {
				if (source.includes(forbidden)) offenders.push(`${file}: ${forbidden}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("routes slide narration through ChatArea instead of a Slides audio side channel", () => {
		const slides = slidesSource();
		const chatArea = readFileSync(
			resolve(__dirname, "../../../components/ChatArea.tsx"),
			"utf8",
		);
		for (const forbidden of [
			"synthesizeTts(",
			"speechSynthesis.speak(",
			"new Audio(",
		]) {
			expect(slides).not.toContain(forbidden);
		}
		expect(slides).toContain("requestSlidePresenterSpeech({");
		expect(chatArea).toContain(
			"window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, handleSpeak)",
		);
		// FR-VOICE.20 (2026-09-11): the page's narration is split into sentences
		// and fed to the same pipeline one at a time, so the first sentence can
		// play while the rest are still being synthesized. The routing contract
		// is unchanged — every piece still goes through sendSentenceToTts, and
		// the text still comes from the presenter event's own detail.
		expect(chatArea).toContain("splitSlideNarration(detail.text.trim())");
		expect(chatArea).toContain("sendSentenceToTts(piece)");
		expect(chatArea).toContain('settleSlidePresenterSpeech("finished")');
	});
});
