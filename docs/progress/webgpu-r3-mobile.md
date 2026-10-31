# Web shell mobile feature matrix

The mobile layout applies in portrait at a viewport width of at most 600 CSS pixels with a coarse pointer (`packages/shell/src/styles/web-mode.css`). Desktop layout is unaffected by this media query.

| Feature | Mobile status | Evidence |
| --- | --- | --- |
| Avatar and chat | Available | `packages/shell/src/components/AppMainContent.tsx`, `packages/shell/src/styles/web-mode.css` |
| Settings | Available in a full-screen panel | `packages/shell/src/components/AppBar.tsx`, `packages/shell/src/styles/web-mode.css` |
| Offline ADK file tree, read-only preview and download | Available when browser OPFS is available | `packages/shell/src/apps/workspace/WebWorkspace.tsx`, `packages/shell/src/lib/web-runtime/web-workspace-files.ts` |
| Online container files and synchronization | Coming soon | `packages/shell/src/apps/workspace/WebWorkspace.tsx` |
| Native browser view, terminal, and installed apps | Unavailable in web mode | `packages/shell/src/components/AppBar.tsx`, `packages/shell/src/apps/workspace/HerdrWorkspaceSurface.tsx`, `packages/shell/src/lib/web-runtime/command-table.ts` |
| Projects, slides, and app store | Hidden in mobile web mode | `packages/shell/src/styles/web-mode.css`; their native services are not implemented by the web runtime |

Availability describes implemented entry points, not certification for every browser, model, or peripheral.
