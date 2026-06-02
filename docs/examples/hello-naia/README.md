# Hello Naia — the simplest installable panel

A hello-world **installed (iframe) panel** for Naia OS — the starting point for building your own. Referenced by `docs/panel-spec.md` and `docs/panel-development-guide.md`.

It greets you and logs a single behavior event through the Naia bridge (`naia-bridge:logBehavior`). It is **non-AI**: no `onToolCall`/`pushContext` (those are built-in-panel-only / in development for installed panels — see panel-spec §9).

## Files
```
hello-naia/
├── panel.json    # manifest (id, names, icon, version)
├── index.html    # UI + one bridge call (rendered in an iframe)
├── icon.svg      # tab icon (referenced by panel.json iconUrl)
└── README.md
```
No build step — plain HTML/JS, so installing = getting the folder into `~/.naia/panels/`.

## Install

**From Git (recommended)** — in the Naia shell, ModeBar **+ → Git URL**, or ask Naia: "install the panel from <repo-url>". The installer clones the repo (its root must contain `panel.json`) into `~/.naia/panels/hello-naia/`.

**During development (copy)**:
```sh
cp -r docs/examples/hello-naia ~/.naia/panels/hello-naia
```
Then restart the shell (or trigger a panel reload). It appears as a 👋 tab in the ModeBar.

> Keep the directory name equal to `panel.json.id` — the bridge keys per-panel secrets/behavior off the directory name (panel-spec §2, §7).

## Next steps
For the full host API (`queryBehavior`, `getSecret`/`setSecret`, `readFile`, `runShell`), copy `shell/src/lib/naia-bridge-client.ts` and use `NaiaBridgeClient`. See `docs/panel-spec.md` §6.

> **Coming:** in-app panel development & publishing through the Workspace panel (editor + terminal) is planned — build, test, and ship a panel without leaving Naia. See panel-spec §9 / the dev guide's collaboration section.
