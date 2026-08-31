# Windows release and updater process

This is the release gate for a public Windows Naia build. A successful EXE/MSI
build alone is not a completed release.

## Build contract

1. Keep `packages/shell/package.json`, `packages/shell/src-tauri/Cargo.toml`,
   the `naia-shell` package entry in `Cargo.lock`, and `releases/vX.Y.Z.yaml`
   on the same version.
2. Keep the updater endpoint on
   `nextain/naia-shell/releases/latest/download/latest.json`.
3. Windows must generate updater artifacts; Linux and macOS remain disabled
   until their signing and publishing contracts are restored. Linux artifacts
   are now published without them — see `linux-release-process.md`. That
   publishing path relies on Linux releases staying prereleases, because
   GitHub resolves `releases/latest` to the newest non-draft, non-prerelease
   tag. Promoting a release out of prerelease without a verified `latest.json`
   in the same release 404s the updater endpoint for every installed client.
4. The approved local key pair is stored outside this repository at
   `D:/alpha-adk/data-private/key/naia-tauri.key` and `.key.pub`. The private
   key is encrypted. Local runs may set `TAURI_SIGNING_PRIVATE_KEY` to that
   absolute path only when a password source is already available; never read,
   print, copy, decrypt, or commit either secret. Normal signed releases use the
   existing GitHub Actions `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets.
5. Run the platform staging entrypoint, not a raw `tauri build`:

   ```powershell
   pnpm -C packages/shell run tauri:installer
   ```

## Artifact gate

The release is blocked unless all of these exist and are non-empty:

- Windows NSIS installer and its matching `.sig`
- Windows MSI and its matching `.sig`
- `latest.json`
- SHA-256 checksum manifest

`latest.json` must use the exact released version and the signature text from
the updater artifact that its Windows URL downloads. Renaming an artifact is
allowed only when its bytes and matching signature remain unchanged.

## Publishing and compatibility

Publish the installers, signatures, checksum manifest, and `latest.json` in the
same `nextain/naia-shell` GitHub release. Before updating the website, verify the
public asset URLs and both updater endpoints with unauthenticated HTTP requests.

Naia v0.1.8 and v0.1.9 were shipped with the former
`nextain/naia-os/releases/latest/download/latest.json` endpoint. While either
version remains installed in the field, publish the same verified metadata at
that compatibility endpoint. The metadata may point to the canonical
`nextain/naia-shell` artifact.

An updater network, metadata, or signature failure is an error. It must never
be presented as “latest version.”

## Release verification

1. Check the generated Tauri config has Windows updater artifacts enabled.
2. Verify installer sizes and SHA-256 hashes with the repository artifact gate.
3. Verify the public `latest.json` schema, URL, signature, and downloaded bytes.
4. From an installed v0.1.8 or v0.1.9 client, check that v0.2.0 is discovered,
   downloaded, installed, relaunched, and reports the new version.
5. Smoke-test a clean install: Settings login, non-zero/valid credit lookup,
   first LLM response, host voice installation, preset voice, uploaded reference
   voice, synthesis, and lip sync.
6. Copy the exact verified EXE/MSI and checksum material to the release drive;
   compare hashes after copying.

Only after these gates pass may naia.land change its download links and public
release post.
