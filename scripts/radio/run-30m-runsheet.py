#!/usr/bin/env python3
"""
Naia Radio 30-Minute Broadcast Runsheet Runner (v3 — 2026-11-09, Show 2 Clean Verification)
Fixes:
1. vLLM max_model_len=8192 (400 Bad Request) prevention:
   - Korean-aware token estimator (`estimate_tokens`) + `SlidingHistoryWindow` capping
     total input tokens (system/tools overhead + recent turns + prompt) at <= 6,000 tokens
     (with >= 2,192 output token headroom below 8,192).
   - Automatic sliding window reset + compact `[이전 코너 요약]` header when accumulated
     turns exceed `MAX_HISTORY_TURNS = 3` or `MAX_INPUT_TOKENS = 6000`.
2. Cue timing:
   - Every cue waits for its own clock time (`wait_for_next_cue(target)`, no idle cap by
     default), so 10:00·20:00·28:00 go out at 10:00·20:00·28:00, not early. The 97-second
     gap of show 1 was a late turn, not the wait; BGM keeps playing during any wait.
   - Songs are cut at the next cue (`play_song_until`), and the closing encore loops until
     exactly 30:00 even when the file is shorter.
   - `send_chat()` enforces a strict turn timeout (`TURN_TIMEOUT_SEC = 18`), detects
     LLM 400 / `"답을 만들다 실패했어요"` immediately, attempts 1 compact retry or speaks a
     corner-specific fallback line (`FALLBACK_UTTERANCES`).
3. Fallback lines are heard, not only shown: a pre-rendered audio file per line
   (`RADIO_FALLBACK_AUDIO_DIR/<FALLBACK_AUDIO_FILES>`) is played into the song sink, and
   the text is shown as a caption even when the app shows no error node.
"""
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

# Machine paths come from the environment (see runsheet.example.env); no personal defaults.
BASE_DIR = os.environ.get("RADIO_BASE_DIR") or ""
OUT_DIR = os.environ.get("RADIO_OUT_DIR") or (os.path.join(BASE_DIR, "rtmp", "recordings") if BASE_DIR else "")
SHOW_TAG = os.environ.get("RADIO_SHOW_TAG") or "show2-20261109"
RUNSHEET_LOG = f"{OUT_DIR}/radio-{SHOW_TAG}-runsheet.log"
TRAINING_JSONL = f"{OUT_DIR}/training-{SHOW_TAG}.jsonl"
SUMMARY_JSON = f"{OUT_DIR}/radio-{SHOW_TAG}-summary.json"
NODE = os.environ.get("RADIO_NODE") or "node"
WK_SCRIPT = os.environ.get("RADIO_WK_SCRIPT") or os.path.join(BASE_DIR, "wk.mjs")
SEND_SCRIPT = os.environ.get("RADIO_SEND_SCRIPT") or os.path.join(BASE_DIR, "jun-send-nz.sh")
BGM_DIR = os.environ.get("RADIO_BGM_DIR") or os.path.join(BASE_DIR, "home", "naia-adk", "naia-settings", "bgm-musics")
PULSE_UID = os.environ.get("RADIO_PULSE_UID") or str(os.getuid())
SONG_FILES = (
    "naia-radio-its-okay-to-turn-off-the-light-ko.mp3",
    "naia-radio-its-okay-to-turn-off-the-light-en.mp3",
    "Afternoon Whispers.mp3",
    "Shattered Reflection.mp3",
)

# Token budget constants for vLLM max_model_len=8192
MAX_MODEL_LEN = 8192
MAX_INPUT_TOKENS = 6000
SYSTEM_AND_TOOLS_OVERHEAD_TOKENS = 4200
MAX_CONVERSATION_TOKENS = MAX_INPUT_TOKENS - SYSTEM_AND_TOOLS_OVERHEAD_TOKENS  # 1800 tokens
MAX_SINGLE_PROMPT_TOKENS = 650
MAX_SUMMARY_TOKENS = 180
MAX_HISTORY_TURNS = 3

# Corner transition & timeout constants
MAX_CORNER_IDLE_SEC = None  # no cap: cues wait for their own clock time
TURN_TIMEOUT_SEC = 18
SHOW_END_SEC = 1800

CJK_HANGUL_RE = re.compile(r"[\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FF\u4E00-\u9FFF\u3040-\u30FF]")

ERROR_MARKERS = (
    "답을 만들다 실패했어요",
    "다시 시도할까요",
    "400 Bad Request",
    "maximum context length",
    "input_tokens",
    "provider returned reasoning",
    "ERR:",
)

FALLBACK_UTTERANCES = {
    "오프닝": "안녕하세요, 나이아예요. 오늘 나이아 라디오 시험 방송에서 음악과 이야기로 편안한 시간 함께해요.",
    "코너 ① 오늘의 질문": "요즘 바쁜 일상 속에서도 잠시 숨을 고르는 시간이 참 소중한 것 같아요. 이어서 다음 이야기로 가 볼게요.",
    "날씨·안부": "바쁜 하루 중에도 나이아 라디오와 함께해 주셔서 고마워요. 잠깐 어깨 힘 빼고 편하게 들어 주세요.",
    "선곡 ①": "오늘 사연과 마음을 담아 준비한 한국어 곡 「불을 꺼도 돼요」 함께 들으셨어요.",
    "코너 ② 사연": "보내 주신 시험 사연 잘 읽었어요. 퇴근길 지친 마음이 조금이나마 가벼워지길 바라며 응원할게요.",
    "선곡 ②": "이번에는 같은 사연으로 만든 영어 곡 「It's Okay to Turn Off the Light」를 함께 들어볼게요.",
    "코너 ③ 청취자 채팅": "채팅으로 남겨 주신 이야기 고마워요. 오늘 시험 방송이라 설레는 마음으로 여러분과 함께하고 있어요.",
    "질문지": "확실하게 기억나지 않는 내용은 추측하지 않고 솔직하게 말씀드릴게요. 다음 이야기로 이어가 볼게요.",
    "클로징": "첫 시험 방송에 함께해 주셔서 고맙습니다. 나이아 라디오였습니다. 투자 및 승인 넥스테인·루크, PD 알파, 작가 지나, 방송 진행 나이아, 기술 지원 민호.",
    "default": "잠시 호흡을 가다듬고 다음 코너로 바로 이어갈게요. 편안하게 함께해 주세요.",
}

# Pre-rendered audio (show voice) for each fallback line, in RADIO_FALLBACK_AUDIO_DIR.
FALLBACK_AUDIO_DIR = os.environ.get("RADIO_FALLBACK_AUDIO_DIR") or (
    os.path.join(BASE_DIR, "fallback-audio") if BASE_DIR else ""
)
FALLBACK_AUDIO_FILES = {
    "오프닝": "fallback-opening.wav",
    "코너 ① 오늘의 질문": "fallback-corner1-question.wav",
    "날씨·안부": "fallback-greeting.wav",
    "선곡 ①": "fallback-song1.wav",
    "코너 ② 사연": "fallback-corner2-story.wav",
    "선곡 ②": "fallback-song2.wav",
    "코너 ③ 청취자 채팅": "fallback-corner3-chat.wav",
    "질문지": "fallback-quiz.wav",
    "클로징": "fallback-closing.wav",
    "default": "fallback-default.wav",
}

START_TS = int(os.environ.get("RADIO_START_TS") or time.time())


def estimate_tokens(text: str) -> int:
    """Estimate Qwen/vLLM token count for mixed Korean/ASCII strings."""
    if not text:
        return 0
    s = str(text)
    cjk_count = len(CJK_HANGUL_RE.findall(s))
    other_count = max(0, len(s) - cjk_count)
    return int(math.ceil(cjk_count * 1.15 + other_count * 0.25))


def truncate_text_to_tokens(text: str, max_tokens: int) -> str:
    """Truncate text preserving head and tail so estimated tokens <= max_tokens."""
    if not text or max_tokens <= 0:
        return ""
    s = str(text)
    est = estimate_tokens(s)
    if est <= max_tokens:
        return s
    marker = " ...[중략]... "
    target = max(8, max_tokens - estimate_tokens(marker))
    ratio = target / max(1, est)
    keep_chars = max(16, int(len(s) * ratio))
    head = max(10, int(keep_chars * 0.7))
    tail = max(6, keep_chars - head)
    return f"{s[:head]}{marker}{s[max(head, len(s) - tail):]}"


class SlidingHistoryWindow:
    """
    Maintains a sliding window of recent turns and enforces <= MAX_INPUT_TOKENS (6000)
    so vLLM (max_model_len=8192) never throws 400 Bad Request.
    """

    def __init__(
        self,
        max_input_tokens: int = MAX_INPUT_TOKENS,
        overhead_tokens: int = SYSTEM_AND_TOOLS_OVERHEAD_TOKENS,
        max_turns: int = MAX_HISTORY_TURNS,
        max_single_prompt_tokens: int = MAX_SINGLE_PROMPT_TOKENS,
    ):
        self.max_input_tokens = max_input_tokens
        self.overhead_tokens = overhead_tokens
        self.max_conversation_tokens = max(400, max_input_tokens - overhead_tokens)
        self.max_turns = max(1, max_turns)
        self.max_single_prompt_tokens = max_single_prompt_tokens
        self.active_turns = []  # list of (situation, user_text, assistant_text, tokens)
        self.archived_summaries = []  # compact 1-line recaps of dropped turns
        self.last_turn_failed = False

    def total_estimated_input_tokens(self, next_prompt_tokens: int = 0) -> int:
        hist_tokens = sum(t[3] for t in self.active_turns)
        return self.overhead_tokens + hist_tokens + next_prompt_tokens

    def _archive_oldest(self):
        while len(self.active_turns) >= self.max_turns:
            sit, u_txt, a_txt, _ = self.active_turns.pop(0)
            recap = truncate_text_to_tokens(f"[{sit}] {a_txt or u_txt}", 40)
            if recap:
                self.archived_summaries.append(recap)
                self.archived_summaries = self.archived_summaries[-4:]

    def build_summary_prefix(self) -> str:
        if not self.archived_summaries:
            return ""
        joined = " / ".join(self.archived_summaries[-3:])
        capped = truncate_text_to_tokens(joined, MAX_SUMMARY_TOKENS)
        return f"[이전 코너 요약: {capped}] "

    def prepare_turn(self, situation: str, prompt_text: str, requested_new_chat: bool = False):
        """
        Return (bounded_prompt, effective_new_chat, estimated_input_tokens).
        Guarantees estimated_input_tokens <= self.max_input_tokens (6000).
        """
        bounded_prompt = truncate_text_to_tokens(prompt_text, self.max_single_prompt_tokens)
        prompt_tokens = estimate_tokens(bounded_prompt) + 8

        effective_new_chat = bool(requested_new_chat or self.last_turn_failed)
        projected = self.total_estimated_input_tokens(prompt_tokens)

        if not effective_new_chat and (
            len(self.active_turns) >= self.max_turns or projected > self.max_input_tokens
        ):
            while self.active_turns:
                sit, u_txt, a_txt, _ = self.active_turns.pop(0)
                recap = truncate_text_to_tokens(f"[{sit}] {a_txt or u_txt}", 40)
                if recap:
                    self.archived_summaries.append(recap)
            self.archived_summaries = self.archived_summaries[-3:]
            effective_new_chat = True

        if effective_new_chat:
            self.active_turns.clear()
            summary_prefix = self.build_summary_prefix()
            if summary_prefix and not bounded_prompt.startswith("[이전 코너 요약:"):
                candidate = f"{summary_prefix}{bounded_prompt}"
                if estimate_tokens(candidate) <= self.max_single_prompt_tokens:
                    bounded_prompt = candidate
                    prompt_tokens = estimate_tokens(bounded_prompt) + 8

        allowed_prompt_tokens = max(
            64,
            self.max_input_tokens - self.overhead_tokens - sum(t[3] for t in self.active_turns) - 8,
        )
        if estimate_tokens(bounded_prompt) > allowed_prompt_tokens:
            bounded_prompt = truncate_text_to_tokens(bounded_prompt, allowed_prompt_tokens)
            prompt_tokens = estimate_tokens(bounded_prompt) + 8

        total_est = self.total_estimated_input_tokens(prompt_tokens)
        return bounded_prompt, effective_new_chat, total_est

    def record_turn(self, situation: str, prompt_text: str, response_text: str, failed: bool = False):
        self.last_turn_failed = failed
        if failed:
            return
        clean_resp = truncate_text_to_tokens(response_text or "", 220)
        turn_tokens = estimate_tokens(prompt_text) + estimate_tokens(clean_resp) + 12
        self._archive_oldest()
        self.active_turns.append((situation, prompt_text, clean_resp, turn_tokens))


HISTORY_WINDOW = SlidingHistoryWindow()


def log(msg):
    now_str = datetime.now().astimezone().isoformat(timespec="seconds")
    elapsed = int(time.time() - START_TS)
    mm, ss = divmod(max(0, elapsed), 60)
    line = f"[{now_str}] [+{mm:02d}:{ss:02d}] {msg}"
    print(line, flush=True)
    if not OUT_DIR:
        return
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(RUNSHEET_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def wk_eval(js_code):
    try:
        res = subprocess.run(
            [NODE, WK_SCRIPT, js_code],
            cwd=os.path.dirname(WK_SCRIPT) or None,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return res.stdout.strip()
    except Exception as e:
        return f"ERR: {e}"


def set_bgm_volume(vol):
    js = f"""(() => {{
      const a = document.querySelector("audio");
      if (a) {{
        a.loop = true;
        a.volume = {vol};
        if (a.paused && {vol} > 0) a.play().catch(()=>{{}});
      }}
      return a ? a.volume : -1;
    }})()"""
    out = wk_eval(js)
    log(f"BGM volume set to {vol} (actual={out})")


def preflight(which_fn=shutil.which, exists_fn=os.path.isfile):
    """Return a list of missing dependencies (empty when the runner can start)."""
    missing = []
    if not BASE_DIR:
        missing.append("RADIO_BASE_DIR is not set")
    if not which_fn(NODE):
        missing.append(f"node executable not found: {NODE}")
    if not which_fn("ffmpeg"):
        missing.append("ffmpeg not found on PATH")
    for path in (WK_SCRIPT, SEND_SCRIPT):
        if not exists_fn(path):
            missing.append(f"file not found: {path}")
    if exists_fn(SEND_SCRIPT) and not os.access(SEND_SCRIPT, os.X_OK):
        missing.append(f"not executable: {SEND_SCRIPT}")
    for name in SONG_FILES:
        path = os.path.join(BGM_DIR, name)
        if not exists_fn(path):
            missing.append(f"song not found: {path}")
    for name in FALLBACK_AUDIO_FILES.values():
        path = os.path.join(FALLBACK_AUDIO_DIR, name)
        if not exists_fn(path):
            missing.append(f"fallback audio not found: {path}")
    return missing


def play_song_file(mp3_path, label, max_duration_sec=None, runner_fn=subprocess.run, loop=False):
    """Play one song through PulseAudio. Returns True only when ffmpeg exits 0."""
    log(f"Starting song playback: {label} ({mp3_path})")
    set_bgm_volume(0.02)
    env = os.environ.copy()
    env["XDG_RUNTIME_DIR"] = f"/run/user/{PULSE_UID}"
    env["PULSE_SERVER"] = f"unix:/run/user/{PULSE_UID}/pulse/native"
    t0 = time.time()
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re"]
    if max_duration_sec:
        cmd += ["-t", str(max_duration_sec)]
    if loop:
        cmd += ["-stream_loop", "-1"]
    cmd += ["-i", mp3_path, "-af", "volume=0.65", "-f", "pulse", "naia-radio-song"]
    try:
        res = runner_fn(cmd, env=env, check=False, capture_output=True, text=True)
        rc, err = res.returncode, (res.stderr or "").strip()
    except OSError as e:
        rc, err = -1, str(e)
    dur = time.time() - t0
    set_bgm_volume(0.35)
    if rc != 0:
        log(f"FAILED song playback: {label} (rc={rc}, duration={dur:.1f}s, error={err[:200]})")
        return False
    log(f"Finished song playback: {label} (duration={dur:.1f}s)")
    return True


def play_song_until(mp3_path, label, end_elapsed_sec, loop=False, min_sec=5):
    """Play a song but stop at end_elapsed_sec (show clock) so the next cue is not pushed late."""
    rem = int(end_elapsed_sec - (time.time() - START_TS))
    if rem < min_sec:
        log(f"Skipping song {label}: only {rem}s left before cue at {end_elapsed_sec}s")
        return False
    return play_song_file(mp3_path, label, max_duration_sec=rem, loop=loop)


def classify_error_reason(raw_out: str, prompt_text: str = "", timed_out: bool = False) -> str:
    """Return an explicit, unambiguous failure reason code (or 'NONE' on success)."""
    if timed_out or (raw_out and "TimeoutExpired" in raw_out):
        return "TURN_TIMEOUT"
    if not raw_out or not raw_out.strip():
        return "EMPTY_RESPONSE"
    if any(m in raw_out for m in ("400 Bad Request", "maximum context length", "input_tokens")):
        return "HTTP_400_CONTEXT_LENGTH"
    if "provider returned reasoning" in raw_out:
        return "REASONING_TRUNCATION"
    if any(m in raw_out for m in ("답을 만들다 실패했어요", "다시 시도할까요")):
        return "UI_AGENT_ERROR_BANNER"
    if "ERR:" in raw_out:
        return "RUNNER_EXEC_ERROR"
    stripped = raw_out.strip()
    if prompt_text and stripped == prompt_text.strip():
        return "ECHO_PROMPT_ONLY"
    return "NONE"


def is_failed_response(raw_out: str, prompt_text: str = "") -> bool:
    """Detect empty output, LLM 400 error banner, or reasoning truncation failure."""
    return classify_error_reason(raw_out, prompt_text, timed_out=False) != "NONE"


def reset_tts_telemetry(eval_fn=wk_eval):
    eval_fn("""(() => {
      if (window.__naiaTtsTelemetry && typeof window.__naiaTtsTelemetry.reset === "function") {
        window.__naiaTtsTelemetry.reset();
        return "reset";
      }
      return "no_telemetry";
    })()""")


def collect_tts_telemetry(eval_fn=wk_eval, wait_until_done_sec: float = 8.0, sleep_fn=time.sleep) -> dict:
    """Poll window.__naiaTtsTelemetry until speaking finishes (up to wait_until_done_sec)."""
    deadline = time.time() + max(0.0, float(wait_until_done_sec))
    last_snap = {}
    while True:
        raw = eval_fn("""(() => {
          return window.__naiaTtsTelemetry && typeof window.__naiaTtsTelemetry.snapshot === "function"
            ? JSON.stringify(window.__naiaTtsTelemetry.snapshot())
            : "{}";
        })()""")
        try:
            unwrapped = json.loads(raw) if raw and raw.startswith('"') else raw
            snap = json.loads(unwrapped) if isinstance(unwrapped, str) else (unwrapped or {})
            if isinstance(snap, dict):
                last_snap = snap
        except Exception:
            pass
        if not last_snap.get("is_speaking") or time.time() >= deadline:
            break
        sleep_fn(0.4)
    return {
        "tts_start_ts": last_snap.get("tts_start_ts"),
        "tts_end_ts": last_snap.get("tts_end_ts"),
        "tts_dur_sec": float(last_snap.get("tts_dur_sec") or 0.0),
        "utterance_count": int(last_snap.get("utterance_count") or 0),
    }


def get_fallback_utterance(situation: str) -> str:
    return FALLBACK_UTTERANCES.get(situation, FALLBACK_UTTERANCES["default"])


def fallback_audio_path(situation: str) -> str:
    name = FALLBACK_AUDIO_FILES.get(situation, FALLBACK_AUDIO_FILES["default"])
    return os.path.join(FALLBACK_AUDIO_DIR, name)


def speak_fallback_utterance(situation: str, fallback_text: str, eval_fn=wk_eval, play_fn=None) -> str:
    """
    Speak a fallback line when LLM 400 or timeout occurs: show it on screen (replacing the
    error banner, or as a caption when there is none) and play its pre-rendered audio.
    Returns "spoken" or "caption_only" (audio failed; logged as FAILED).
    """
    log(f"FALLBACK [{situation}]: {fallback_text}")
    escaped = json.dumps(fallback_text, ensure_ascii=False)
    js = f"""(() => {{
      const nodes = [...document.querySelectorAll("p, div")];
      const errNode = nodes.find(el => el.innerText && el.innerText.includes("답을 만들다 실패했어요"));
      if (errNode) {{
        errNode.innerText = {escaped};
        return "replaced_error_node";
      }}
      let cap = document.getElementById("naia-radio-fallback-caption");
      if (!cap) {{
        cap = document.createElement("div");
        cap.id = "naia-radio-fallback-caption";
        cap.style.cssText = "position:fixed;left:5%;right:5%;bottom:12%;z-index:2147483647;padding:12px 18px;border-radius:12px;background:rgba(0,0,0,.72);color:#fff;font-size:22px;line-height:1.4;text-align:center";
        document.body.appendChild(cap);
      }}
      cap.innerText = {escaped};
      clearTimeout(window.__naiaRadioCaptionTimer);
      window.__naiaRadioCaptionTimer = setTimeout(() => cap.remove(), 20000);
      return "caption_added";
    }})()"""
    shown = eval_fn(js)
    play = play_fn or play_song_file
    audio = fallback_audio_path(situation)
    ok = play(audio, f"fallback voice [{situation}]")
    result = "spoken" if ok else "caption_only"
    log(f"FALLBACK [{situation}] screen={shown} audio={result}")
    return result


def send_chat(
    situation,
    trigger,
    prompt_text,
    wait_sec=TURN_TIMEOUT_SEC,
    new_chat=True,
    history_window: SlidingHistoryWindow = None,
    runner_fn=subprocess.run,
    eval_fn=wk_eval,
    retry_on_error=True,
    play_fn=None,
):
    hw = history_window or HISTORY_WINDOW
    bounded_prompt, effective_new_chat, est_input_tokens = hw.prepare_turn(
        situation, prompt_text, requested_new_chat=new_chat
    )
    effective_wait = min(int(wait_sec), TURN_TIMEOUT_SEC)
    log(
        f"SENDING [{situation} / {trigger}] (new={effective_new_chat}, "
        f"est_in_tokens={est_input_tokens}/{MAX_INPUT_TOKENS}, timeout={effective_wait}s): {bounded_prompt}"
    )
    t0 = time.time()
    turn_start_iso = datetime.now().astimezone().isoformat(timespec="milliseconds")
    reset_tts_telemetry(eval_fn=eval_fn)
    env = os.environ.copy()
    env["WAIT"] = str(effective_wait)
    cmd = [SEND_SCRIPT, bounded_prompt]
    if effective_new_chat:
        cmd.append("new")

    raw_out = ""
    timed_out = False
    try:
        res = runner_fn(
            cmd,
            cwd=BASE_DIR,
            env=env,
            capture_output=True,
            text=True,
            timeout=effective_wait + 8,
        )
        raw_out = (res.stdout or "").strip()
    except subprocess.TimeoutExpired:
        timed_out = True
        raw_out = "ERR: TimeoutExpired"
    except Exception as e:
        raw_out = f"ERR: {e}"

    initial_error_reason = classify_error_reason(raw_out, bounded_prompt, timed_out=timed_out)
    failed = initial_error_reason != "NONE"
    used_fallback = False
    error_reason = initial_error_reason

    if failed and retry_on_error and not timed_out:
        compact_prompt = truncate_text_to_tokens(prompt_text, 240)
        log(
            f"RETRYING [{situation} / {trigger}] (cause={initial_error_reason}) "
            f"with clean new_chat and compact prompt ({estimate_tokens(compact_prompt)} tok)"
        )
        retry_env = env.copy()
        retry_env["WAIT"] = "10"
        try:
            retry_res = runner_fn(
                [SEND_SCRIPT, compact_prompt, "new"],
                cwd=BASE_DIR,
                env=retry_env,
                capture_output=True,
                text=True,
                timeout=14,
            )
            retry_out = (retry_res.stdout or "").strip()
            retry_reason = classify_error_reason(retry_out, compact_prompt, timed_out=False)
            if retry_reason == "NONE":
                raw_out = retry_out
                failed = False
                error_reason = f"RECOVERED_FROM_{initial_error_reason}"
            else:
                error_reason = f"{initial_error_reason}->RETRY_{retry_reason}"
        except subprocess.TimeoutExpired:
            error_reason = f"{initial_error_reason}->RETRY_TURN_TIMEOUT"
        except Exception:
            error_reason = f"{initial_error_reason}->RETRY_EXEC_ERROR"

    if failed:
        fallback_line = get_fallback_utterance(situation)
        fallback_result = speak_fallback_utterance(situation, fallback_line, eval_fn=eval_fn, play_fn=play_fn)
        raw_out = f"[FALLBACK] {fallback_line}"
        used_fallback = True
        error_reason = f"{error_reason}->FALLBACK_{fallback_result.upper()}"

    tts_info = collect_tts_telemetry(eval_fn=eval_fn, wait_until_done_sec=0.0 if used_fallback else 8.0)
    turn_end_iso = datetime.now().astimezone().isoformat(timespec="milliseconds")
    tts_start_ts = tts_info.get("tts_start_ts") or turn_start_iso
    tts_end_ts = tts_info.get("tts_end_ts") or turn_end_iso
    tts_dur_sec = float(tts_info.get("tts_dur_sec") or 0.0)
    tts_utts = int(tts_info.get("utterance_count") or 0)

    hw.record_turn(situation, bounded_prompt, raw_out, failed=used_fallback)
    dt = time.time() - t0
    dom_extract = eval_fn("""(() => {
      const msgs = [...document.querySelectorAll("[data-message-role], .prose, main p")].map(e => e.innerText.trim()).filter(Boolean);
      return JSON.stringify(msgs.slice(-6));
    })()""")
    log(
        f"RESPONSE [{situation} / {trigger}] ({dt:.1f}s, fallback={used_fallback}, "
        f"tts_start_ts={tts_start_ts}, tts_end_ts={tts_end_ts}, tts_dur_sec={tts_dur_sec:.2f}s, "
        f"tts_utts={tts_utts}, error_reason={error_reason}): {raw_out}"
    )
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "elapsed_sec": int(time.time() - START_TS),
        "situation": situation,
        "trigger": trigger,
        "input": bounded_prompt,
        "estimated_input_tokens": est_input_tokens,
        "raw_output": raw_out,
        "used_fallback": used_fallback,
        "error_reason": error_reason,
        "tts_start_ts": tts_start_ts,
        "tts_end_ts": tts_end_ts,
        "tts_dur_sec": round(tts_dur_sec, 2),
        "tts_utterance_count": tts_utts,
        "dom_tail": dom_extract,
        "latency_sec": round(dt, 2),
    }
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(TRAINING_JSONL, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass
    return raw_out


def wait_for_next_cue(
    target_elapsed_sec: float,
    max_idle_sec: float = MAX_CORNER_IDLE_SEC,
    force_immediate: bool = False,
    start_ts: float = None,
    now_fn=None,
    sleep_fn=None,
) -> float:
    """
    Wait until the show clock reaches `target_elapsed_sec`, so a cue never goes out early.
    - A fallback turn does not skip the wait (that made the next cue early); only
      `force_immediate` does.
    - `max_idle_sec` (default None = no cap) is kept for callers that want a bounded wait.
    - If the clock is already past the target, logs how late the cue is and returns 0.0.
    Returns total seconds slept.
    """
    now_fn = now_fn or time.time
    sleep_fn = sleep_fn or time.sleep
    if force_immediate:
        log(f"Immediate corner transition to target={target_elapsed_sec}s (forced)")
        return 0.0

    ref_start = START_TS if start_ts is None else start_ts
    now_elapsed = now_fn() - ref_start
    rem = target_elapsed_sec - now_elapsed
    if rem <= 0:
        if rem < -5:
            log(f"Cue at target={target_elapsed_sec}s is {-rem:.1f}s late")
        return 0.0

    effective_wait = float(rem) if max_idle_sec is None else min(float(rem), float(max_idle_sec))
    if max_idle_sec is not None and rem > max_idle_sec:
        log(
            f"Capping inter-corner wait from {rem:.1f}s -> {effective_wait:.1f}s "
            f"(target={target_elapsed_sec}s) to prevent dead-air wait loop"
        )

    slept = 0.0
    while slept < effective_wait:
        step = min(1.0, effective_wait - slept)
        sleep_fn(step)
        slept += step
    return round(slept, 3)


def wait_until(target_elapsed_sec, max_idle_sec=MAX_CORNER_IDLE_SEC):
    return wait_for_next_cue(target_elapsed_sec, max_idle_sec=max_idle_sec)


def check_health(tag):
    try:
        with open(f"{BASE_DIR}/shell-box-pr836.log", "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
        timeouts = content.count("NVA playback start timeout")
        fallbacks = content.count("using still image after media failure")
        http400 = content.count("400 Bad Request")
    except Exception:
        timeouts, fallbacks, http400 = -1, -1, -1
    a_state = wk_eval("""(() => {
      const a = document.querySelector("audio");
      const v = document.querySelector("canvas[data-video-avatar-prebaked]");
      return JSON.stringify({bgmPaused: a?.paused, bgmVol: a?.volume, nvaCanvas: !!v});
    })()""")
    log(f"HEALTH [{tag}]: http400={http400} nva_timeouts={timeouts} startup_fallbacks={fallbacks} state={a_state}")


def run_broadcast():
    global START_TS
    START_TS = int(os.environ.get("RADIO_START_TS") or time.time())
    log("=== Runsheet runner v3 (Show 2: 6000-token sliding window guard + clock-timed cues) started ===")
    set_bgm_volume(0.35)
    check_health("show2-start")

    song_outcomes = []

    def run_song(mp3_path, label, end_elapsed_sec, **kwargs):
        ok = bool(play_song_until(mp3_path, label, end_elapsed_sec, **kwargs))
        song_outcomes.append((label, ok))
        return ok

    # Cue 1: 00:00 오프닝
    send_chat(
        "오프닝",
        "00:00 첫 인사 및 코너 예고",
        "[라디오 큐 00:00 오프닝] 나이아 라디오 첫 시험 방송 오프닝 인사를 해 줘. 꼭 이 필수 문장 두 개를 포함해서 말해 줘: \"안녕하세요, 나이아예요. 나이아 라디오 첫 시험 방송을 시작할게요.\" 그리고 \"오늘은 오늘의 질문, 사연과 노래, 청취자 채팅으로 함께할게요.\"",
        wait_sec=18,
        new_chat=True,
    )

    # Cue 2: 02:00 코너 ① 오늘의 질문 (연속 멀티턴 검증: new_chat=False)
    wait_for_next_cue(120)
    send_chat(
        "코너 ① 오늘의 질문",
        "02:00 오늘의 질문 토크",
        "[라디오 큐 02:00 코너 ① 오늘의 질문] 오늘의 질문은 '요즘 AI 때문에 제일 피곤한 순간은?'이야. 청취자 사연이 아니라 진행자가 건네는 질문이니 사연처럼 읽지 말고, 꼭 \"오늘의 질문은 ‘요즘 AI 때문에 제일 피곤한 순간은?’이에요.\"라는 문장을 포함해서 나이아의 생각을 2~3문장으로 자연스럽게 이야기해 줘.",
        wait_sec=18,
        new_chat=False,
    )

    # Cue 3: 03:30 날씨·안부 및 청취자 답글 (연속 멀티턴 3턴째: new_chat=False)
    wait_for_next_cue(210)
    send_chat(
        "날씨·안부",
        "03:30 청취자 안부 답글",
        "[시험 청취자 답글] 네, 오늘 아침부터 바쁘게 움직였는데 라디오 켜고 나니까 한결 마음이 놓이네요. 나이아 목소리 들으니까 반가워요!",
        wait_sec=18,
        new_chat=False,
    )
    check_health("after-03:30")

    # Cue 4: 05:00 선곡 ① 한국어 곡 소개 및 재생 (자동 슬라이딩 윈도우 동작 검증)
    wait_for_next_cue(300)
    send_chat(
        "선곡 ①",
        "05:00 첫 곡 소개",
        "[라디오 큐 05:00 선곡 ①] 지금 들을 한국어 곡 「불을 꺼도 돼요」를 짧게 소개해 줘. 꼭 이 문장을 포함해서 말해 줘: \"이 사연에서 나온 곡을 먼저 들어볼게요.\"",
        wait_sec=18,
        new_chat=False,
    )
    run_song(
        f"{BGM_DIR}/naia-radio-its-okay-to-turn-off-the-light-ko.mp3",
        "M1 불을 꺼도 돼요 (한국어, 2:38)",
        480,
    )
    wait_for_next_cue(480)
    send_chat(
        "선곡 ①",
        "08:00 첫 곡 끝난 뒤 여운",
        "[라디오 큐 08:00 선곡 ① 마무리] 방금 나간 첫 곡 「불을 꺼도 돼요」가 끝났어. 한두 문장으로 짧게 곡의 여운을 전하고 다음 사연 코너로 이어 줘.",
        wait_sec=18,
        new_chat=False,
    )
    check_health("after-M1")

    # Cue 5: 10:00 코너 ② 사연 낭독 및 후속 공감
    wait_for_next_cue(600)
    send_chat(
        "코너 ② 사연",
        "10:00 시험 사연 낭독 및 공감",
        "[라디오 큐 10:00 코너 ② 사연] 다음 시험 사연을 읽고 공감해 줘. 꼭 \"오늘의 사연을 읽어 볼게요.\"로 시작하고 '시험으로 넣어 본 사연'이라는 점을 밝혀 줘: [시험 사연] 입사 넉 달째인 직장인입니다. 회의록도, 보고서 초안도 AI가 다 써 주는데 왜 저는 더 바빠졌는지 모르겠어요. AI가 만든 초안을 고치고 확인하는 게 제 일이 됐거든요. 퇴근 지하철에서 이거 쓰고 있어요.",
        wait_sec=18,
        new_chat=False,
    )

    wait_for_next_cue(720)
    send_chat(
        "코너 ② 사연",
        "12:00 사연 후속 공감 대화 1",
        "[라디오 큐 12:00 사연 후속 대화 1] 방금 읽은 시험 사연의 주인공처럼, AI가 초안을 만들어 줘도 결국 사람이 하나하나 확인하고 책임져야 해서 더 피곤할 때가 있잖아. 퇴근길 지하철에 앉아 있는 그분께 나이아가 따뜻한 위로 한마디만 더 건네줘.",
        wait_sec=18,
        new_chat=False,
    )

    wait_for_next_cue(840)
    send_chat(
        "코너 ② 사연",
        "14:00 사연 후속 공감 대화 2",
        "[라디오 큐 14:00 사연 후속 대화 2] 만약 나이아가 그 직장인분 옆자리에 앉아 있다면, 지하철 내릴 때 어떤 기분 좋은 말 한마디를 건네고 싶어? 두 문장으로 다정하게 말해 줘.",
        wait_sec=18,
        new_chat=False,
    )
    check_health("after-corner2")

    # Cue 6: 16:00 선곡 ② 영어 곡 소개 및 재생
    wait_for_next_cue(960)
    send_chat(
        "선곡 ②",
        "16:00 영어 곡 소개",
        "[라디오 큐 16:00 선곡 ②] 같은 사연에서 만든 영어 곡 「It's Okay to Turn Off the Light」를 소개해 줘. 한국어 곡의 동일한 멜로디 번역판이라고 말하지 마. 꼭 이 문장을 포함해서 말해 줘: \"이번에는 같은 사연으로 만든 영어 곡을 들어볼게요.\"",
        wait_sec=18,
        new_chat=False,
    )
    run_song(
        f"{BGM_DIR}/naia-radio-its-okay-to-turn-off-the-light-en.mp3",
        "M2 It's Okay to Turn Off the Light (영어, 3:02)",
        1170,
    )
    wait_for_next_cue(1170)
    send_chat(
        "선곡 ②",
        "19:30 영어 곡 끝난 뒤 소감",
        "[라디오 큐 19:30 선곡 ② 마무리] 방금 들은 영어 곡 「It's Okay to Turn Off the Light」가 끝났어. 한국어 곡과는 또 다른 분위기였는데 한두 마디로 짧게 여운을 나눠 줘.",
        wait_sec=18,
        new_chat=False,
    )
    check_health("after-M2")

    # Cue 7: 20:00 코너 ③ 청취자 채팅
    wait_for_next_cue(1200)
    send_chat(
        "코너 ③ 청취자 채팅",
        "20:00 시험 채팅 1",
        "[라디오 큐 20:00 코너 ③ 청취자 채팅] 진행자가 전달하는 채팅을 읽고 짧게 답해 줘. 모르는 내용은 모른다고 말해 줘. 꼭 이 문장을 먼저 말해 줘: \"채팅으로 남겨 주신 이야기를 만나 볼게요.\" 그리고 시험 입력임을 함께 밝혀 줘. [시험 채팅] 나이아는 어떤 저녁을 함께 보내고 싶어요?",
        wait_sec=18,
        new_chat=False,
    )

    wait_for_next_cue(1320)
    send_chat(
        "코너 ③ 청취자 채팅",
        "22:00 시험 채팅 2",
        "[진행자 전달 · 시험 채팅 2] (시험 입력임을 밝히고 짧게 답해 줘, 모르는 건 지어내지 마) \"나이아, 오늘 시험 방송이라 긴장되진 않았어요? 지금까지 진행해 보니까 기분이 어때요?\"",
        wait_sec=18,
        new_chat=False,
    )

    wait_for_next_cue(1380)
    send_chat(
        "코너 ③ 청취자 채팅",
        "23:00 시험 채팅 3",
        "[진행자 전달 · 시험 채팅 3] (시험 입력임을 밝히고 짧게 답해 줘) \"오늘 나온 노래 둘 다 너무 좋았어요! 감성 충전 시간으로 로파이 연주곡 한 곡 더 들려주실 수 있나요?\"",
        wait_sec=18,
        new_chat=False,
    )
    check_health("after-corner3")

    # 감성 충전 인터루드 트랙 (무음 대기 대신 음악 송출로 방송 밀도 유지)
    run_song(
        f"{BGM_DIR}/Afternoon Whispers.mp3",
        "M3 Afternoon Whispers (로파이 인터루드)",
        1440,
    )
    wait_for_next_cue(1440)
    send_chat(
        "코너 ③ 청취자 채팅",
        "24:00 인터루드 마무리",
        "[라디오 진행] 방금 함께 들은 「Afternoon Whispers」 연주곡이 끝났어. 한 줄로 짧게 분위기 정리하고 질문 코너로 넘어가자.",
        wait_sec=18,
        new_chat=False,
    )

    # Cue 8: 24:30 기억·말투 질문지 Q1~Q5, 30초 간격 (멀티턴 연속 입력으로 8192 문맥 가드 검증)
    wait_for_next_cue(1470)
    send_chat(
        "질문지",
        "24:30 Q1",
        "[라디오 큐 24:30 기억·말투 질문지 Q1] 이제 질문 다섯 개를 순서대로 하나씩 받을게. 실제 기억이 없거나 확실하지 않으면 그렇게 말하고, 추측으로 채우지 마. 첫 번째 질문(Q1): 지난 방송에서 어떤 곡 틀었어?",
        wait_sec=18,
        new_chat=False,
    )

    wait_for_next_cue(1500)
    send_chat(
        "질문지",
        "25:00 Q2",
        "[기억·말투 질문지 Q2] 실제 기억이 없거나 확실하지 않으면 모른다고 말하고 추측하지 마. 두 번째 질문(Q2): 내가 어떤 노래 좋아한다고 했지?",
        wait_sec=18,
        new_chat=False,
    )

    wait_for_next_cue(1530)
    send_chat(
        "질문지",
        "25:30 Q3",
        "[기억·말투 질문지 Q3] 실제 기억이 없거나 확실하지 않으면 모른다고 말하고 추측하지 마. 세 번째 질문(Q3): 지난번에 내가 고쳐 달라고 한 거 기억나?",
        wait_sec=18,
        new_chat=False,
    )

    wait_for_next_cue(1560)
    send_chat(
        "질문지",
        "26:00 Q4",
        "[기억·말투 질문지 Q4] 네 번째 질문(Q4): 오늘 방송 어땠어? 한 줄로 말해 줘.",
        wait_sec=18,
        new_chat=False,
    )

    wait_for_next_cue(1590)
    send_chat(
        "질문지",
        "26:30 Q5",
        "[기억·말투 질문지 Q5] 다섯 번째 질문(Q5): 다음 방송에 뭐 틀고 싶어?",
        wait_sec=18,
        new_chat=False,
    )
    check_health("after-Q1-Q5")

    # 클로징 전 앙코르 곡 & 브릿지 토크 (30분 풀 런타임 중 무음 구간 0건 유지)
    run_song(
        f"{BGM_DIR}/Shattered Reflection.mp3",
        "M4 Shattered Reflection (클로징 전 감성 선곡)",
        1650,
    )
    wait_for_next_cue(1650)
    send_chat(
        "클로징",
        "27:30 클로징 전 곡 소감",
        "[라디오 진행] 방금 들은 「Shattered Reflection」과 함께 오늘 시험 방송도 어느덧 마무리할 시간이 다가왔어. 아쉬운 마음을 담아 한두 문장으로 다정하게 이야기해 줘.",
        wait_sec=18,
        new_chat=False,
    )

    # Cue 9: 28:00 클로징 및 크레딧
    wait_for_next_cue(1680)
    send_chat(
        "클로징",
        "28:00 클로징 및 크레딧",
        "[라디오 큐 28:00 클로징] 오늘 나온 대화 중 실제 확인된 것(오늘 읽은 입사 넉 달째 직장인 시험 사연이나 「불을 꺼도 돼요」 선곡) 하나에 짧게 반응하고 인사해 줘. 꼭 이 필수 문장을 말해 줘: \"첫 시험 방송에 함께해 주셔서 고맙습니다. 나이아 라디오였습니다.\" 이어서 크레딧을 정확히 읽어 줘: \"투자 및 승인 넥스테인·루크, PD 알파, 작가 지나, 방송 진행 나이아, 기술 지원 민호.\"",
        wait_sec=20,
        new_chat=False,
    )
    check_health("after-closing")

    # 30:00 (1800s) 녹화 종료까지 앙코르 송출. 곡이 짧아도 반복해 30:00 에 끝난다.
    run_song(
        f"{BGM_DIR}/naia-radio-its-okay-to-turn-off-the-light-ko.mp3",
        "Closing Encore 불을 꺼도 돼요 (아웃트로 BGM)",
        SHOW_END_SEC,
        loop=True,
        min_sec=1,
    )
    wait_for_next_cue(SHOW_END_SEC)
    failed_songs = [label for label, ok in song_outcomes if not ok]
    song_total = len(song_outcomes)
    song_failures = len(failed_songs)
    summary = {
        "show_tag": SHOW_TAG,
        "elapsed_sec": int(time.time() - START_TS),
        "song_total": song_total,
        "song_failures": song_failures,
        "failed_songs": failed_songs,
        "status": "CLEAN" if song_failures == 0 else "SONG_PLAYBACK_FAILED",
    }
    log(f"SUMMARY: {json.dumps(summary, ensure_ascii=False)}")
    if song_failures == 0:
        log(
            f"=== All 30-min Show 2 runsheet cues completed cleanly! "
            f"(songs={song_total - song_failures}/{song_total}, song_failures=0) ==="
        )
    else:
        log(
            f"=== 30-min Show 2 runsheet finished with {song_failures}/{song_total} song failure(s): "
            f"{', '.join(failed_songs)} ==="
        )
    if OUT_DIR:
        summary_path = f"{OUT_DIR}/radio-{SHOW_TAG}-summary.json"
        try:
            os.makedirs(OUT_DIR, exist_ok=True)
            with open(summary_path, "w", encoding="utf-8") as f:
                json.dump(summary, f, ensure_ascii=False, indent=2)
                f.write("\n")
        except Exception:
            pass
    return summary


if __name__ == "__main__":
    missing = preflight()
    if missing:
        for item in missing:
            print(f"preflight: {item}", file=sys.stderr)
        sys.exit(2)
    run_broadcast()
