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
