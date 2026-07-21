import { describe, expect, it, vi } from "vitest";
import {
	activateMicUnlessSpeechActivityOwnsVoice,
	canSpeakProactiveText,
	parseSpeechProfileCommand,
	resolveSpeechProfileSession,
	shouldAbortLiveConnectForSpeechActivity,
	shouldBlockDirectLiveForSpeechActivity,
	shouldQueueBeforeSpeechYield,
} from "../speech-profile-commands";

describe("speech profile spoken commands", () => {
	it("starts the two explicit MVP profiles", () => {
		expect(parseSpeechProfileCommand("개인 라디오 시작해")).toEqual({
			kind: "configure",
			profile: "personal_radio_dj",
		});
		expect(parseSpeechProfileCommand("행사 소개 시작")).toEqual({
			kind: "configure",
			profile: "exhibition_intro",
		});
	});

	it("maps every closed DJ control without intercepting ordinary chat", () => {
		const cases = [
			["음악만 틀어줘", "music_only"],
			["말 줄여", "talk_less"],
			["계속 이야기해", "talk_more"],
			["분위기 바꿔줘", "change_vibe"],
			["다음 곡 틀어줘", "next"],
			["그만해", "stop"],
		] as const;
		for (const [phrase, action] of cases) {
			expect(parseSpeechProfileCommand(phrase)).toEqual({
				kind: "control",
				action,
			});
		}
		expect(parseSpeechProfileCommand("다시 소개해")).toEqual({
			kind: "control",
			action: "restart",
		});
		expect(parseSpeechProfileCommand("오늘 들을 음악을 추천해줘")).toBeUndefined();
		expect(parseSpeechProfileCommand("그만해라는 표현의 뜻이 뭐야?")).toBeUndefined();
		expect(parseSpeechProfileCommand("다른 분위기에 대해 이야기해줘")).toBeUndefined();
	});

	it("successful resume uses the bound profile session, never rotating chat session", () => {
		expect(resolveSpeechProfileSession("chat-random", {
			sessionId: "agent:main:main",
			activityId: "activity-1",
			profileGeneration: 2,
			yieldGeneration: 1,
			resumeToken: "single-use",
		})).toBe("agent:main:main");
	});

	it("blocks direct Live/omni while a grounded speech activity owns the voice lane", () => {
		expect(shouldBlockDirectLiveForSpeechActivity(true, true)).toBe(true);
		expect(shouldBlockDirectLiveForSpeechActivity(true, false)).toBe(false);
		expect(shouldBlockDirectLiveForSpeechActivity(false, true)).toBe(false);
	});

	it("drops deferred proactive TTS when ordinary chat starts during config load", () => {
		expect(canSpeakProactiveText({
			currentRequestId: "chat-started-after-event",
			activeActivityId: "dj-1",
			eventActivityId: "dj-1",
			ttsEnabled: true,
		})).toBe(false);
		expect(canSpeakProactiveText({
			currentRequestId: null,
			activeActivityId: "dj-1",
			eventActivityId: "dj-1",
			ttsEnabled: true,
		})).toBe(true);
	});

	it("queues before issuing a single-use yield and rechecks Live connect ownership", () => {
		expect(shouldQueueBeforeSpeechYield(true)).toBe(true);
		expect(shouldQueueBeforeSpeechYield(false)).toBe(false);
		expect(shouldAbortLiveConnectForSpeechActivity(true)).toBe(true);
		expect(shouldAbortLiveConnectForSpeechActivity(false)).toBe(false);
	});

	it("discards a microphone created after speech activity took the voice lane", () => {
		const mic = {
			start: vi.fn(),
			stop: vi.fn(),
		};

		expect(activateMicUnlessSpeechActivityOwnsVoice(mic, true, true)).toBe(false);
		expect(mic.start).not.toHaveBeenCalled();
		expect(mic.stop).toHaveBeenCalledTimes(1);
	});
});
