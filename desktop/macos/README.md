# CVAT Desktop for macOS

This is the native, Docker-free desktop distribution work in progress.

## Product goal

- An Electron/Chromium macOS app; no external browser tab.
- Native CVAT services bound to loopback only.
- Projects and service data persist under macOS Application Support.
- Docker is not used.

## Current app design

The app is self-contained. `desktop/macos/app/vendor` is filled by the CI workflow and shipped
inside the DMG:

- `python/` - python-build-standalone CPython 3.12 with the CVAT production requirements installed.
- `lib/` - native libraries (OpenLDAP, Cyrus SASL, XMLSec, ...) copied from Homebrew at build time
  and re-linked with `@loader_path` by `scripts/relocate_macho.py`.
- `postgres/` - relocatable PostgreSQL 15 binaries.
- `redis-server`, `kvrocks`, `opa` - native ARM64 binaries.

On launch the app initializes PostgreSQL in Application Support, starts Redis, Kvrocks and OPA,
runs the Django and Redis migrations, and starts the API, RQ worker and scheduler. Nothing is
downloaded or compiled on the user's Mac, so neither Homebrew nor the Xcode Command Line Tools
are needed.

Homebrew is used only on the CI runner. The workflow fails the build if any bundled Mach-O file
still references a library outside `/usr/lib` or `/System`, and it runs the packaged app's real
runtime with `/opt/homebrew` moved out of the way.

Auto-annotation needs a separately run Nuclio server: see `NUCLIO.md`.

`scripts/native-cvat-smoke.sh` is an older development script that still expects Homebrew.

## Build requirements

- Apple Silicon Mac.
- macOS 15 or later.
- GitHub Actions runner `macos-15` for release builds.
- The DMG is not signed or notarized yet. A Developer ID certificate and Apple notarization
  credentials are required for frictionless distribution outside the Mac App Store.

## Release gate

Do not call this a stable release until a clean macOS 15 Apple Silicon machine has passed:
service startup, database migrations, initial administrator account creation, task creation,
video upload, annotation save/reload, import/export, update persistence, and clean shutdown.
