const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const PORTS = { postgres: 25432, redis: 26379, kvrocks: 26666, opa: 28181, backend: 27000, desktop: 28080 };

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForPort(port, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await delay(500);
  }
  throw new Error("Timed out waiting for local service on port " + port);
}

async function waitForHttp(url, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await new Promise((resolve) => {
      const request = http.get(url, (response) => { response.resume(); resolve(response.statusCode || 0); });
      request.setTimeout(1500, () => { request.destroy(); resolve(0); });
      request.on("error", () => resolve(0));
    });
    if (status >= 200 && status < 300) return;
    await delay(1000);
  }
  throw new Error("CVAT API did not become ready: " + url);
}

function createRuntime({ resourcesDir, userDataDir, onStatus = () => {} }) {
  const children = new Map();
  let postgresStarted = false;
  let uiServer = null;
  let env = null;
  let paths = null;
  let stopped = false;

  const backendDir = path.join(resourcesDir, "backend");
  const runtimeDir = path.join(resourcesDir, "runtime");
  const frontendDir = path.join(resourcesDir, "frontend");
  const staticDir = path.join(userDataDir, "cvat-data", "static");
  const dataDir = path.join(userDataDir, "services");
  const logDir = path.join(userDataDir, "logs");

  function status(message) { onStatus({ message }); }
  function log(name, text) {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, name + ".log"), text);
  }

  async function command(file, args, options = {}) {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd || backendDir,
      env: options.env || env || process.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeout || 0,
    });
    if (result.stdout) log("bootstrap", result.stdout);
    if (result.stderr) log("bootstrap", result.stderr);
    return result;
  }

  function startProcess(name, file, args, options = {}) {
    if (children.has(name)) return children.get(name);
    fs.mkdirSync(logDir, { recursive: true });
    const stream = fs.createWriteStream(path.join(logDir, name + ".log"), { flags: "a" });
    const child = spawn(file, args, {
      cwd: options.cwd || backendDir,
      env: options.env || env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stream.write(chunk));
    child.stderr.on("data", (chunk) => stream.write(chunk));
    child.on("error", (error) => stream.write("\nProcess error: " + error.message + "\n"));
    child.on("exit", (code, signal) => {
      stream.write("\nProcess exited: code=" + code + " signal=" + signal + "\n");
      stream.end();
      if (children.get(name) === child) children.delete(name);
    });
    children.set(name, child);
    return child;
  }

  async function ensureHomebrew() {
    const candidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", path.join(os.homedir(), ".homebrew", "bin", "brew")];
    const brew = candidates.find((candidate) => fs.existsSync(candidate));
    if (!brew) {
      throw new Error("Homebrew is required for first launch. Install it from https://brew.sh, then reopen CVAT Desktop. Docker is not used.");
    }

    status("Checking native macOS dependencies…");
    const formulas = ["python@3.12", "postgresql@15", "redis", "ffmpeg", "openldap", "cyrus-sasl", "libxmlsec1", "cairo", "pango"];
    const missing = [];
    for (const formula of formulas) {
      try {
        await execFileAsync(brew, ["list", "--versions", formula], { maxBuffer: 1024 * 1024 });
      } catch {
        missing.push(formula);
      }
    }
    if (missing.length) {
      status("Installing native macOS components (" + missing.length + ")…");
      await command(brew, ["install", ...missing], { cwd: userDataDir, timeout: 30 * 60 * 1000 });
    }

    const prefixes = {};
    for (const formula of formulas) {
      const result = await execFileAsync(brew, ["--prefix", formula], { maxBuffer: 1024 * 1024 });
      prefixes[formula] = result.stdout.trim();
    }
    return { brew, prefixes };
  }

  async function initialize() {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    if (!fs.existsSync(path.join(backendDir, "manage.py")) || !fs.existsSync(path.join(frontendDir, "index.html"))) {
      throw new Error("The packaged CVAT backend or frontend is missing. This build is incomplete.");
    }

    status("Preparing native services…");
    const homebrew = await ensureHomebrew();
    paths = homebrew.prefixes;
    const python = path.join(paths["python@3.12"], "bin", "python3.12");
    const pgBin = path.join(paths["postgresql@15"], "bin");
    const redisBin = path.join(paths.redis, "bin");
    const xmlsecPrefix = paths["libxmlsec1"];
    const ldapPrefix = paths.openldap;
    const saslPrefix = paths["cyrus-sasl"];
    const libxml2Prefix = (await execFileAsync(homebrew.brew, ["--prefix", "libxml2"])).stdout.trim();

    const kvrocksBinary = path.join(resourcesDir, "vendor", "kvrocks");
    const opaBinary = path.join(resourcesDir, "vendor", "opa");
    if (!fs.existsSync(kvrocksBinary) || !fs.existsSync(opaBinary)) {
      throw new Error("Native Kvrocks or OPA binaries are missing from this build.");
    }

    env = {
      ...process.env,
      PATH: [
        path.join(paths["python@3.12"], "bin"), pgBin, redisBin,
        path.dirname(kvrocksBinary), path.dirname(opaBinary), process.env.PATH || "",
      ].join(path.delimiter),
      PYTHONPATH: runtimeDir + path.delimiter + backendDir,
      DJANGO_SETTINGS_MODULE: "cvat_desktop_settings",
      CVAT_BASE_DIR: path.join(userDataDir, "cvat-data"),
      CVAT_HOST: "127.0.0.1:28080",
      CVAT_BASE_URL: "http://127.0.0.1:28080",
      CVAT_POSTGRES_HOST: "127.0.0.1",
      CVAT_POSTGRES_PORT: String(PORTS.postgres),
      CVAT_POSTGRES_DBNAME: "cvat",
      CVAT_POSTGRES_USER: "cvat",
      CVAT_POSTGRES_PASSWORD: "",
      CVAT_REDIS_INMEM_HOST: "127.0.0.1",
      CVAT_REDIS_INMEM_PORT: String(PORTS.redis),
      CVAT_REDIS_ONDISK_HOST: "127.0.0.1",
      CVAT_REDIS_ONDISK_PORT: String(PORTS.kvrocks),
      CVAT_OPA_URL: "http://127.0.0.1:" + PORTS.opa,
      CVAT_ANALYTICS: "0",
      DATUMARO_HEADLESS: "1",
      XMLSEC1_CONFIG: path.join(xmlsecPrefix, "bin", "xmlsec1-config"),
      CPPFLAGS: [
        "-I" + path.join(ldapPrefix, "include"), "-I" + path.join(saslPrefix, "include"),
        "-I" + path.join(xmlsecPrefix, "include"), "-I" + path.join(libxml2Prefix, "include"),
      ].join(" "),
      LDFLAGS: [
        "-L" + path.join(ldapPrefix, "lib"), "-L" + path.join(saslPrefix, "lib"),
        "-L" + path.join(xmlsecPrefix, "lib"), "-L" + path.join(libxml2Prefix, "lib"),
      ].join(" "),
      PKG_CONFIG_PATH: ["openldap", "cyrus-sasl", "libxmlsec1", "cairo", "pango"].map((key) => path.join(paths[key], "lib", "pkgconfig")).concat([path.join(libxml2Prefix, "lib", "pkgconfig")]).join(path.delimiter),
    };

    fs.mkdirSync(env.CVAT_BASE_DIR, { recursive: true });
    fs.mkdirSync(path.join(dataDir, "postgres"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "redis"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "kvrocks"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "kvrocks-logs"), { recursive: true });

    status("Preparing the Python environment…");
    const venvDir = path.join(userDataDir, "python-env");
    if (!fs.existsSync(path.join(venvDir, "bin", "python"))) {
      await command(python, ["-m", "venv", venvDir], { cwd: userDataDir });
    }
    const venvPython = path.join(venvDir, "bin", "python");
    const requirements = path.join(backendDir, "cvat", "requirements", "production.txt");
    const marker = path.join(venvDir, ".cvat-requirements-" + require("crypto").createHash("sha256").update(fs.readFileSync(requirements)).digest("hex").slice(0, 12));
    if (!fs.existsSync(marker)) {
      status("Installing CVAT Python packages (first launch only)…");
      await command(venvPython, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], { cwd: userDataDir, timeout: 10 * 60 * 1000 });
      await command(venvPython, ["-m", "pip", "install", "-r", requirements], { cwd: backendDir, timeout: 45 * 60 * 1000 });
      fs.writeFileSync(marker, new Date().toISOString());
    }
    env.PATH = path.join(venvDir, "bin") + path.delimiter + env.PATH;
    paths.python = venvPython;

    status("Starting PostgreSQL…");
    const pgData = path.join(dataDir, "postgres");
    const initdb = path.join(pgBin, "initdb");
    const pgCtl = path.join(pgBin, "pg_ctl");
    if (!fs.existsSync(path.join(pgData, "PG_VERSION"))) {
      await command(initdb, ["-D", pgData, "-U", "cvat", "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8"], { cwd: userDataDir });
    }
    await command(pgCtl, ["-D", pgData, "-l", path.join(logDir, "postgres.log"), "-o", "-h 127.0.0.1 -p " + PORTS.postgres, "-w", "start"], { cwd: userDataDir });
    postgresStarted = true;
    try {
      await command(path.join(pgBin, "createdb"), ["-h", "127.0.0.1", "-p", String(PORTS.postgres), "-U", "cvat", "cvat"], { cwd: userDataDir });
    } catch (error) {
      if (!String(error.stderr || error.message).toLowerCase().includes("already exists")) throw error;
    }

    status("Starting Redis and the on-disk cache…");
    startProcess("redis", path.join(redisBin, "redis-server"), [
      "--bind", "127.0.0.1", "--port", String(PORTS.redis),
      "--dir", path.join(dataDir, "redis"), "--appendonly", "yes",
    ]);
    const kvConfig = [
      "bind 127.0.0.1", "port " + PORTS.kvrocks, "daemonize no",
      "log-dir " + path.join(dataDir, "kvrocks-logs"),
      "dir " + path.join(dataDir, "kvrocks"),
    ].join("\n") + "\n";
    const kvConfigPath = path.join(dataDir, "kvrocks.conf");
    fs.writeFileSync(kvConfigPath, kvConfig);
    startProcess("kvrocks", kvrocksBinary, ["-c", kvConfigPath]);

    status("Starting local policy service…");
    startProcess("opa", opaBinary, [
      "run", "--server", "--addr=127.0.0.1:" + PORTS.opa, "--log-level=error",
      "--set=services.cvat.url=http://127.0.0.1:" + PORTS.backend,
      "--set=bundles.cvat.service=cvat",
      "--set=bundles.cvat.resource=/api/auth/rules",
      "--set=bundles.cvat.polling.min_delay_seconds=5",
      "--set=bundles.cvat.polling.max_delay_seconds=15",
    ]);

    await Promise.all([waitForPort(PORTS.postgres), waitForPort(PORTS.redis), waitForPort(PORTS.kvrocks), waitForPort(PORTS.opa)]);

    status("Initializing CVAT data…");
    await command(venvPython, ["manage.py", "migrate", "--noinput"], { cwd: backendDir, timeout: 10 * 60 * 1000 });
    await command(venvPython, ["manage.py", "migrateredis"], { cwd: backendDir, timeout: 5 * 60 * 1000 });
    await command(venvPython, ["manage.py", "syncperiodicjobs"], { cwd: backendDir, timeout: 5 * 60 * 1000 });
    await command(venvPython, ["manage.py", "collectstatic", "--noinput"], { cwd: backendDir, timeout: 5 * 60 * 1000 });

    status("Starting CVAT API and background workers…");
    startProcess("backend", venvPython, ["-m", "uvicorn", "cvat.asgi:application", "--host", "127.0.0.1", "--port", String(PORTS.backend), "--workers", "1"]);
    await waitForHttp("http://127.0.0.1:" + PORTS.backend + "/api/server/about");

    startProcess("worker", venvPython, [
      "manage.py", "rqworker", "-v", "3", "import", "export", "annotation", "webhooks",
      "notifications", "quality_reports", "cleaning", "chunks", "consensus",
    ]);
    startProcess("scheduler", venvPython, ["rqscheduler.py", "--host", "127.0.0.1", "--port", String(PORTS.redis), "--password", "", "-i", "30"]);

    status("Opening the annotation workspace…");
    const { createCvatServer } = require("./server.cjs");
    uiServer = await createCvatServer({
      frontendDir,
      staticDir,
      backendUrl: "http://127.0.0.1:" + PORTS.backend,
      port: PORTS.desktop,
    });
    return { url: "http://127.0.0.1:" + PORTS.desktop, backendDir, python: venvPython, env, ports: PORTS };
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (uiServer) {
      await new Promise((resolve) => uiServer.close(resolve));
      uiServer = null;
    }
    for (const child of [...children.values()].reverse()) {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    }
    await delay(1200);
    for (const child of children.values()) {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
    children.clear();

    if (postgresStarted && paths && env) {
      const pgCtl = path.join(paths["postgresql@15"], "bin", "pg_ctl");
      try {
        await execFileAsync(pgCtl, ["-D", path.join(dataDir, "postgres"), "-m", "fast", "-w", "stop"], {
          env, maxBuffer: 1024 * 1024, timeout: 15000,
        });
      } catch (error) {
        log("shutdown", String(error.stderr || error.message) + "\n");
      }
      postgresStarted = false;
    }
  }

  return { start: initialize, stop };
}

module.exports = { createRuntime, PORTS };
