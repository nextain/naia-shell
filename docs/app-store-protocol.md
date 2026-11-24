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
identity. This lets a voice incident be attributed to source generation before playback.
identity. This lets a voice incident be attributed to source generation before playback.

### 설치 앱에서 셸 기능 사용

`app.json`에 필요한 권한만 선언한다. 사용자 누름에 따른 클립보드 쓰기가 필요한 설치 앱은 `permissions`에 `clipboard.write`를 명시한다. 셸은 선언된 iframe에만 `clipboard-write`를 위임하며 클립보드 읽기는 위임하지 않는다. 예: `"permissions": ["model.ask", "speech", "locale"]`. 설치된 iframe은 부모에 메시지를 보내며 모든 요청에 자신의 `appId`와 고유한 영숫자·밑줄·하이픈 ID(1~100자)를 넣는다. 셸은 해당 iframe의 출처와 선언 권한을 확인하고 같은 앱·요청에만 결과를 전달한다.

| 방향 | 메시지 |
| --- | --- |
| 앱 → 셸 | `{type:"naia-app:ask", appId, id, prompt}` (최대 9,000자) |
| 셸 → 앱 | `{type:"naia-app:accepted", id}` 이후 `{type:"naia-app:response", id, text, error?}`; 실패·취소 시 text는 빈 문자열 |
| 앱 → 셸 | `{type:"naia-app:speak", appId, id, text}` (최대 2,000자), `{type:"naia-app:speak-cancel", appId, id}` |
| 셸 → 앱 | `{type:"naia-app:speech-result", id, status, error?}`; status는 `finished`, `cancelled`, `failed` |
| 셸 → 앱 | `{type:"naia-app:locale", locale}` (로드 및 셸 언어 변경) |

권한이 없거나 입력이 잘못되면 오류를 반환하며 응답이 오래 오지 않으면 timeout으로 종료한다. 타로, 강의, 블랙잭 등 앱 종류에 관계없이 같은 규격을 사용한다.

| 운영 규칙 | 동작 |
| --- | --- |
| 길이 | 질문 최대 9,000자, 낭독 최대 2,000자 |
| 응답 대기 | 120초 후 `timeout` 오류로 종료 |
| 동시 질문 | 셸이 다른 답변을 처리 중이면 새 질문을 busy 오류로 거부 |
| 중복 ID | 같은 종류의 요청 ID가 처리 중이면 새 요청에 `duplicate_id` 오류를 즉시 반환하고 기존 요청은 계속 정산 |
| 대화 기록 | 앱 질문에는 셸의 이전 대화 기록을 붙이지 않는다. 앱 턴은 채팅에 앱 이름과 함께 표시한다. |
| 낭독 상태 | `finished` 완료, `cancelled` 취소, `failed` 실패 (`error`에 사유) |

앱 질문에는 채팅 대화 기록을 붙이지 않는다. 짝 에이전트의 기억 불러오기는 일반 채팅과 같이 동작하며, 앱 질문 전용 격리는 에이전트 쪽 과제로 따로 다룬다.
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
