from pathlib import Path
#!/usr/bin/env python3
import importlib.util
import re
import subprocess
import unittest
from types import SimpleNamespace
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    "run_30m_runsheet",
    str(Path(__file__).with_name("run-30m-runsheet.py")),
)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class TestRadioRunsheetFixes(unittest.TestCase):
    def test_1_sliding_history_window_caps_input_tokens_under_6000(self):
        hw = runner.SlidingHistoryWindow(
            max_input_tokens=6000,
            overhead_tokens=4200,
            max_turns=3,
            max_single_prompt_tokens=650,
        )
        for i in range(1, 15):
            long_prompt = (
                f"[라디오 큐 {i:02d}:00 코너 진행] 청취자 사연과 질문을 읽고 따뜻하게 공감해 주세요. "
                * 12
            )
            bounded_prompt, effective_new_chat, est_tokens = hw.prepare_turn(
                f"코너 {i}", long_prompt, requested_new_chat=False
            )
            self.assertLessEqual(
                est_tokens,
                6000,
                f"Turn {i} exceeded 6000 input token cap: {est_tokens}",
            )
            if i == 4:
                self.assertTrue(
                    effective_new_chat,
                    "Turn 4 must automatically slide window and start a new chat with summary prefix",
                )
                self.assertIn("[이전 코너 요약:", bounded_prompt)
            hw.record_turn(
                f"코너 {i}",
                bounded_prompt,
                "네, 사연 잘 읽었어요. 따뜻한 음악과 함께 위로해 드릴게요. " * 6,
                failed=False,
            )

    def test_2_wait_for_next_cue_honours_an_explicit_idle_cap(self):
        # Cue finished at elapsed=1223s, next cue at 1320s; a caller that passes a cap gets it.
        slept_chunks = []
        fake_now = [1000.0 + 1223.0]

        def mock_now():
            return fake_now[0]

        def mock_sleep(sec):
            slept_chunks.append(sec)
            fake_now[0] += sec

        runner.HISTORY_WINDOW.last_turn_failed = False
        total_slept = runner.wait_for_next_cue(
            target_elapsed_sec=1320.0,
            max_idle_sec=15.0,
            start_ts=1000.0,
            now_fn=mock_now,
            sleep_fn=mock_sleep,
        )
        # Must cap at 15.0s instead of waiting 97.0s!
        self.assertEqual(total_slept, 15.0)
        self.assertLess(total_slept, 20.0)

    def test_3_wait_for_next_cue_waits_to_the_cue_even_after_a_fallback(self):
        fake_now = [1000.0 + 1223.0]

        def mock_sleep(sec):
            fake_now[0] += sec

        runner.HISTORY_WINDOW.last_turn_failed = True
        try:
            total_slept = runner.wait_for_next_cue(
                target_elapsed_sec=1320.0,
                start_ts=1000.0,
                now_fn=lambda: fake_now[0],
                sleep_fn=mock_sleep,
            )
        finally:
            runner.HISTORY_WINDOW.last_turn_failed = False
        self.assertEqual(total_slept, 97.0)
        self.assertEqual(fake_now[0] - 1000.0, 1320.0)

        skipped = runner.wait_for_next_cue(
            target_elapsed_sec=1320.0, force_immediate=True, start_ts=1000.0,
            now_fn=lambda: 2223.0, sleep_fn=lambda s: self.fail("must not sleep"),
        )
        self.assertEqual(skipped, 0.0)

    def test_4_send_chat_recovers_or_speaks_fallback_immediately_on_400_or_timeout(self):
        hw = runner.SlidingHistoryWindow()
        calls = []

        # Case A: First call returns "답을 만들다 실패했어요. 다시 시도할까요?", retry succeeds
        def mock_runner_retry_ok(cmd, **_kwargs):
            calls.append(cmd)
            if len(calls) == 1:
                return SimpleNamespace(stdout="답을 만들다 실패했어요. 다시 시도할까요?")
            return SimpleNamespace(stdout="채팅으로 남겨 주신 이야기를 만나 볼게요. 반갑습니다!")

        saved_send = runner.SEND_SCRIPT
        runner.SEND_SCRIPT = "/custom/send.sh"
        try:
            out_a = runner.send_chat(
                "코너 ③ 청취자 채팅",
                "20:00 시험 채팅 1",
                "질문 프롬프트",
                wait_sec=18,
                new_chat=False,
                history_window=hw,
                runner_fn=mock_runner_retry_ok,
                eval_fn=lambda _js: "[]",
                retry_on_error=True,
            )
        finally:
            runner.SEND_SCRIPT = saved_send
        self.assertIn("채팅으로 남겨 주신 이야기를 만나 볼게요", out_a)
        # the retry uses the same RADIO_SEND_SCRIPT as the first try
        self.assertEqual([c[0] for c in calls], ["/custom/send.sh", "/custom/send.sh"])
        self.assertFalse(hw.last_turn_failed)

        # Case B: TimeoutExpired -> corner fallback line, shown and played as audio
        def mock_runner_timeout(_cmd, **_kwargs):
            raise subprocess.TimeoutExpired(cmd="jun-send-nz.sh", timeout=18)

        played = []

        out_b = runner.send_chat(
            "코너 ③ 청취자 채팅",
            "22:00 시험 채팅 2",
            "두 번째 질문 프롬프트",
            wait_sec=18,
            new_chat=False,
            history_window=hw,
            runner_fn=mock_runner_timeout,
            eval_fn=lambda _js: "[]",
            retry_on_error=True,
            play_fn=lambda path, label: played.append(path) or True,
        )
        self.assertTrue(out_b.startswith("[FALLBACK]"))
        self.assertIn("채팅으로 남겨 주신 이야기 고마워요", out_b)
        self.assertTrue(hw.last_turn_failed)
        self.assertEqual(len(played), 1)
        self.assertTrue(played[0].endswith("fallback-corner3-chat.wav"))



    def test_5_tts_telemetry_and_explicit_error_reason(self):
        self.assertEqual(runner.classify_error_reason("정상 발화 대본입니다."), "NONE")
        self.assertEqual(runner.classify_error_reason("", timed_out=True), "TURN_TIMEOUT")
        self.assertEqual(runner.classify_error_reason("400 Bad Request: maximum context length"), "HTTP_400_CONTEXT_LENGTH")
        self.assertEqual(runner.classify_error_reason("답을 만들다 실패했어요. 다시 시도할까요?"), "UI_AGENT_ERROR_BANNER")
        self.assertEqual(runner.classify_error_reason("   "), "EMPTY_RESPONSE")

        def mock_eval(js):
            if "snapshot" in js:
                return '{"is_speaking":false,"tts_start_ts":"2026-11-09T18:30:02.100+09:00","tts_end_ts":"2026-11-09T18:30:14.600+09:00","tts_dur_sec":12.5,"utterance_count":3}'
            return "[]"

        info = runner.collect_tts_telemetry(eval_fn=mock_eval, wait_until_done_sec=1.0)
        self.assertEqual(info["tts_start_ts"], "2026-11-09T18:30:02.100+09:00")
        self.assertEqual(info["tts_end_ts"], "2026-11-09T18:30:14.600+09:00")
        self.assertEqual(info["tts_dur_sec"], 12.5)
        self.assertEqual(info["utterance_count"], 3)

    def test_6_preflight_lists_every_missing_dependency(self):
        saved = (runner.BASE_DIR, runner.WK_SCRIPT, runner.SEND_SCRIPT, runner.BGM_DIR)
        try:
            runner.BASE_DIR = "/radio"
            runner.WK_SCRIPT = "/radio/wk.mjs"
            runner.SEND_SCRIPT = "/radio/jun-send-nz.sh"
            runner.BGM_DIR = "/radio/bgm"
            present = {"/radio/wk.mjs", "/radio/bgm/Afternoon Whispers.mp3"}
            missing = runner.preflight(
                which_fn=lambda name: None if name == "ffmpeg" else "/usr/bin/" + name,
                exists_fn=lambda path: path in present,
            )
        finally:
            runner.BASE_DIR, runner.WK_SCRIPT, runner.SEND_SCRIPT, runner.BGM_DIR = saved

        joined = "\n".join(missing)
        self.assertIn("ffmpeg not found", joined)
        self.assertIn("/radio/jun-send-nz.sh", joined)
        self.assertNotIn("/radio/wk.mjs", joined)
        self.assertNotIn("Afternoon Whispers", joined)
        self.assertEqual(sum(1 for m in missing if m.startswith("song not found")), 3)

        saved_base = runner.BASE_DIR
        try:
            runner.BASE_DIR = ""
            self.assertIn("RADIO_BASE_DIR is not set", runner.preflight(lambda n: "/x", lambda p: True))
        finally:
            runner.BASE_DIR = saved_base

    def test_7_ffmpeg_failure_is_not_logged_as_finished(self):
        logs = []
        saved_log, saved_wk = runner.log, runner.wk_eval
        runner.log = logs.append
        runner.wk_eval = lambda js: "0.35"
        try:
            failed = runner.play_song_file(
                "/missing.mp3", "song",
                runner_fn=lambda *a, **k: SimpleNamespace(returncode=1, stderr="No such file"),
            )
            ok = runner.play_song_file(
                "/ok.mp3", "song",
                runner_fn=lambda *a, **k: SimpleNamespace(returncode=0, stderr=""),
            )
        finally:
            runner.log, runner.wk_eval = saved_log, saved_wk

        self.assertFalse(failed)
        self.assertTrue(ok)
        self.assertTrue(any(l.startswith("FAILED song playback") and "rc=1" in l for l in logs))
        self.assertEqual(sum(1 for l in logs if l.startswith("Finished song playback")), 1)

    def test_8_fallback_is_spoken_and_captioned_without_an_error_node(self):
        scripts, played = [], []

        def page_without_error_node(js):
            scripts.append(js)
            return "caption_added"

        result = runner.speak_fallback_utterance(
            "코너 ② 사연", "대체 문장", eval_fn=page_without_error_node,
            play_fn=lambda path, label: played.append(path) or True,
        )
        self.assertEqual(result, "spoken")
        self.assertTrue(played[0].endswith("fallback-corner2-story.wav"))
        self.assertIn("naia-radio-fallback-caption", scripts[0])
        self.assertIn('"대체 문장"', scripts[0])

        unknown = []
        runner.speak_fallback_utterance(
            "없는 코너", "x", eval_fn=lambda js: "", play_fn=lambda p, l: unknown.append(p) or True,
        )
        self.assertTrue(unknown[0].endswith("fallback-default.wav"))

        # audio failure is reported, not hidden
        self.assertEqual(
            runner.speak_fallback_utterance("클로징", "x", eval_fn=lambda js: "", play_fn=lambda p, l: False),
            "caption_only",
        )

    def test_9_preflight_requires_every_fallback_audio_file(self):
        self.assertEqual(set(runner.FALLBACK_AUDIO_FILES), set(runner.FALLBACK_UTTERANCES))
        saved = runner.FALLBACK_AUDIO_DIR
        try:
            runner.FALLBACK_AUDIO_DIR = "/radio/fallback"
            missing = runner.preflight(lambda n: "/x", lambda p: not p.endswith("fallback-quiz.wav"))
        finally:
            runner.FALLBACK_AUDIO_DIR = saved
        self.assertEqual(
            [m for m in missing if m.startswith("fallback audio")],
            ["fallback audio not found: /radio/fallback/fallback-quiz.wav"],
        )

    def _run_on_fake_clock(self, song_len_sec, turn_sec):
        """Run the whole show on a fake clock; return (cues, songs, end_elapsed)."""
        clock = SimpleNamespace(now=50_000.0)
        fake_time = SimpleNamespace(
            time=lambda: clock.now,
            sleep=lambda sec: setattr(clock, "now", clock.now + sec),
        )
        start = clock.now
        cues, songs = [], []

        def fake_send_chat(situation, trigger, prompt_text, **_kw):
            cues.append((trigger, clock.now - start))
            clock.now += turn_sec
            return "ok"

        def fake_play(path, label, max_duration_sec=None, loop=False, **_kw):
            began = clock.now - start
            length = max_duration_sec if loop else min(song_len_sec, max_duration_sec or song_len_sec)
            clock.now += length
            songs.append((label, began, clock.now - start, loop))
            return True

        with mock.patch.object(runner, "time", fake_time), \
                mock.patch.object(runner, "send_chat", fake_send_chat), \
                mock.patch.object(runner, "play_song_file", fake_play), \
                mock.patch.object(runner, "set_bgm_volume", lambda v: None), \
                mock.patch.object(runner, "check_health", lambda tag: None), \
                mock.patch.object(runner, "log", lambda msg: None), \
                mock.patch.dict(runner.os.environ, {"RADIO_START_TS": ""}):
            runner.run_broadcast()
        return cues, songs, clock.now - start

    def test_10_fake_clock_every_cue_hits_its_named_time_and_show_ends_at_30_00(self):
        cue_re = re.compile(r"^(\d\d):(\d\d) ")
        for song_len, turn in ((40, 12), (400, 12), (150, 25)):
            with self.subTest(song_len=song_len, turn=turn):
                cues, songs, end = self._run_on_fake_clock(song_len, turn)
                self.assertEqual(len(cues), 21)
                for trigger, at in cues:
                    m = cue_re.match(trigger)
                    self.assertIsNotNone(m, f"cue name has no clock time: {trigger}")
                    named = int(m.group(1)) * 60 + int(m.group(2))
                    self.assertEqual(at, named, f"{trigger} went out at {at:.0f}s")
                for label, began, ended, _loop in songs[:-1]:
                    next_cue = min(at for _t, at in cues if at >= began)
                    self.assertLessEqual(ended, next_cue, f"{label} ran past the next cue")
                encore = songs[-1]
                self.assertTrue(encore[0].startswith("Closing Encore") and encore[3])
                self.assertEqual(encore[2], runner.SHOW_END_SEC)
                self.assertEqual(end, runner.SHOW_END_SEC)


if __name__ == "__main__":
    unittest.main(verbosity=2)
