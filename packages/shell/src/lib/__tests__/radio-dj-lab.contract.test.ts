import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createVirtualClock,
	createDeterministicRun,
	loadLabConfig,
	sanitizeEvent,
	writeDeterministicRun,
} from "../../../../../scripts/radio-dj-lab.mjs";
import { sanitizeRadioDjLabEvent } from "../radio-dj-lab-observer";

const configPath = new URL(
	"../../../../../scripts/radio-dj-lab-example.json",
	import.meta.url,
).pathname;

describe("Radio DJ Lab contract", () => {
	it("uses the baseline input, virtual clock and unscored unset thresholds", async () => {
		const config = await loadLabConfig(configPath);
		const { events, judgement } = createDeterministicRun(config);

		expect(config.opening_utterance).toBe("일하면서 뭐라도 얘기해봐");
		expect(events.length).toBe(15);
		expect(events).toEqual(createDeterministicRun(config).events);
		expect(events.every((event, index) => event.sequence === index + 1)).toBe(
			true,
		);
		expect(
			events.every((event) => event.run_id === "deterministic-seed-76201"),
		).toBe(true);
		expect(events.every((event) => event.mode === "deterministic")).toBe(true);
		expect(events.every((event) => event.clock_domain === "virtual")).toBe(
			true,
		);
		expect(judgement.error_count).toBe(0);
		expect(
			judgement.checks.find((check) => check.check_id === "ui-state-observed")
				?.status,
		).toBe("pass");
		expect(judgement.metrics.first_playback_after_request_ms).toBe(2800);
		expect(judgement.metrics.voice_music_overlap_ms).toBe(1200);
		expect(
			judgement.checks
				.filter((check) => check.check_id.startsWith("threshold."))
				.every((check) => check.status === "unscored"),
		).toBe(true);
		expect(judgement.checks[0]).toMatchObject({
			check_id: "baseline-opening-turn",
			observed: true,
			status: "pass",
			evidence_event_ids: ["evt-002"],
		});
		expect(judgement.checks.every((check) =>
			[
				"check_id",
				"observed",
				"threshold_key",
				"threshold",
				"unit",
				"status",
				"evidence_event_ids",
				"note",
			].every((field) => field in check),
		)).toBe(true);
		const configuredThresholds = createDeterministicRun({
			...config,
			thresholds: {
				...config.thresholds,
				max_first_playback_ms: 2_800,
				max_voice_music_overlap_ms: 1_200,
				min_playing_ms: 1,
			},
		}).judgement.checks;
		expect(
			configuredThresholds.find(
				(check) => check.check_id === "threshold.max_first_playback_ms",
			)?.status,
		).toBe("pass");
		expect(
			configuredThresholds.find(
				(check) => check.check_id === "threshold.min_playing_ms",
			)?.status,
		).toBe("unscored");
	});

	it("drops unapproved event fields such as text, titles, URLs and tool payloads", () => {
		const event = sanitizeEvent("bgm.playback", {
			status: "playing",
			source: "youtube",
			track_id: "FAKE76201xx",
			title: "private title",
			url: "https://example.invalid/private?token=secret",
			message: "private conversation text",
		});

		expect(event).toEqual({
			event_type: "bgm.playback",
			data: {
				status: "playing",
				source: "youtube",
				track_id: "FAKE76201xx",
			},
		});
		expect(
			sanitizeEvent("bgm.playback", {
				status: "playing",
				source: "youtube",
				track_id: "not-a-video-id",
			})?.data,
		).not.toHaveProperty("track_id");
		expect(
			sanitizeRadioDjLabEvent("ui.state", {
				surface: "bgm_player",
				state: "playback_status_refreshed",
				playback_status: "playing",
				text: "private chat content",
				url: "https://example.invalid/private",
			}),
		).toEqual({
			event_type: "ui.state",
			data: {
				surface: "bgm_player",
				state: "playback_status_refreshed",
				playback_status: "playing",
			},
		});
	});

	it("pauses and resumes without advancing virtual time while paused", () => {
		const clock = createVirtualClock();
		expect(clock.advanceBy(250)).toBe(250);
		clock.pause();
		expect(clock.advanceBy(5_000)).toBe(250);
		expect(clock.isPaused()).toBe(true);
		clock.resume();
		expect(clock.advanceBy(500)).toBe(750);
		expect(clock.isPaused()).toBe(false);
	});

	it("writes a short artifact set without live service calls", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "radio-dj-lab-contract-"));
		try {
			const config = await loadLabConfig(configPath);
			const result = await writeDeterministicRun(config, join(tempRoot, "run"));
			const manifest = JSON.parse(
				await readFile(join(result.outputDir, "manifest.json"), "utf8"),
			);
			const checks = JSON.parse(
				await readFile(join(result.outputDir, "checks.json"), "utf8"),
			);
			const wav = await readFile(join(result.outputDir, "fixture-tone.wav"));
			const timeline = await readFile(
				join(result.outputDir, "timeline.svg"),
				"utf8",
			);

			expect(manifest.external_network_calls).toBe(0);
			expect(checks).toEqual(result.judgement.checks);
			expect(manifest.downstream_adapter_contract.memory_input_context_type).toBe(
				"string",
			);
			expect(manifest.downstream_adapter_contract.memory_write_performed).toBe(
				false,
			);
			expect(manifest.actual_llm_calls).toBe(0);
			expect(manifest.fixture_audio.kind).toBe("synthetic-tone-not-speech");
			expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
			expect(timeline).toContain("bgm.playback");
			expect(timeline).toContain("5400 ms");
			expect(
				await readFile(join(result.outputDir, "events.jsonl"), "utf8"),
			).toContain('"clock_domain":"virtual"');
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});
