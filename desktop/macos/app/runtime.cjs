const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const PORTS = { postgres: 25432, redis: 26379, kvrocks: 26666, opa: 28181, backend: 27000, desktop: 28080 };
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const INHERITED_ENV = ["HOME", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];

// Auto-annotation (serverless) needs a Nuclio dashboard, which in turn needs Docker or Kubernetes.
// It is optional and configured through nuclio.json in the app's user-data directory.
const NUCLIO_TEMPLATE = {
  enabled: false,
  scheme: "http",
  host: "localhost",
  port: 8070,
  invokeMethod: "direct",
  namespace: "nuclio",
  timeoutSeconds: 120,
};

function nuclioConfigPath(userDataDir) { return path.join(userDataDir, "nuclio.json"); }

function loadNuclioEnv(userDataDir) {
  const file = nuclioConfigPath(userDataDir);
  if (!fs.existsSync(file)) return {};
  let config;
  try {
    config = { ...NUCLIO_TEMPLATE, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    throw new Error("Could not read " + file + ": " + error.message);
  }
  if (!config.enabled) return {};
  if (!["http", "https"].includes(config.scheme)) throw new Error(file + ': "scheme" must be "http" or "https".');
  if (!/^[A-Za-z0-9._-]+$/.test(String(config.host))) throw new Error(file + ': "host" is not a valid host name.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error(file + ': "port" must be 1-65535.');
  if (!["direct", "dashboard"].includes(config.invokeMethod)) throw new Error(file + ': "invokeMethod" must be "direct" or "dashboard".');
  if (!/^[A-Za-z0-9._-]+$/.test(String(config.namespace))) throw new Error(file + ': "namespace" is not valid.');
  if (!Number.isInteger(config.timeoutSeconds) || config.timeoutSeconds < 1) throw new Error(file + ': "timeoutSeconds" must be a positive integer.');
  return {
    CVAT_SERVERLESS: "1",
    CVAT_NUCLIO_SCHEME: config.scheme,
    CVAT_NUCLIO_HOST: String(config.host),
    CVAT_NUCLIO_PORT: String(config.port),
    CVAT_NUCLIO_INVOKE_METHOD: config.invokeMethod,
    CVAT_NUCLIO_FUNCTION_NAMESPACE: String(config.namespace),
    CVAT_NUCLIO_DEFAULT_TIMEOUT: String(config.timeoutSeconds),
  };
}

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
  let pgBin = null;
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

  function requireFile(file, what) {
    if (!fs.existsSync(file)) throw new Error("The packaged " + what + " is missing (" + file + "). This build is incomplete.");
    return file;
  }

  function postmasterPid(pgData) {
    try {
      const pid = parseInt(fs.readFileSync(path.join(pgData, "postmaster.pid"), "utf8").split("\n")[0], 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  async function postgresIsRunning(pgData) {
    try {
      await execFileAsync(path.join(pgBin, "pg_ctl"), ["-D", pgData, "status"], { env, maxBuffer: 1024 * 1024, timeout: 15000 });
      return true;
    } catch {
      return false; // pg_ctl exits with 3 when no server is running
    }
  }

  async function stopPostgres(pgData) {
    const pgCtl = path.join(pgBin, "pg_ctl");
    try {
      await execFileAsync(pgCtl, ["-D", pgData, "-m", "fast", "-w", "-t", "30", "stop"], { env, maxBuffer: 1024 * 1024, timeout: 45000 });
      return;
    } catch (error) {
      log("shutdown", "pg_ctl stop failed: " + String(error.stderr || error.message) + "\n");
    }
    // Fall back to signalling the postmaster directly: SIGINT = fast shutdown, SIGQUIT = immediate.
    const pid = postmasterPid(pgData);
    if (!pid) return;
    for (const [signal, waitMs] of [["SIGINT", 20000], ["SIGQUIT", 10000]]) {
      try { process.kill(pid, signal); } catch { return; }
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (!fs.existsSync(path.join(pgData, "postmaster.pid"))) return;
        await delay(250);
      }
      log("shutdown", "PostgreSQL did not stop after " + signal + "\n");
    }
  }

  // A previous run may have left PostgreSQL running (crash, force quit, or a failed shutdown).
  // It is our own server on our own data directory, so reuse it instead of failing on
  // "lock file postmaster.pid already exists".
  async function ensurePostgres(pgData) {
    if (await postgresIsRunning(pgData)) {
      let reachable = false;
      try { await waitForPort(PORTS.postgres, 5000); reachable = true; } catch { /* stale pid file */ }
      if (reachable) {
        log("bootstrap", "Reusing PostgreSQL that is already running for this data directory.\n");
        return;
      }
      await stopPostgres(pgData);
    }
    await command(path.join(pgBin, "pg_ctl"), ["-D", pgData, "-l", path.join(logDir, "postgres.log"), "-o", "-h 127.0.0.1 -p " + PORTS.postgres, "-w", "-t", "60", "start"], { cwd: userDataDir });
  }

  async function initialize() {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    if (!fs.existsSync(path.join(backendDir, "manage.py")) || !fs.existsSync(path.join(frontendDir, "index.html"))) {
      throw new Error("The packaged CVAT backend or frontend is missing. This build is incomplete.");
    }

    // Everything the app needs ships inside the bundle: no Homebrew, no Xcode tools, no network.
    status("Preparing native services…");
    const vendorDir = path.join(resourcesDir, "vendor");
    const python = requireFile(path.join(vendorDir, "python", "bin", "python3"), "Python runtime");
    pgBin = path.join(vendorDir, "postgres", "bin");
    for (const tool of ["initdb", "pg_ctl", "createdb"]) requireFile(path.join(pgBin, tool), "PostgreSQL (" + tool + ")");
    const redisBinary = requireFile(path.join(vendorDir, "redis-server"), "Redis server");
    const kvrocksBinary = requireFile(path.join(vendorDir, "kvrocks"), "Kvrocks binary");
    const opaBinary = requireFile(path.join(vendorDir, "opa"), "OPA binary");

    const baseEnv = {};
    for (const key of INHERITED_ENV) if (process.env[key] !== undefined) baseEnv[key] = process.env[key];
    env = {
      ...baseEnv,
      LANG: baseEnv.LANG || "en_US.UTF-8",
      PATH: [path.dirname(python), pgBin, vendorDir, ...SYSTEM_PATH].join(path.delimiter),
      PYTHONPATH: runtimeDir + path.delimiter + backendDir,
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
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
      ...loadNuclioEnv(userDataDir),
    };

    fs.mkdirSync(env.CVAT_BASE_DIR, { recursive: true });
    fs.mkdirSync(path.join(dataDir, "postgres"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "redis"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "kvrocks"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "kvrocks-logs"), { recursive: true });

    const venvPython = python;

    status("Starting PostgreSQL…");
    const pgData = path.join(dataDir, "postgres");
    const initdb = path.join(pgBin, "initdb");
    if (!fs.existsSync(path.join(pgData, "PG_VERSION"))) {
      await command(initdb, ["-D", pgData, "-U", "cvat", "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8"], { cwd: userDataDir });
    }
    await ensurePostgres(pgData);
    postgresStarted = true;
    try {
      await command(path.join(pgBin, "createdb"), ["-h", "127.0.0.1", "-p", String(PORTS.postgres), "-U", "cvat", "cvat"], { cwd: userDataDir });
    } catch (error) {
      if (!String(error.stderr || error.message).toLowerCase().includes("already exists")) throw error;
    }

    status("Starting Redis and the on-disk cache…");
    startProcess("redis", redisBinary, [
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

    if (postgresStarted && pgBin && env) {
      await stopPostgres(path.join(dataDir, "postgres"));
      postgresStarted = false;
    }
  }

  return { start: initialize, stop };
}

module.exports = { createRuntime, PORTS, NUCLIO_TEMPLATE, nuclioConfigPath };
