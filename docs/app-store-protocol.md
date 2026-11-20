# App sandbox and Workspace viewer protocol

Every app-store app receives a private root at
`data-private/apps/{package-id}/`. An app must only address files below that
root with a relative path; absolute paths and traversal segments are rejected.

That private root is the durable user-data location. Shell upgrades replace the
installed package directory and preserve only old files whose relative paths
are absent from the new package. Apps must keep user-created state under their
private root instead of relying on files bundled beside `index.html`; bundled
files shipped by an update always take precedence at matching paths.

Use the Shell bridge, not direct filesystem APIs:

- `sandboxRoot()` returns the app's private root.
- `openInWorkspace(relativePath)` opens one existing sandbox file in the
  Workspace universal viewer.

The Workspace viewer selects the registered renderer from the file extension.
This includes `video/mp4`, so apps should not implement their own MP4 player.

Slides is package `land.naia.slides`; its recordings are stored in
`data-private/apps/land.naia.slides/video/`.

During a Slides presentation, the Shell also retains each synthesized narration
WAV and an adjacent JSON diagnostic record under
`data-private/apps/land.naia.slides/diagnostics/voice/`. The record contains
the narration text, selected provider/voice, local-reference presence, host,
synthesis latency, WAV duration, and slide identity. It never stores an API
key or a copy of the reference voice. These files stay private to the app and
can be opened with `openInWorkspace(relativePath)` for listening and analysis.

The Shell owns `data-private/apps/land.naia.shell/diagnostics/voice/` for local
VoxCPM2 chat diagnostics. It uses the same WAV + JSON format, with no slide
identity. This lets a voice incident be attributed to source generation before

## Web storefront and installation (R3 · R4, 2026-11-20)

The app bar opens the portal storefront at `/{locale}/apps?target=web` in
a new window with `noopener,noreferrer`. The portal handles browsing, pricing
and purchase. Desktop uses the existing `naia://app-install` signed-package
flow.

The portal hands a public catalog ID to the same origin at
`/app/?installApp=<id>`. A free registered app can link directly. A paid
product exposes a Web install link after purchase. The shell checks the
current catalog, shows confirmation for that app, and verifies ownership.
Opening or confirming this link never issues a purchase request.

The shell resolves apps from built-in Stage-1 entries, gateway products and
the portal public catalog, in that order. Lookup failures leave available
entries intact. Installation uses the existing `installedWebApps` config
and iframe sandbox. Portal `/hosted-apps/…` URLs map to the shell base,
for example `/app/hosted-apps/…`. The receiving shell adds the selected app
to its app bar and opens it after confirmation.

### Built-in hosted app bundles (R35)

`pnpm --filter naia-shell build:web` builds the current checkout's Slides entry
with `vite.slides.config.ts` in web mode. `scripts/web-hosted-apps.mjs` also
builds Character Card, IeumOffice and Cafe Lua Tarot from the `nextain/naia-shell`
source pinned at `0912f5016a2ae81c028d375dfc7dbd837d9ba6bb`. It uses the local
Git object if available and fetches that exact commit otherwise. The web build
stages each bundle's `index.html`, manifest, icon and assets under
`dist-web/hosted-apps/<slug>/`. Missing source or invalid artifacts fail the
build. The static host serves this directory under the shell base (for example
`/app/hosted-apps/`), and the shell service worker lets hosted app requests pass
through to the static host.

The build uses relative asset URLs. Serve app documents and assets with
`Cross-Origin-Embedder-Policy: credentialless` and
`Cross-Origin-Resource-Policy: cross-origin`. Use `Access-Control-Allow-Origin: *`
on this public directory so the sandboxed iframe can request app modules and
the Slides PDF worker from its opaque origin. Web-mode Vite preview sets these
headers on the mounted hosted-apps path.

### Portal catalog contract — `GET /api/apps`

Public, unauthenticated, `Cache-Control` at the portal's discretion. The web
shell is served from the portal origin (`/app`), so the request is same-origin;
other origins need `Access-Control-Allow-Origin` if they should see admin apps.

```json
{
  "apps": [
    {
      "id": "land.naia.quiz",
      "name": "Quiz",
      "icon": "❓",
      "url": "https://naia.land/hosted-apps/quiz/index.html",
      "description": "Daily quiz",
      "locales": ["ko", "en"],
      "version": "0.3.0",
      "visibility": "public"
    }
  ]
}
```

| Field | Required | Rule |
|---|---|---|
| `id` | yes | reverse-DNS (`land.naia.quiz`) or short slug (`quiz` → `land.naia.quiz`). |
| `name` | yes | default display name. |
| `icon` | no | short text/emoji (≤ 16 chars) shown in the app bar, or an `https://` / same-origin `/…` image shown only on the store card. |
| `url` | no | iframe entry. Must be `${portal}/hosted-apps/…` or under the apps sandbox origin (`VITE_NAIA_APPS_SANDBOX_ORIGIN`, default `https://apps-sandbox.naia.land`); any other origin is dropped. Missing → `${shell}/hosted-apps/<id>/index.html`. |
| `description` | no | default description. |
| `locales` | no | either `["ko","en"]` (offered languages; others hide the app) or `{ "ko": { "name": "…", "description": "…" } }` (per-locale text). |
| `version` | no | default `1.0.0`. |
| `visibility` | no | `public` (default), `listed`, `published`, `active` are shown; anything else (`draft`, `hidden`, `private`) is hidden. |

Compatibility: the current portal `AppRecord` shape (`slug`, `nameKo`,
`nameEn`, `descriptionKo`, `names`, `descriptions`, `comingSoon`) is also
accepted; `comingSoon: true` hides the item.

Rules the shell enforces:

- Admin apps cannot replace a built-in or gateway app with the same id.
- Stage-2 ids (`STAGE1_EXCLUDED_WEB_APP_IDS`) stay hidden.
- Admin apps are free hosted apps: no gateway purchase, no login needed.
  Paid apps must be registered as gateway products.
- At most 200 items are read.

The portal storefront at `/{locale}/apps` uses the same public catalog source
as the `/api/apps` response.
