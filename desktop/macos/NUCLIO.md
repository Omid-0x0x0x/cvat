# Auto-annotation with Nuclio (CVAT Desktop for macOS)

CVAT runs automatic annotation (detectors, interactors, trackers) as **Nuclio serverless
functions**. Nuclio starts every function as a container, so it needs **Docker (or Kubernetes)**.
Nuclio is therefore **not bundled** in the CVAT Desktop app. The app only contains the client side:
once you run a Nuclio server yourself, CVAT Desktop can talk to it.

## 1. Run a Nuclio dashboard

Install Docker Desktop, then start the dashboard with the compose file from the CVAT source tree
(`components/serverless/docker-compose.serverless.yml` shows the image and settings), for example:

```bash
docker run -d --name nuclio -p 8070:8070 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e NUCLIO_CHECK_FUNCTION_CONTAINERS_HEALTHINESS=true \
  -e NUCLIO_DASHBOARD_DEFAULT_FUNCTION_MOUNT_MODE=volume \
  quay.io/nuclio/dashboard:1.16.3-amd64
```

The `amd64` image runs under emulation on Apple Silicon. Check the Nuclio releases for a native
`arm64` image before relying on it.

## 2. Deploy functions

Use the CVAT serverless tooling (`serverless/deploy_cpu.sh`, `serverless/deploy_gpu.sh`, or the
`nuctl` CLI) against the dashboard, as described in the CVAT documentation for auto-annotation.
Many of the published functions are x86-64 images; verify that the one you need works on Apple Silicon.

## 3. Point CVAT Desktop at it

Choose **CVAT Desktop → Auto-annotation (Nuclio) settings…**. The app creates `nuclio.json` in
`~/Library/Application Support/cvat-desktop-macos/` and opens it:

```json
{
  "enabled": true,
  "scheme": "http",
  "host": "localhost",
  "port": 8070,
  "invokeMethod": "direct",
  "namespace": "nuclio",
  "timeoutSeconds": 120
}
```

Set `"enabled": true`, save, and restart CVAT Desktop. The values are passed to the CVAT backend as
the standard `CVAT_NUCLIO_*` settings. With `"invokeMethod": "direct"` the backend calls each function on
`localhost` at the port Nuclio published for it.

## Status

The connection settings are in the app, but this has **not been tested end to end** with a running
Nuclio server on macOS.
