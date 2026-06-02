# Naia Panel Development Guide

Naia OS is extensible through **panels** — UI components that live in the right area of the shell alongside Naia's chat interface.

> **Read the spec first.** The authoritative, code-accurate contract is **[`panel-spec.md`](./panel-spec.md)** — manifest fields, the two host-access channels (built-in prop vs installed iframe bridge), the security model, and the trust tiers. This guide is the how-to companion. AI-tool exposure (`onToolCall`) and AI-interference are **built-in-panel-only / 현재 개발 중** for installed panels.

## What is a Panel?

A panel is a React component bundle installed under `~/.naia/panels/{id}/`. When installed, it:

1. Appears as a tab in the **ModeBar** (right side of the shell)
2. Renders a center UI component when activated
3. Optionally exposes **AI tools** (skills) so Naia can interact with the panel on the user's behalf

## Panel Manifest (`panel.json`)

Every panel directory must contain a `panel.json`:

```json
{
  "id": "my-panel",
  "name": "My Panel",
  "names": { "ko": "내 패널", "en": "My Panel" },
  "description": "What this panel does",
  "icon": "🔧",
  "iconUrl": "icon.svg",
  "version": "1.0.0",
  "entrypoint": "index.js"
}
```

| Field | Required | Description |
|-------|:--------:|-------------|
| `id` | ✅ | Unique kebab-case identifier (`my-panel`) |
| `name` | ✅ | Display name (fallback if `names` not set) |
| `names` | — | i18n names: `{ ko: "...", en: "..." }` |
| `description` | — | Short description shown in the future panstore |
| `icon` | — | Emoji or single character shown in the ModeBar tab |
| `iconUrl` | — | Relative path to an SVG file (e.g. `"icon.svg"`) — displayed in the ModeBar tab instead of `icon` |
| `version` | — | Semantic version string |
| `entrypoint` | — | JS entry point (for future dynamic loading) |

> **Icon priority**: `iconUrl` (SVG) takes precedence over `icon` (emoji) if both are set.

## Installing a Panel

From the Naia shell, click the **`+`** button in the ModeBar:

**Git URL** (recommended):
```
https://github.com/your-org/my-panel.git
```

**Private repository** — include a token in the URL:
```
https://TOKEN@github.com/your-org/my-panel.git
```

**Zip file**: currently gated. The zip tab is shown in the installer but disabled ("준비 중") — local-zip install was removed in #257 (RCE hardening) and is being safely restored (warning + consent + extraction hardening) in #359. Use a Git URL for now.

You can also ask Naia directly:
> "my-panel 패널 https://github.com/... 에서 설치해줘"

## Panel Structure

```
my-panel/
├── panel.json          # Required manifest
├── index.tsx           # Panel registration entry (built into shell bundle)
└── MyCenterPanel.tsx   # UI component
```

> **Two kinds of panel.** *Built-in* panels (React, bundled in the shell) are registered at build time via `panelRegistry.register()`. *Installed* panels are dropped into `~/.naia/panels/{id}/` as a `panel.json` + `index.html` and loaded at runtime into an iframe — no shell rebuild needed. The sections below cover both; for the precise contract see [`panel-spec.md`](./panel-spec.md). For an installable starting point, copy [`examples/hello-naia/`](./examples/hello-naia/).

## Registering a Panel

In `index.tsx`, register with the panel registry:

```tsx
import { panelRegistry } from "../../lib/panel-registry";
import { MyCenterPanel } from "./MyCenterPanel";

panelRegistry.register({
  id: "my-panel",
  name: "My Panel",
  names: { ko: "내 패널", en: "My Panel" },
  icon: "🔧",
  // builtIn: true  ← omit this; built-in panels cannot be removed
  center: MyCenterPanel,
  tools: [
    {
      name: "skill_my_panel_read",   // must start with skill_
      description: "Read current state from My Panel",
      parameters: { type: "object", properties: {} },
      tier: 0,  // 0 = auto-approve, 1 = approve once, 2 = always ask
    },
    {
      name: "skill_my_panel_update",
      description: "Update My Panel with new data",
      parameters: {
        type: "object",
        properties: {
          data: { type: "string", description: "Data to set" },
        },
        required: ["data"],
      },
      tier: 1,
    },
  ],
});
```

## Implementing the Center Component

```tsx
import { useEffect, useRef, useState } from "react";
import type { PanelCenterProps } from "../../lib/panel-registry";

export function MyCenterPanel({ naia }: PanelCenterProps) {
  const [data, setData] = useState("");
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    // Register AI tool handlers
    const unsubRead = naia.onToolCall("skill_my_panel_read", () => {
      return dataRef.current || "(empty)";
    });

    const unsubUpdate = naia.onToolCall("skill_my_panel_update", (args) => {
      const newData = String(args.data ?? "");
      setData(newData);
      dataRef.current = newData;
      // Push context to Naia's system prompt (optional)
      naia.pushContext({ type: "my-panel", data: { content: newData } });
      return "Updated";
    });

    // Cleanup on unmount
    return () => {
      unsubRead();
      unsubUpdate();
    };
  }, [naia]);

  return (
    <div className="my-panel">
      <p>{data || "No data yet. Ask Naia to add something!"}</p>
    </div>
  );
}
```

### `PanelCenterProps` API

| Member | Type | Description |
|--------|------|-------------|
| `naia.onToolCall(name, handler)` | `(args) => string` | Register a tool handler. Returns an unsubscribe function. |
| `naia.pushContext(ctx)` | `void` | Push structured context into Naia's system prompt so she's aware of panel state. |

### Tool Handler Rules

- **Return value** must be a `string` — this is what Naia receives as the tool result.
- **Use a `ref`** for state accessed inside handlers to avoid stale closures.
- **Always unsubscribe** in the `useEffect` cleanup to avoid memory leaks.
- **Tool names** must start with `skill_` (e.g., `skill_my_panel_read`).

## Permission Tiers

| Tier | Behavior |
|------|----------|
| `0` | Auto-approved — Naia executes without asking |
| `1` | User is asked once per session; subsequent calls auto-approved |
| `2` | User is always asked before execution |
| `3` | Requires elevated privileges |

## Context Injection (`pushContext`)

When your panel's state changes, call `naia.pushContext()` to keep Naia informed:

```tsx
naia.pushContext({
  type: "my-panel",       // unique type string
  data: { content: "..." },
});
```

Naia will include this in her system context, so she can proactively reference panel state even without a tool call.

## skill_panel Built-in Tool

Naia has a built-in `skill_panel` tool for panel management:

```
skill_panel list      — list installed panels
skill_panel switch    — activate a panel by id
skill_panel install   — install from an https git URL (zip gated, see #359)
skill_panel remove    — uninstall a panel by id
```

Users can invoke these naturally:
> "패널 목록 보여줘"
> "my-panel 설치해줘 (https://github.com/...)"
> "sample-note 삭제해줘"

## Reference Implementations

- **Installed (iframe) panel** — [`docs/examples/hello-naia/`](./examples/hello-naia/): `panel.json` + `index.html` + `icon.svg`, using the bridge's `logBehavior` (non-AI). Copy it into `~/.naia/panels/hello-naia/` to install. This is the reference for panels users install.
- **Built-in (React) panel** — `shell/src/panels/sample-note/` (`index.tsx` + `SampleNoteCenterPanel.tsx`): registered via `panelRegistry.register()` with `skill_note_read` / `skill_note_write` tool handlers. This is the reference for AI-tool panels bundled in the shell. Note: it has **no** `panel.json`/`index.html` — it is a built-in, not an installed panel.

## Directory Layout After Install

```
~/.naia/
└── panels/
    └── my-panel/
        ├── panel.json
        ├── icon.svg      # optional — referenced by iconUrl
        └── ...
```

The shell scans `~/.naia/panels/` on startup and after each install/remove.

## Tips

- **Keep tools focused** — one tool per action, clear description
- **Tool descriptions are LLM prompts** — write them as instructions to an AI, not documentation
- **Avoid blocking handlers** — tool handlers must return synchronously (or return a Promise that resolves quickly)
- **Start from the example** — build your installed panel as a variation of [`examples/hello-naia/`](./examples/hello-naia/) (or the built-in `sample-note` for a React panel)

## Collaboration model — where panels are headed (현재 개발 중)

A panel is meant to be a surface **you and Naia use together**, not just a widget you operate alone. Two directions complete this:

1. **Naia acts on the panel** — the panel exposes tools (`onToolCall`) Naia can call to read/update its state on your behalf.
2. **Naia notices your activity** — when you operate the panel and **AI Interference** is on, the panel emits an activity event so Naia can chime in *only when it helps*.

Today both directions are wired for **built-in** panels only. For installed (iframe) panels they are **현재 개발 중 / in development** — `ai-interference.ts` even reserves `source:"panel"` for exactly this, but nothing emits it yet.

Distribution follows the same staged path (see [`panel-spec.md`](./panel-spec.md) §9): **Tier A sideload** (unsigned, warning + consent — #359) today → **Tier B verified** (Nextain-signed, a panel hub/store) later.

Authoring is also moving in-app: **developing and publishing a panel from the Workspace panel** (editor + terminal) is planned (연동 예정) — an in-app build → install → publish loop, without leaving Naia.

This vision is recorded so contributors build installable, self-contained panels now that slot cleanly into the collaborative + hub future.
