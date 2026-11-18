"""Runtime settings for the local macOS desktop distribution."""

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
