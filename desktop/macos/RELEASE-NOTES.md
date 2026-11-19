# CVAT Desktop for macOS — Preview 0.3.0

This is an experimental Apple Silicon desktop build of CVAT Community.

## What is new in 0.3.0

- **SAM 2 tracking (experimental).** *CVAT Desktop → SAM 2 tracking…* (⌘⇧T): pick a polygon, mask or
  rectangle on a frame, choose how many frames to follow (for example 100) and the direction, and SAM 2.1
  creates a new track in the same job. It runs on this Mac (Apple GPU or CPU); no Docker or Nuclio is needed.
  The SAM 2 code is inside the app; PyTorch (about 1 GB) and the model file (156-324 MB) are downloaded
  once, only after you confirm in the window. See `desktop/macos/SAM2.md`.

## What is new in 0.2.1

- **Fixed:** relaunching the app could fail with `pg_ctl: another server might be running` /
  `lock file "postmaster.pid" already exists` when PostgreSQL from the previous run had not shut down yet.
  The app now reuses (or cleanly stops) a PostgreSQL server left over from an earlier run, and shutdown
  falls back to signalling the server directly if `pg_ctl stop` fails.

## What is new in 0.2.0

- **Self-contained.** Python 3.12, PostgreSQL 15, Redis, Kvrocks, OPA and the native libraries
  they need are inside the app. **Homebrew and the Xcode Command Line Tools are no longer required**,
  and nothing is installed on first launch.
- Optional connection to a Nuclio server for auto-annotation (see below).

## Included

- Native Electron/Chromium desktop window.
- CVAT frontend, backend, PostgreSQL, Redis, Kvrocks and OPA started locally.
- Local RQ workers and scheduler.
- Persistent user data in macOS Application Support.
- A local administrator account is created on first launch.

## Requirements and limitations

- Apple Silicon (arm64), macOS 15 or newer.
- Docker is not used by the app.
- This preview is unsigned and not notarized. macOS Gatekeeper may require Control-click > Open
  (or System Settings > Privacy & Security > Open Anyway) for the first launch.
- The download is large because the whole runtime is bundled.
- Analytics/ClickHouse are not included.
- **Auto-annotation:** Nuclio is not bundled, because it needs Docker or Kubernetes. If you run a
  Nuclio server yourself, choose *CVAT Desktop → Auto-annotation (Nuclio) settings…* to connect the
  app to it. See `desktop/macos/NUCLIO.md`. This path has not been tested end to end.
- If you used 0.1.0, your data is kept. The `python-env` folder it created in Application Support is
  no longer used and can be deleted.
- This is a preview; validate it on a copy of important data and keep regular backups.

The release is built from the CVAT fork's native macOS work branch. It is not an official CVAT.ai desktop release.
