# DLMan for Windows

Windows-only DLMan build with Russian localization.

This fork is maintained for Windows users. It does not publish macOS builds,
Linux builds, or browser-extension packages.

## What's Included

- Windows desktop app (`.exe` / `.msi`)
- Russian locale (`ru`, `Русский`)
- English and Persian locales inherited from upstream
- Multi-segment downloads
- Queue and category management
- Scheduling, speed limits, and credentials support
- Dark and light themes

## Download

Use the releases page for Windows installers:

[Download DLMan for Windows](https://github.com/Leostrange/dlman/releases/latest)

Expected release assets:

| Platform | Files |
| --- | --- |
| Windows | `.exe`, `.msi` |

No macOS, Linux, or browser-extension artifacts are published from this fork.

## Russian Localization

Russian localization is registered as:

```ts
{ code: "ru", name: "Russian", nativeName: "Русский", dir: "ltr", font: "inter" }
```

The localization covers the desktop UI, including shortcuts, queue management,
time picker strings, default category and queue names, units, and common
fallback strings.

## Development

Install dependencies:

```bash
pnpm install
```

Run the desktop app:

```bash
pnpm --filter @dlman/desktop tauri dev
```

Build the Windows desktop app:

```bash
pnpm --filter @dlman/desktop tauri build
```

## Release Scope

This fork intentionally targets Windows only.

- Supported: Windows desktop app
- Not published: macOS packages
- Not published: Linux packages
- Not published: browser extensions

## Upstream

Original project: [novincode/dlman](https://github.com/novincode/dlman)

## License

MIT License. See [LICENSE](LICENSE).
