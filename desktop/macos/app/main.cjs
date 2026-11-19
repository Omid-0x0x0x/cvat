const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const {
  app, BrowserWindow, dialog, clipboard, Menu, shell, safeStorage,
} = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const { createRuntime, NUCLIO_TEMPLATE, nuclioConfigPath } = require("./runtime.cjs");
const { createSam2Service } = require("./sam2.cjs");

let mainWindow = null;
let runtime = null;
let runtimeInfo = null;
let quitInProgress = false;
let storedCredentialsPath = null;
let sam2Service = null;

function resourcePath() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "../../..");
}

function sendStatus(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("cvat:status", { message });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 680,
    title: "CVAT Desktop",
    backgroundColor: "#17191e",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (!quitInProgress) app.quit();
  });
  mainWindow.loadFile(path.join(__dirname, "splash.html"));
}

function readStoredCredentials() {
  if (!storedCredentialsPath || !fs.existsSync(storedCredentialsPath)) return null;
  const raw = fs.readFileSync(storedCredentialsPath, "utf8");
  if (raw.startsWith("encrypted:")) {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(Buffer.from(raw.slice(10), "base64")));
  }
  return JSON.parse(raw);
}

async function showSavedPassword() {
  const credentials = readStoredCredentials();
  if (!credentials) {
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      message: "No readable recovery password is stored.",
      detail: "You can reset the local administrator password using the CVAT Desktop support instructions.",
    });
    return;
  }
  clipboard.writeText(credentials.password);
  await dialog.showMessageBox(mainWindow, {
    type: "info",
    message: "The local administrator password was copied to the clipboard.",
    detail: "Username: " + credentials.username + "\nThe password exists only on this Mac.",
  });
}

async function openNuclioSettings() {
  const file = nuclioConfigPath(app.getPath("userData"));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(NUCLIO_TEMPLATE, null, 2) + "\n", { mode: 0o600 });
  }
  await dialog.showMessageBox(mainWindow, {
    type: "info",
    message: "Auto-annotation uses a Nuclio server that you run yourself.",
    detail: "The settings file will open now. Set \"enabled\" to true, adjust host and port if your Nuclio " +
      "dashboard is not on localhost:8070, save the file and restart CVAT Desktop.\n\n" +
      "Nuclio needs Docker or Kubernetes; it is not bundled in this app. " +
      "See desktop/macos/NUCLIO.md in the CVAT Desktop source for setup steps.\n\n" + file,
  });
  const error = await shell.openPath(file);
  if (error) shell.showItemInFolder(file);
}

function buildMenu() {
  const template = [
    {
      label: "CVAT Desktop",
      submenu: [
        {
          label: "Open CVAT",
          click: () => {
            if (mainWindow && runtimeInfo) mainWindow.loadURL(runtimeInfo.url);
          },
        },
        {
          label: "Show local administrator password",
          click: showSavedPassword,
        },
        {
          label: "SAM 2 tracking…",
          accelerator: "CmdOrCtrl+Shift+T",
          click: () => { if (sam2Service) sam2Service.openWindow(); },
        },
        {
          label: "Auto-annotation (Nuclio) settings…",
          click: openNuclioSettings,
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "CVAT Desktop source",
          click: () => shell.openExternal("https://github.com/Omid-0x0x0x/cvat/tree/feat/macos-native-app/desktop/macos"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function ensureLocalAdmin() {
  const venvPython = runtimeInfo.python;
  const backendDir = runtimeInfo.backendDir;
  storedCredentialsPath = path.join(app.getPath("userData"), "local-admin.json");

  const inspectCode = [
    "from django.contrib.auth import get_user_model",
    "User = get_user_model()",
    "print('1' if User.objects.filter(is_superuser=True).exists() else '0')",
  ].join("; ");
  const inspect = await execFileAsync(venvPython, ["manage.py", "shell", "-c", inspectCode], {
    cwd: backendDir,
    env: runtimeInfo.env,
    maxBuffer: 1024 * 1024,
  });

  if (inspect.stdout.trim().endsWith("1")) return;

  const username = "admin";
  const password = crypto.randomBytes(24).toString("base64url");
  const createCode = [
    "import os",
    "from django.contrib.auth import get_user_model",
    "User = get_user_model()",
    "User.objects.create_superuser(username=os.environ['CVAT_DESKTOP_ADMIN_USER'], email='admin@localhost', password=os.environ['CVAT_DESKTOP_ADMIN_PASSWORD'])",
  ].join("; ");
  const childEnv = {
    ...runtimeInfo.env,
    CVAT_DESKTOP_ADMIN_USER: username,
    CVAT_DESKTOP_ADMIN_PASSWORD: password,
  };
  await execFileAsync(venvPython, ["manage.py", "shell", "-c", createCode], {
    cwd: backendDir,
    env: childEnv,
    maxBuffer: 1024 * 1024,
  });

  const payload = JSON.stringify({ username, password });
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(payload).toString("base64");
    fs.writeFileSync(storedCredentialsPath, "encrypted:" + encrypted, { mode: 0o600 });
  } else {
    fs.writeFileSync(storedCredentialsPath, payload, { mode: 0o600 });
  }
  clipboard.writeText(password);
  await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Local CVAT administrator created",
    message: "Your local CVAT administrator account is ready.",
    detail: "Username: admin\nThe generated password has been copied to your clipboard. You can retrieve it later from the CVAT Desktop menu.",
  });
}

async function start() {
  createWindow();
  buildMenu();
  runtime = createRuntime({
    resourcesDir: resourcePath(),
    userDataDir: app.getPath("userData"),
    onStatus: ({ message }) => sendStatus(message),
  });

  try {
    runtimeInfo = await runtime.start();
    sam2Service = createSam2Service({
      getMainWindow: () => mainWindow,
      getRuntimeInfo: () => runtimeInfo,
      resourcesDir: resourcePath(),
      userDataDir: app.getPath("userData"),
    });
    await ensureLocalAdmin();
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(runtimeInfo.url);
    }
  } catch (error) {
    console.error(error);
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "CVAT Desktop could not start",
      message: "The native CVAT runtime did not start.",
      detail: String(error && (error.stack || error.message) || error) +
        "\n\nLogs are available in: " + path.join(app.getPath("userData"), "logs"),
    });
    app.quit();
  }
}

app.whenReady().then(start);

app.on("before-quit", (event) => {
  if (!runtime || quitInProgress) return;
  event.preventDefault();
  quitInProgress = true;
  if (sam2Service) sam2Service.dispose();
  runtime.stop().finally(() => app.exit(0));
});

app.on("window-all-closed", () => app.quit());
