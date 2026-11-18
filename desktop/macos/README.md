# CVAT Desktop for macOS (Native, Docker-free)

## Status

This directory is the beginning of the native macOS distribution effort. It is **not yet a
working desktop application** and it must not be advertised as a release. The first milestone
is a real Apple Silicon compatibility build of the existing CVAT backend dependencies and UI.

The target is a local application that runs CVAT services directly on macOS. Docker and a
separate browser are not part of the target design.

## Why this is a separate porting task

The current CVAT deployment is a multi-process server stack, not just the React UI. The
repository's Docker deployment starts PostgreSQL, two Redis-protocol stores (Redis and
Kvrocks), the Django/ASGI server, several RQ workers, OPA, the UI, and a reverse proxy.
Analytics adds ClickHouse, Vector, and Grafana.

The server image also prepares native libraries and media components (including FFmpeg,
OpenH264, LDAP/SASL, and XML security). A macOS `.app` wrapper around the web UI alone would
not be a working local CVAT installation.

## Intended product shape

- Apple Silicon first (arm64); Intel can be added after the first native runtime works.
- Electron/Chromium desktop window for the existing CVAT UI.
- Native backend and worker processes managed by the desktop app.
- Native PostgreSQL, Redis-compatible stores, and OPA; no Docker daemon.
- Analytics disabled by default in the first local profile to keep the runtime smaller.
- Persistent user data under `~/Library/Application Support/CVAT Desktop`, separate from
  the replaceable application bundle.
- A signed/notarized DMG can be added when the app bundle and its runtime are stable.

## First milestone in CI

`.github/workflows/macos-native-compatibility.yml` runs on a GitHub-hosted Apple Silicon
macOS runner and attempts to:

1. Install the native build libraries needed by Python packages.
2. Install the pinned CVAT backend requirements using Python 3.12.
3. Import-check the backend's native Python modules.
4. Build the existing CVAT React UI.

A successful run proves only that these source components build on the runner. It does **not**
prove that PostgreSQL, the queue stores, OPA, all workers, and the desktop lifecycle work
together natively. No DMG is published by this compatibility workflow.

## Release gate

Do not publish a user-facing macOS release until all of the following pass on Apple Silicon:

- Database initialization/migrations and restart persistence.
- Both queue backends, RQ workers, and scheduled jobs.
- OPA policy evaluation and authentication.
- Media upload, video decoding, annotation save/reload, import/export.
- App startup/shutdown, crash recovery, and clean uninstall/update.
- A clean-machine test without Docker, Homebrew, Python, Node, or manually installed services.

The Homebrew packages used by CI are build-time tools only. They are not runtime requirements
for the intended end-user DMG.
