# Linux release process

This is the release gate for public Linux Naia artifacts. A successful CI build
alone is not a completed release.

Linux is not at parity with Windows. It has no code signing, no updater
artifacts, and no entry in `latest.json`. What it has is a build the CI already
proves and a publishing path this document opens. Read
`windows-release-process.md` for the platform that does have a full release
contract.

## Build contract

1. Keep `packages/shell/package.json`, `packages/shell/src-tauri/Cargo.toml`,
   the `naia-shell` package entry in `Cargo.lock`, and `releases/vX.Y.Z.yaml`
   on the same version.
2. `platform-matrix.json` leaves `createUpdaterArtifacts` off for Linux. Do not
   turn it on without also restoring a signing and publishing contract — an
   unsigned `.sig` is worse than no updater at all.
3. Linux builds on the `ubuntu-24.04` leg of `build-installers` and produces
   three artifacts: an AppImage (archived as `.AppImage.tar.gz`), a `.deb`, and
   a `.rpm`. CI already installs the deb and proves the bundled Node runs, and
   extracts the AppImage to prove `naia-shell` and `node` are executable inside.
4. The release inputs are the CI artifacts from **the run whose `head_sha` is
   the release tag's commit**, not from the branch build that happens to be
   newest. Resolve it explicitly:

   ```bash
   gh api "repos/nextain/naia-shell/actions/runs?head_sha=$(git rev-parse vX.Y.Z^{commit})" \
     --jq '.workflow_runs[] | select(.name=="build installers") | .id'
   ```

## Artifact gate

Run the same predicate CI runs, against the downloaded bytes:

```bash
node -e "import('./packages/shell/scripts/verify-artifacts.mjs')
  .then(m => m.runCli({ platform: 'linux', bundleDir: '<downloaded bundle dir>' }))"
```

It re-derives every SHA-256 and writes `artifacts.sha256`. Compare that file
against the one CI produced inside the artifact. **They must be byte-identical.**
A mismatch means the bytes you are about to publish are not the bytes CI
verified, and the release stops there.

The release is blocked unless all of these exist and are non-empty:

- `Naia_X.Y.Z_amd64.AppImage.tar.gz`
- `Naia_X.Y.Z_amd64.deb`
- `Naia-X.Y.Z-1.x86_64.rpm`
- `artifacts.sha256`

## Publishing — the constraint that governs everything

`https://github.com/nextain/naia-shell/releases/latest/download/latest.json` is
the updater endpoint every installed Windows client polls. GitHub resolves
`latest` to **the most recent release that is neither a draft nor a
prerelease.**

So a Linux-only release published as a normal release moves `latest` to a tag
that has no `latest.json`, that URL starts returning 404, and every installed
Windows client loses updates. Silently — the client reports a network error, not
a broken release.

Therefore:

- **Publish Linux artifacts as a prerelease** (`gh release create --prerelease`)
  whenever the release does not also carry the complete Windows set and a
  verified `latest.json`. A prerelease is publicly downloadable but invisible to
  `latest`.
- **Do not use a draft** when anything needs to fetch the assets anonymously.
  Draft assets require an authorization token. The Naia OS image build layers
  the shell straight from the release RPM URL, so a draft release breaks it.
- Promoting the release out of prerelease is the Windows release's job, and only
  after `windows-release-process.md` has been satisfied.

After publishing, verify with unauthenticated requests:

```bash
curl -sI -o /dev/null -w '%{http_code}\n' \
  https://github.com/nextain/naia-shell/releases/download/vX.Y.Z/Naia-X.Y.Z-1.x86_64.rpm   # 200
curl -sL https://github.com/nextain/naia-shell/releases/latest/download/latest.json | jq -r .version
```

The second command must still report the previous released Windows version. If
it 404s or reports the new version, the updater feed has moved and the release
must be pulled back to prerelease immediately.

## The RPM is also an OS input

The Naia OS image layers this exact RPM with `rpm-ostree`. That imposes two
requirements the desktop release would not otherwise have:

1. **Every file installs under `/usr`.** rpm-ostree cannot layer a package that
   writes to `/opt` or `/var`. Check before publishing:

   ```bash
   rpm -qp --list Naia-X.Y.Z-1.x86_64.rpm | awk -F/ '{print "/"$2}' | sort -u
   ```

   Anything other than a single `/usr` line blocks the OS image.

2. **The package name is `naia`, the binary is `naia-shell`.** They differ. The
   image gate asserts `rpm -q naia` and `/usr/bin/naia-shell`; asserting the
   package as `naia-shell` is a false RED, and asserting the binary as `naia` is
   a false GREEN.

The shell links against a vendored `libvosk.so` resolved through
`RUNPATH=$ORIGIN:$ORIGIN/../lib/Naia`. From `/usr/bin` that resolves to
`/usr/lib/Naia/libvosk.so`, which the RPM ships. A build that drops it produces
an app that exits on launch with no window — the failure that kept the Flatpak
path broken for months.

## Release verification

1. Verify artifact sizes and SHA-256 with the repository artifact gate above.
2. Verify the public asset URLs with unauthenticated requests.
3. Verify the Windows updater endpoint is unchanged.
4. Install the `.deb` or `.rpm` on a clean machine and check: first launch, the
   Settings login, a non-zero credit lookup, a first LLM response, and that
   voice does not fall back silently.
5. Linux has no in-app updater. Say so in the release notes: updating means
   downloading and reinstalling.

Only after these gates pass may naia.land change its Linux download links.
