# Release Process

This fork publishes Windows desktop builds only.

## What the Release Workflow Does

When a version tag is pushed, GitHub Actions:

1. Creates a GitHub Release.
2. Builds the Windows desktop app.
3. Uploads Windows `.exe` / `.msi` artifacts.

macOS packages, Linux packages, and browser-extension ZIPs are intentionally
not built or uploaded from this fork.

## How to Release

1. Update version files if needed.
2. Commit the version change.
3. Create and push a tag:

```bash
git tag v1.11.1
git push origin main
git push origin v1.11.1
```

The workflow `.github/workflows/release.yml` handles the Windows build and
release upload.

## Local Windows Build

```bash
pnpm install --frozen-lockfile
pnpm --filter @dlman/desktop tauri build
```

## Verification

After the workflow finishes, check the release page:

[Leostrange/dlman releases](https://github.com/Leostrange/dlman/releases)

Expected assets are Windows installers only.
