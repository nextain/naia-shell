# Naia Panel Spec (installed panels)

Authoritative, code-accurate spec for the panel system. Companion to `panel-development-guide.md` (how-to). This file describes **what the contract is**; the guide describes **how to build one**.

> Status: AI-collaboration wiring (a panel exposing tools the AI can call, and a panel notifying the AI on user activity) is **현재 개발 중 / in development** for installed panels — see [Trust & collaboration model](#trust--collaboration-model) and issue #358. This spec covers the stable, non-AI surface.

## 1. Two kinds of panel

| Kind | Built how | Host access channel | Removable |
|------|-----------|---------------------|-----------|
| **Built-in (React)** | bundled in the shell, `panelRegistry.register()` at build time | `NaiaContextBridge` passed as a prop (`PanelCenterProps.naia`) | no (if `builtIn: true`) |
| **Installed (iframe)** | dropped into `~/.naia/panels/{id}/` with `panel.json` + `index.html`, rendered in an iframe | `naia-bridge-client` over `postMessage` (no direct bridge) | yes |

These are **two distinct host-access channels** — do not conflate them:
- Built-in panels receive a live `NaiaContextBridge` object (`shell/src/lib/panel-registry.ts:66`, prop at `:199-201`).
- Installed iframe panels receive **nothing** in-process — `GenericInstalledPanel` renders a bare iframe and ignores its props (`shell/src/panels/generic-installed/GenericInstalledPanel.tsx:11`). All host calls go through `postMessage`: client side `naia-bridge-client.ts` (`window.parent.postMessage`) → host side `iframe-bridge.ts`.

The rest of this spec is about **installed (iframe) panels** unless noted.

## 2. Directory layout

```
~/.naia/panels/
└── {dir}/
    ├── panel.json     # required manifest
    ├── index.html     # required for rendering (iframe entry)
    ├── icon.svg       # optional, referenced by panel.json iconUrl
    └── ...            # bundled JS/CSS/assets
```

Discovery scans `~/.naia/panels/` only — both the shell (`shell/src-tauri/src/panel.rs:37`) and the agent (`agent/src/skills/built-in/panel.ts:18`). Anything outside this directory is **not discovered**. A panel with no `panel.json` is skipped (`panel.rs:52`). A panel with no `index.html` renders a placeholder, not content (`GenericInstalledPanel.tsx:26-35`).

> **`{dir}` (the directory name) is the panel's security identity** — secret and behavior-log namespacing key off the directory name parsed from the iframe URL, **not** `panel.json.id` (see §7). Keep `{dir}` == `panel.json.id`. (Today nothing enforces this equality; #359 will.)

## 3. `panel.json` manifest

### 3.1 Authored fields (you write these)
| Field | Type | Required | Notes |
|-------|------|:--------:|-------|
| `id` | string | ✅ | unique kebab-case; should equal the directory name (§2) |
| `name` | string | ✅ | fallback display name |
| `names` | `{ [locale]: string }` | — | localized labels; resolved as `names?.[locale] ?? name` (`shell/src/components/ModeBar.tsx:308`) |
| `description` | string | — | shown in the (future) panel store |
| `icon` | string | — | emoji/char shown in ModeBar tab |
| `iconUrl` | string | — | relative path to an SVG (e.g. `"icon.svg"`); see §4 |
| `version` | string | — | semver |

### 3.2 Computed-at-load fields (DO NOT author — set by the runtime)
| Field | Set by | Meaning |
|-------|--------|---------|
| `iconSvg` | Rust, from `iconUrl` file (`panel.rs:67-72`) | inline SVG content; `skip_deserializing` so any authored value is ignored (`panel.rs:16-21`) |
| `htmlEntry` | Rust, if `index.html` exists (`panel.rs:74-77`) | absolute path to `index.html`; `skip_deserializing` (`panel.rs:24-30`) |

### 3.3 Inert / reserved fields
- `entrypoint` — appears only in the agent's manifest type (`panel.ts:26`) and is **read by nothing** today. Reserved for future dynamic JS loading. Do not rely on it.
- `publisher`, `signature` — **reserved for Tier B (signed) panels** (see §9). Unused today; no verification is performed. Present in the spec so the future hub/store can layer on without a manifest break.

> **Known inconsistency (to converge):** the three manifest definitions disagree — Rust `PanelManifest` (`panel.rs:7-31`) has `iconUrl`/`iconSvg`/`htmlEntry`/`names`, no `entrypoint`; the shell loader `InstalledPanelManifest` (`panel-loader.ts:7-18`) has `iconSvg`/`htmlEntry`, no `iconUrl`/`entrypoint`; the agent `PanelManifest` (`panel.ts:20-27`) has `entrypoint`, no `names`/`iconUrl`. Authoring per §3.1 is safe today (Rust is the loader of record). Convergence tracked in #358.

## 4. Icon resolution

1. Author sets `iconUrl: "icon.svg"` (relative to panel dir).
2. Rust reads the file and inlines it as `iconSvg` at list time (`panel.rs:67-72`).
3. ModeBar renders `iconSvg` if present, else `icon` (emoji) (`ModeBar.tsx:313-321`). `iconSvg` takes priority over `icon` (`panel-registry.ts:227`).

## 5. `index.html` contract (rendering)

- If `index.html` exists, the panel renders in an iframe whose `src` is the Tauri asset-protocol URL **`http://asset.localhost{abs-path-to-index.html}`** — note `htmlEntry` already includes `index.html`, so there is no extra `/index.html` appended (`GenericInstalledPanel.tsx:15`, value from `panel.rs:77`).
- iframe sandbox: `allow-scripts allow-same-origin` (`GenericInstalledPanel.tsx:21`).
- The host re-derives the panel id from the iframe `src` via the regex `/\/([^/]+)\/index\.html(?:[?#].*)?$/` (`iframe-bridge.ts:54`) — i.e. the directory name. This is why `{dir}` is the security identity (§2, §7).

## 6. Host bridge API (`naia-bridge-client`)

Installed panels talk to the host by copying `shell/src/lib/naia-bridge-client.ts` into the panel and using `NaiaBridgeClient`. It is pure `postMessage` (no Tauri/shell imports). Messages are `naia-bridge:*`; the host validates `event.origin === "http://asset.localhost"` and rejects unresolved panel identity (`iframe-bridge.ts:62,78`).

| Method | Backed by | Scope / limit |
|--------|-----------|---------------|
| `logBehavior(event, data?)` | IndexedDB `naia_behavior` (`behavior-log.ts`) | per-panel; 30-day auto-purge |
| `queryBehavior(filter?)` | IndexedDB | **forced to the calling panel** (`iframe-bridge.ts:96`) — cannot read other panels' logs |
| `getSecret(key)` / `setSecret(key,value)` | secure-store, key `panel:{dir}:{key}` (`iframe-bridge.ts:108,123`) | per-panel namespace |
| `readFile(path)` | Tauri `panel_read_file` | inside HOME only, ≤1 MB (`panel.rs:89-111`) |
| `runShell(cmd,args?)` | Tauri `panel_run_shell` | allowlist (`ls/echo/pwd/date/uname/whoami`), cwd=HOME, arg metachar/path filters (`panel.rs:124-215`) |

These are all **non-AI** host services. The AI-facing methods of `NaiaContextBridge` (`pushContext`, `onToolCall`) are **not exposed over the iframe bridge** — there is no `naia-bridge:onToolCall`/`pushContext` message type. They are built-in-panel-only and deferred for installed panels (§9).

## 7. Security model

An installed panel runs **attacker-supplied JavaScript** (`allow-scripts`) with a real privilege surface: HOME file read (≤1 MB), an allowlisted shell, a persistent secret store, and a behavior log. **Installing a panel is granting it that surface** — treat install as code execution, not as adding a passive widget.

- **Per-panel isolation**: secrets and behavior logs are namespaced/scoped by directory name (`iframe-bridge.ts:96,108,123`). A panel cannot read another panel's secrets or logs **as long as directory names are unique and equal to `panel.json.id`**.
- **Identity caveat**: because the namespace key is the directory name (not a verified id), a panel installed under a colliding directory name could shadow another panel's namespace. Enforcing `{dir}` == `id` and rejecting collisions is part of safe install (#359).
- **HOME boundary**: `panel_read_file`/`panel_remove_installed` canonicalize and assert the path stays under HOME, defeating symlink/traversal (`panel.rs:97-101,238-241`).
- **Install trust**: see §9.

## 8. Lifecycle

```
panel_list_installed (Rust scan)            panel.rs:35
  → loadInstalledPanels (register each)     panel-loader.ts:26
  → panelRegistry.register(...)             panel-registry.ts:276
  → bumpPanelListVersion → ModeBar re-render panel-loader.ts:63
remove:
  removeInstalledPanel(id)                  panel-loader.ts:71
  → panel_remove_installed (Rust rm)        panel.rs:218
  → panelRegistry.unregister + bumpVersion  panel-loader.ts:84-85
```

Removal branches on `source` (`ModeBar.tsx:112-122`, `handleRemovePanel`): `source: "installed"` → `removeInstalledPanel` (disk + memory + bump); build-time panels → `panelRegistry.unregister` + persisted in config `deletedPanels` (no disk delete, so they stay removed across restarts).

## 9. Trust & collaboration model

### Install trust — two tiers
- **Tier A — Sideload (unsigned)**: user installs a panel they built or received (local zip / arbitrary git URL). Like installing an unsigned APK: **explicit warning + user consent + extraction/identity hardening**. The user accepts the risk *they* choose ("I trust this panel"); cross-panel theft and host-integrity attacks are blocked regardless. **현재 개발 중** — issue #359. (Today: https git URL install works via `actionInstall`; local zip currently fails — the UI offers a zip tab but the backend rejects non-https post-#257 — and is being gated in #358 Phase 2.)
- **Tier B — Verified (signed)**: panels Nextain reviews and signs, distributed via a future hub/store. Certificate verification against `publisher`/`signature` (§3.3, reserved), a "verified" badge, no warning. **현재 개발 중** — future issue. No PKI exists yet; the spec only reserves the manifest fields and records install source so this layers on without a manifest break.

### AI collaboration — deferred for installed panels
The design intent: a panel is a surface **the user and Naia use together** — (1) Naia can act on the panel (`onToolCall`), and (2) when the user acts and "AI Interference" is on, the panel notifies Naia (`emitAiInterferenceEvent`). Today this is wired only for **built-in** panels; `ai-interference.ts:5` even reserves `source:"panel"` but nothing emits it. For installed iframe panels both directions are **현재 개발 중** and intentionally out of this spec's stable surface.

### In-app authoring (연동 예정)
Developing and publishing custom panels from inside the **Workspace** panel (editor + terminal) is planned — an in-app build → install → publish loop that ultimately feeds the Tier-B hub/store.

## 10. Install sources (current reality)
- **https git URL** — supported (`actionInstall`, `panel.ts:112` https-only after #257). Private repos: token in URL.
- **local zip** — currently inconsistent: the UI offers a zip tab (`PanelInstallDialog.tsx`) but `actionInstall` rejects it (#257). Being gated in #358 Phase 2; safe restore (warning + consent + hardening) in #359.
- **Tier B signed** — future.
