# Tab Skills — Common Panel AI Tools

Common AI tools available to any panel with a viewport. Defined once, panels opt-in with one hook call.

## Architecture

```
skill_tab_screenshot invoked by AI
  → useTabSkills hook  (panel component)
    → invoke("capture_screen_region", {x, y, width, height})   ← CSS logical px
      → Rust: inner_position + scale_factor conversion
        → Windows:  GDI BitBlt → PNG (png crate)
        → macOS:    screencapture -R x,y,w,h -x path.png
        → Linux:    scrot -a x,y,w,h  →  import -crop (ImageMagick fallback)
```

## Files

| File | Purpose |
|------|---------|
| `shell/src-tauri/src/capture.rs` | Rust command + platform backends |
| `shell/src/lib/tab-skills.ts` | TS hook + descriptor exports |
| `shell/src-tauri/src/lib.rs` | `capture_screen_region` registered in invoke_handler |

## Using Tab Skills in a Panel

**`panel/index.tsx`** — add descriptors to tools list:
```ts
import { TAB_SKILL_DESCRIPTORS } from "../../lib/tab-skills";

panelRegistry.register({
  tools: [...TAB_SKILL_DESCRIPTORS, ...panelSpecificTools],
  ...
});
```

**`PanelCenterComponent.tsx`** — register handlers:
```ts
import { useTabSkills } from "../../lib/tab-skills";

export function MyPanel({ naia }: PanelCenterProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  useTabSkills(viewportRef, naia);
  // ...
  return <div ref={viewportRef} className="my-panel__viewport" />;
}
```

## Current Skills

### `skill_tab_screenshot`

- **Tier**: 0 (auto-allowed)
- **Description**: Capture the panel's viewport area from the OS screen buffer
- **Returns**: Absolute path to saved PNG in OS temp dir
- **Note**: Works for native-overlay panels (WebView2, X11 embed) since it reads from screen, not the DOM

## Platform Coordinate Conversion

```
screen_x = window.inner_position().x + css_x * scale_factor
screen_y = window.inner_position().y + css_y * scale_factor
```

`inner_position()` is used (not `outer_position()`) to exclude the OS title bar and window borders.

## Adding New Tab Skills

1. Add `SKILL_TAB_<NAME>: NaiaTool` descriptor in `tab-skills.ts`
2. Add to `TAB_SKILL_DESCRIPTORS` array
3. Add handler in `useTabSkills` `useEffect`
4. Add Rust command in `capture.rs` (or new module) if needed
5. Register in `lib.rs` invoke_handler
6. Panels get the skill automatically via `...TAB_SKILL_DESCRIPTORS`
