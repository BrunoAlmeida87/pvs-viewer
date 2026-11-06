// Desktop version (Electron) of the PVS viewer. It runs the same viewer as the web version,
// but: asks Windows for the high-performance GPU, allows more memory, opens model folders
// directly (no browser permission prompts) and works offline.
//   app://viewer/...  -> the viewer files packed with the app
//   model://local/... -> the model folder chosen by the user (or passed on the command line)
const { app, BrowserWindow, protocol, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const fss = require("node:fs");

app.commandLine.appendSwitch("force_high_performance_gpu"); // NVIDIA/AMD instead of the integrated GPU
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=8192");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: "model", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const VIEWER = path.join(__dirname, "app", "viewer");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};
let modelDir = null, win = null;

async function serve(root, urlPath) {
  const file = path.normalize(path.join(root, decodeURIComponent(urlPath)));
  if (!file.startsWith(root)) return new Response("proibido", { status: 403 });
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) throw new Error("not a file");
    return new Response(await fs.readFile(file), { headers: { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" } });
  } catch {
    return new Response("não encontrado", { status: 404 });
  }
}

// What the viewer needs to know about a model folder.
async function describe(dir) {
  modelDir = path.resolve(dir);
  const names = await fs.readdir(modelDir);
  return {
    base: "model://local/",
    converted: names.includes("chunks.json"),
    pvs: names.find((n) => n.toLowerCase().endsWith(".pvs")) || null,
    files: names.filter((n) => /^ann\d+\.ast$/i.test(n)),
    folder: modelDir,
  };
}

app.whenReady().then(() => {
  protocol.handle("app", (req) => serve(VIEWER, new URL(req.url).pathname));
  protocol.handle("model", (req) => (modelDir ? serve(modelDir, new URL(req.url).pathname) : new Response("", { status: 404 })));

  ipcMain.handle("pick-folder", async () => {
    const r = await dialog.showOpenDialog(win, { title: "Pasta do modelo (.pvs + .ol, ou pasta convertida)", properties: ["openDirectory"] });
    return r.canceled || !r.filePaths.length ? null : describe(r.filePaths[0]);
  });
  // a folder given on the command line (or dropped on the .exe) opens directly
  ipcMain.handle("initial-folder", async () => {
    const arg = process.argv.slice(1).find((a) => !a.startsWith("-") && a !== "." && fss.existsSync(a) && fss.statSync(a).isDirectory());
    return arg ? describe(arg) : null;
  });

  win = new BrowserWindow({
    width: 1500, height: 950, title: "Visualizador PVS", autoHideMenuBar: true, backgroundColor: "#eef1f5",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.loadURL("app://viewer/index.html");
});

app.on("window-all-closed", () => app.quit());
