from pathlib import Path
#!/usr/bin/env python3
import importlib.util
import subprocess
import unittest
from types import SimpleNamespace

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

    def test_2_wait_for_next_cue_prevents_97s_dead_air_loop(self):
        # Reproduce exact 12:08:55 -> 12:10:32 KST scenario:
        # Cue finished at elapsed=1223s, next cue scheduled at 1320s (97s gap!)
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

    def test_3_wait_for_next_cue_skips_wait_immediately_after_fallback(self):
        slept_chunks = []
        runner.HISTORY_WINDOW.last_turn_failed = True
        total_slept = runner.wait_for_next_cue(
            target_elapsed_sec=1320.0,
            max_idle_sec=15.0,
            start_ts=1000.0,
            now_fn=lambda: 2223.0,
            sleep_fn=lambda s: slept_chunks.append(s),
        )
        self.assertEqual(total_slept, 0.0)
        self.assertEqual(len(slept_chunks), 0)
        runner.HISTORY_WINDOW.last_turn_failed = False

    def test_4_send_chat_recovers_or_speaks_fallback_immediately_on_400_or_timeout(self):
        hw = runner.SlidingHistoryWindow()
        calls = []

        # Case A: First call returns "답을 만들다 실패했어요. 다시 시도할까요?", retry succeeds
        def mock_runner_retry_ok(cmd, **_kwargs):
            calls.append(cmd)
            if len(calls) == 1:
                return SimpleNamespace(stdout="답을 만들다 실패했어요. 다시 시도할까요?")
            return SimpleNamespace(stdout="채팅으로 남겨 주신 이야기를 만나 볼게요. 반갑습니다!")

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
        self.assertIn("채팅으로 남겨 주신 이야기를 만나 볼게요", out_a)
        self.assertFalse(hw.last_turn_failed)

        # Case B: TimeoutExpired -> immediate corner fallback utterance + 0s next corner wait
        def mock_runner_timeout(_cmd, **_kwargs):
            raise subprocess.TimeoutExpired(cmd="jun-send-nz.sh", timeout=18)

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
        )
        self.assertTrue(out_b.startswith("[FALLBACK]"))
        self.assertIn("채팅으로 남겨 주신 이야기 고마워요", out_b)
        self.assertTrue(hw.last_turn_failed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
