const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const { createRuntime } = require("../app/runtime.cjs");

async function main() {
  const resourcesDir = process.env.CVAT_TEST_RESOURCES;
  const userDataDir = process.env.CVAT_TEST_USERDATA;
  if (!resourcesDir || !userDataDir) throw new Error("CVAT_TEST_RESOURCES and CVAT_TEST_USERDATA are required");

  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const runtime = createRuntime({
    resourcesDir,
    userDataDir,
    onStatus: ({ message }) => console.log("[desktop]", message),
  });

  try {
    const info = await runtime.start();
    console.log("Native runtime started:", info.url);

    // The interpreter and every service must come from the app bundle, never from the system.
    if (!info.python.startsWith(resourcesDir)) throw new Error("Python is not the bundled one: " + info.python);
    const imports = await execFileAsync(info.python, ["-c", [
      "import av, cv2, django, ldap, psycopg2, shapely, xmlsec, sys",
      "print('bundled Python', sys.version.split()[0], 'from', sys.executable)",
      "print('native modules: OK')",
    ].join("; ")], { cwd: info.backendDir, env: info.env, maxBuffer: 1024 * 1024 });
    process.stdout.write(imports.stdout);

    const pageResponse = await fetch(info.url + "/");
    if (!pageResponse.ok) throw new Error("Frontend returned HTTP " + pageResponse.status);
    const page = await pageResponse.text();
    if (!page.toLowerCase().includes("<html")) throw new Error("Frontend did not return an HTML document");

    const apiResponse = await fetch(info.url + "/api/server/about");
    if (!apiResponse.ok) throw new Error("Proxied API returned HTTP " + apiResponse.status);
    const about = await apiResponse.json();
    console.log("CVAT server API is responding:", about.version || "version field unavailable");

    const username = "desktop-smoke";
    const password = "Desktop-Smoke-Only-" + require("node:crypto").randomBytes(12).toString("hex");
    const createCode = [
      "import os",
      "from django.contrib.auth import get_user_model",
      "User = get_user_model()",
      "User.objects.create_superuser(username=os.environ['CVAT_DESKTOP_ADMIN_USER'], email='desktop-smoke@localhost', password=os.environ['CVAT_DESKTOP_ADMIN_PASSWORD'])",
    ].join("; ");
    await execFileAsync(info.python, ["manage.py", "shell", "-c", createCode], {
      cwd: info.backendDir,
      env: {
        ...info.env,
        CVAT_DESKTOP_ADMIN_USER: username,
        CVAT_DESKTOP_ADMIN_PASSWORD: password,
      },
      maxBuffer: 1024 * 1024,
    });

    const checkCode = [
      "from django.contrib.auth import get_user_model",
      "User = get_user_model()",
      "assert User.objects.filter(username='desktop-smoke', is_superuser=True).exists()",
      "print('Local superuser creation: OK')",
    ].join("; ");
    const result = await execFileAsync(info.python, ["manage.py", "shell", "-c", checkCode], {
      cwd: info.backendDir,
      env: info.env,
      maxBuffer: 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    console.log("Desktop runtime integration test passed.");

    if (process.env.CVAT_TEST_SAM2_WORKDIR) {
      const { runSam2E2E } = require("./sam2-e2e.cjs");
      await runSam2E2E({
        info,
        scriptPath: path.join(resourcesDir, "sam2", "track_sam2.py"),
        sourceDir: path.join(resourcesDir, "vendor", "sam2"),
        workDir: process.env.CVAT_TEST_SAM2_WORKDIR,
      });
    }
  } catch (error) {
    // Show what the services logged, so a CI failure can be diagnosed from the job log alone.
    for (const name of ["backend.log", "worker.log"]) {
      const file = path.join(userDataDir, "logs", name);
      if (fs.existsSync(file)) {
        const tail = fs.readFileSync(file, "utf8").split("\n").slice(-60).join("\n");
        console.error("----- last lines of " + name + " -----\n" + tail);
      }
    }
    throw error;
  } finally {
    await runtime.stop();
    console.log("Native CVAT services stopped cleanly.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
