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

### 설치 앱에서 셸 기능 사용

`app.json`에 필요한 권한만 선언한다. 예: `"permissions": ["model.ask", "speech", "locale"]`. 설치된 iframe은 부모에 메시지를 보내며 모든 요청에 자신의 `appId`와 고유한 영숫자·밑줄·하이픈 ID(1~100자)를 넣는다. 셸은 해당 iframe의 출처와 선언 권한을 확인하고 같은 앱·요청에만 결과를 전달한다.

| 방향 | 메시지 |
| --- | --- |
| 앱 → 셸 | `{type:"naia-app:ask", appId, id, prompt}` (최대 9,000자) |
| 셸 → 앱 | `{type:"naia-app:accepted", id}` 이후 `{type:"naia-app:response", id, text, error?}`; 실패·취소 시 text는 빈 문자열 |
| 앱 → 셸 | `{type:"naia-app:speak", appId, id, text}` (최대 2,000자), `{type:"naia-app:speak-cancel", appId, id}` |
| 셸 → 앱 | `{type:"naia-app:speech-result", id, status, error?}`; status는 `finished`, `cancelled`, `failed` |
| 셸 → 앱 | `{type:"naia-app:locale", locale}` (로드 및 셸 언어 변경) |

권한이 없거나 입력이 잘못되면 오류를 반환하며 응답이 오래 오지 않으면 timeout으로 종료한다. 타로, 강의, 블랙잭 등 앱 종류에 관계없이 같은 규격을 사용한다.
