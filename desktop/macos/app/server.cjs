const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const BACKEND_PREFIXES = [
  "/api",
  "/admin",
  "/django-rq",
  "/documentation",
  "/profiler",
  "/data",
];

function safeFile(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = path.resolve(root, "." + decoded);
  return candidate === root || candidate.startsWith(root + path.sep) ? candidate : null;
}

function withHeaders(res, contentType) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "credentialless",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  });
  return res;
}

function sendStatic(res, root, pathname, fallback = false) {
  const filePath = safeFile(root, pathname);
  if (!filePath) {
    res.writeHead(400).end("Bad path");
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    const target = !statError && stat.isFile() ? filePath : (fallback ? path.join(root, "index.html") : null);
    if (!target) {
      res.writeHead(404).end("Not found");
      return;
    }

    const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
    const headers = {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": path.extname(target) === ".wasm" ? "require-corp" : "credentialless",
    };
    if (target.includes(path.sep + "assets" + path.sep)) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    } else {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    }
    res.writeHead(200, headers);
    fs.createReadStream(target).pipe(res);
  });
}

function proxy(req, res, backendUrl) {
  const upstream = new URL(req.url, backendUrl);
  const headers = { ...req.headers, host: upstream.host };
  headers["x-forwarded-host"] = req.headers.host || upstream.host;
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-for"] = req.socket.remoteAddress || "127.0.0.1";
  delete headers["accept-encoding"];

  const proxyReq = http.request({
    hostname: upstream.hostname,
    port: Number(upstream.port),
    method: req.method,
    path: upstream.pathname + upstream.search,
    headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("CVAT backend unavailable: " + error.message);
  });
  req.pipe(proxyReq);
}

function createCvatServer({ frontendDir, staticDir, backendUrl, port = 28080 }) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1:" + port).pathname;

    if (pathname.startsWith("/static/")) {
      sendStatic(res, staticDir, pathname.slice("/static".length), false);
      return;
    }

    if (BACKEND_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"))) {
      proxy(req, res, backendUrl);
      return;
    }

    sendStatic(res, frontendDir, pathname === "/" ? "/index.html" : pathname, true);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

module.exports = { createCvatServer };
