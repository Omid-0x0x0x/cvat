# CVAT Desktop for macOS — Preview 0.1.0

This is an experimental Apple Silicon desktop build of CVAT Community.

## Included

- Native Electron/Chromium desktop window.
- CVAT frontend, backend, PostgreSQL, Redis, Kvrocks and OPA started locally.
- Local RQ workers and scheduler.
- Persistent user data in macOS Application Support.
- A local administrator account is created on first launch.

## Requirements and limitations

- Apple Silicon (arm64), macOS 15 or newer.
- Homebrew is required. On first launch the app installs missing native formulas and Python packages automatically.
- Docker is not used.
- This preview is unsigned and not notarized. macOS Gatekeeper may require Control-click > Open for the first launch.
- Analytics/ClickHouse and Nuclio-based serverless auto-annotation functions are not included in this first local profile.
- This is a preview; validate it on a copy of important data and keep regular backups.

The release is built from the CVAT fork's native macOS work branch. It is not an official CVAT.ai desktop release.
