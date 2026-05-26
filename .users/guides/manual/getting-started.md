<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Getting Started

First-run setup for Naia OS: install the shell, point it at a Naia ADK
workspace, sign in to the gateway, and send your first chat message.

Related e2e: S009 (`09-onboarding.spec.ts`), S013 (`13-lab-login.spec.ts`),
S024a (`24-adk-setup-flow.spec.ts`).

## Prerequisites

- Naia OS shell binary (Flatpak / dev `pnpm run tauri:dev`).
- One of:
  - **Cloud usage** — Naia account at naia.nextain.io (free signup, gateway API key issued in dashboard).
  - **Local usage** — Ollama or vLLM on `localhost`, an API key for one direct provider (OpenAI / Anthropic / GLM / Gemini), or a Claude Code subscription.
- ~500 MB disk for the ADK workspace (cloned naia-adk + naia-settings/).

## Step 1 — ADK setup

On the first launch you'll see the ADK Setup Screen with three options:

| Option | When to use |
|--------|-------------|
| ✦ New | Fresh install — clones the `nextain/naia-adk` scaffold into the chosen folder. |
| 📂 Load | Existing folder — uses your own naia-adk fork or a previously-set-up workspace. |
| 🌐 naia 계정 백업 복원 | _(currently disabled, see #327)_ — restore from a cloud backup tied to your Naia account. |

### New install path

1. Choose **New**, pick a directory (default in your home).
2. If the directory already has content the screen branches:
   - `has_settings` ("이미 데이터가 있어요") — you can keep the existing `naia-settings/` and skip the clone, or wipe and re-clone.
   - `has_other_files` ("폴더에 파일이 있어요") — only "wipe + re-clone" is offered (no half-ADK state).
3. Setup runs four phases with a live status line:
   - `기존 데이터 삭제 중...` (if wiping)
   - `naia-adk 다운로드 중...` (git clone or zip fallback with `% (MB)` progress)
   - `설정 디렉토리 생성 중...`
   - `기본 에셋 복사 중...`
4. After the last phase the app navigates straight to onboarding.

If `git` is unavailable, the shell automatically falls back to a streaming
zip download from the public naia-adk archive and shows byte progress
every ~200 ms.

### Load existing path

Same UI, just skips the clone phase if `naia-settings/` is already there.

## Step 2 — Onboarding wizard

Walks you through:
1. **Identity** — agent name (default `Naia`), your display name, persona prompt.
2. **Provider** — pick from the dropdown:
   - `nextain` — routes everything through the Naia gateway Cloud Run service (default for cloud users).
   - `gemini` / `openai` / `anthropic` / `xai` / `zai` — direct API with your own key.
   - `ollama` / `vllm` — local OpenAI-compatible endpoint (no API key needed).
   - `claude-code-cli` — uses your Claude Code subscription (no API key).
3. **API key** — store the key for the selected provider. Stored in the Tauri secure-keys vault (under the app's per-platform application data folder).
4. **Locale** + **VRM** — UI language and avatar model.

## Step 3 — Sign in (cloud users only)

If you picked `nextain` provider and don't yet have a key:

1. Click **로그인 → Naia 계정** on the Settings tab.
2. Browser opens to the Naia login page.
3. After OAuth, the page issues a deep-link with the `naiaKey` payload.
4. The shell catches the deep-link and stores `naiaKey` in the secure vault.
5. Settings tab balance card updates within a few seconds (cost-dashboard
   skill polls the gateway profile balance endpoint).

> ⚠ **Known issue (#329)** — e2e and dev-environment scripts that set
> `naia-config` directly via `localStorage.setItem` will _not_ run the OAuth
> path. If you previously stored a Gemini direct `apiKey` and switch to
> nextain provider, that stale `apiKey` can shadow `naiaKey` and the agent
> returns 401. Workaround until the proper fix lands: open the Tauri
> secure-keys vault file in the app's per-platform application data folder
> and remove the `apiKey` JSON field.
>
> See `.agents/context/lessons-learned.yaml` L059 for the full trace.

## Step 4 — First chat

1. Chat tab is selected by default once onboarding completes.
2. Type a message in the input row, press <kbd>Enter</kbd>.
3. The avatar lip-syncs to TTS playback (if voice is enabled).
4. The Tool Activity strip at the bottom shows live tool calls (e.g. `skill_time`, `skill_weather`).

### Verify it works

A canonical smoke test (same prompt our e2e uses, but adjusted for tool restraint):

```
지금 몇 시야? skill_time 도구를 반드시 사용해서 알려줘.
```

Expected: a chat bubble like _"오후 3:42예요."_ and a `skill_time` entry
in Tool Activity. If you see `[오류] Unauthorized`, your gateway key
is invalid or the secure-store collision from #329 is biting you — see
the known-issue note above.

## What's next

- **Skills** — browse the **Skills** tab to enable/disable individual capabilities (S014, S019).
- **Channels** — wire Slack / Discord webhooks for notifications (S022, S023).
- **Memory** — Naia records facts and recalls them across sessions (S008).
- **Cron** — schedule recurring agent runs (S020, S021).

For each topic page in this manual, the trailing e2e ID (e.g. S014) is the
canonical scenario in `shell/e2e-tauri/specs/` and `.agents/context/e2e-scenarios.yaml`.

🤖 Written with AI assistance. If anything looks off, please open a discussion.
