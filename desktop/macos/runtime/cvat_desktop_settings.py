"""Runtime settings for the local macOS desktop distribution."""

import os

from cvat.settings.production import *  # noqa: F401,F403

DEBUG = False
ALLOWED_HOSTS = ["127.0.0.1", "localhost"]
UI_URL = "http://127.0.0.1:28080"
CORS_ALLOW_CREDENTIALS = True
CORS_ORIGIN_WHITELIST = [UI_URL]
CSRF_TRUSTED_ORIGINS = [UI_URL]

# Electron serves the frontend and proxies API requests on loopback.
SENDFILE_BACKEND = "django_sendfile.backends.development"

IAM_OPA_URL = "http://127.0.0.1:28181"
IAM_OPA_DATA_URL = f"{IAM_OPA_URL}/v1/data"

# Auto-annotation: the desktop app talks to a Nuclio dashboard that the user runs
# separately (it needs Docker or Kubernetes). See desktop/macos/NUCLIO.md. The
# CVAT_NUCLIO_* variables are set by the app from nuclio.json; the production
# profile's default host ("nuclio") only resolves inside the Docker network.
NUCLIO["HOST"] = os.getenv("CVAT_NUCLIO_HOST", "localhost")  # noqa: F405
