# CVAT Desktop for macOS

This is the native, Docker-free desktop distribution work in progress.

## Product goal

- An Electron/Chromium macOS app; no external browser tab.
- Native CVAT services bound to loopback only.
- Projects and service data persist under macOS Application Support.
- Docker is not used.

## Current app bootstrap design

The first launch checks for Homebrew and installs missing native prerequisites:
Python 3.12, PostgreSQL 15, Redis, FFmpeg, OpenLDAP, Cyrus SASL, XMLSec, Cairo, and Pango.
It then creates a private Python virtual environment in Application Support, installs the
CVAT production requirements, initializes PostgreSQL, starts Redis, Kvrocks and OPA, runs
Django and Redis migrations, and starts the API and RQ worker processes.

The app bundle is expected to contain:
- The built CVAT React frontend.
- CVAT backend source and Python requirements.
- A native ARM64 Kvrocks binary.
- An OPA binary.
- The Electron application and local API/static-file proxy.

Homebrew is currently a first-run prerequisite. The app installs missing formulas itself,
but a fully self-contained DMG without Homebrew or other external runtime dependencies
requires additional dependency bundling and macOS compatibility tests.

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
