// Desktop version (Electron) of the PVS viewer. It runs the same viewer as the web version,
// but: asks Windows for the high-performance GPU, allows more memory, opens model folders
// directly (no browser permission prompts) and works offline.
//   app://viewer/...  -> the viewer files packed with the app
//   model://local/... -> the model folder chosen by the user (or passed on the command line)
const { app, BrowserWindow, protocol, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const fss = require("node:fs");
const { exportMobile } = require("./mobile-export");
const { insideFolder, isViewerURL, isExternalLink, viewerCSP } = require("./security");

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
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};
let modelDir = null, win = null;
let conversion = null;
let objExport = null;

async function serve(root, urlPath) {
  let file;
  try { file = path.normalize(path.join(root, decodeURIComponent(urlPath))); } catch { return new Response("endereço inválido", { status: 400 }); }
  if (!insideFolder(root, file)) return new Response("proibido", { status: 403 }); // also a sibling folder with the same prefix
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) throw new Error("not a file");
    const body = await fs.readFile(file), ext = path.extname(file).toLowerCase();
    const headers = { "content-type": MIME[ext] || "application/octet-stream" };
    // the viewer's pages: only the app's own scripts run (see viewerCSP in security.js)
    if (root === VIEWER && ext === ".html") headers["content-security-policy"] = viewerCSP(body.toString("utf8"));
    return new Response(body, { headers });
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

// The bridge (preload.js) answers only the viewer's own pages: a page of anything else, if one were
// ever loaded in the window, gets an error instead of access to files and dialogs.
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isViewerURL(event.senderFrame && event.senderFrame.url)) throw new Error("pedido recusado: origem desconhecida");
    return fn(event, ...args);
  });
}

app.whenReady().then(() => {
  protocol.handle("app", (req) => serve(VIEWER, new URL(req.url).pathname));
  protocol.handle("model", (req) => (modelDir ? serve(modelDir, new URL(req.url).pathname) : new Response("", { status: 404 })));

  handle("pick-folder", async () => {
    const r = await dialog.showOpenDialog(win, { title: "Pasta do modelo (.pvs + .ol, ou pasta convertida)", properties: ["openDirectory"] });
    return r.canceled || !r.filePaths.length ? null : describe(r.filePaths[0]);
  });
  // a folder opened before (the viewer's "Abertos recentemente" list); null when it is gone
  handle("open-folder", async (_event, dir) => {
    try { return (await fs.stat(String(dir))).isDirectory() ? describe(String(dir)) : null; } catch { return null; }
  });
  // a folder given on the command line (or dropped on the .exe) opens directly
  handle("initial-folder", async () => {
    const arg = process.argv.slice(1).find((a) => !a.startsWith("-") && a !== "." && fss.existsSync(a) && fss.statSync(a).isDirectory());
    return arg ? describe(arg) : null;
  });

  handle("conversion-begin", async () => {
    if (conversion) throw new Error("Já existe uma conversão em andamento.");
    const input = await dialog.showOpenDialog(win, { title: "Pasta do modelo original (.pvs + .ol)", properties: ["openDirectory"] });
    if (input.canceled) return null;
    const names = await fs.readdir(input.filePaths[0]);
    const pvs = names.find((n) => n.toLowerCase().endsWith(".pvs"));
    if (!pvs) throw new Error("A pasta escolhida não contém um arquivo .pvs.");
    const parent = await dialog.showOpenDialog(win, { title: "Onde salvar a pasta convertida?", properties: ["openDirectory"] });
    if (parent.canceled) return null;
    const target = path.join(parent.filePaths[0], path.parse(pvs).name + "-convertido");
    if (fss.existsSync(target)) throw new Error("A pasta convertida já existe. Escolha outro destino ou renomeie a pasta existente.");
    const temporary = target + ".parcial";
    if (fss.existsSync(temporary)) throw new Error("Já existe uma conversão parcial nesse destino.");
    await fs.mkdir(path.join(temporary, "c"), { recursive: true });
    conversion = { temporary, target };
    modelDir = input.filePaths[0];
    return { pvs, base: "model://local/", folder: target, input: input.filePaths[0] };
  });
  // Reorganized structure saved as a converted folder: the same writing steps as a conversion.
  handle("export-folder-begin", async (_event, folderName) => {
    if (conversion) throw new Error("Já existe uma conversão ou exportação em andamento.");
    const parent = await dialog.showOpenDialog(win, { title: "Onde salvar a pasta com a nova estrutura?", properties: ["openDirectory", "createDirectory"] });
    if (parent.canceled) return null;
    const target = path.join(parent.filePaths[0], String(folderName).replace(/[\\/:*?"<>|]/g, "_"));
    if (fss.existsSync(target)) throw new Error("A pasta " + target + " já existe. Escolha outro local ou renomeie a pasta existente.");
    const temporary = target + ".parcial";
    if (fss.existsSync(temporary)) throw new Error("Já existe uma exportação parcial nesse destino (" + temporary + ").");
    await fs.mkdir(path.join(temporary, "c"), { recursive: true });
    conversion = { temporary, target };
    return target;
  });
  // One file chosen by the user in a save dialog (reorganized .pvs, animation video).
  handle("save-file", async (_event, suggestedName, data, filterName, extensions) => {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(modelDir || app.getPath("documents"), String(suggestedName).replace(/[\\/]/g, "_")),
      filters: [{ name: String(filterName), extensions: extensions.map(String) }],
    });
    if (result.canceled) return null;
    await fs.writeFile(result.filePath, Buffer.from(data));
    return result.filePath;
  });
  handle("conversion-write", async (_event, name, data) => {
    if (!conversion || !/^(?:c\/\d{5}\.bin|tree\.json|items\.bin|parts\.bin|layers\.bin|pvsbox\.bin|chunks\.json)$/.test(name))
      throw new Error("Arquivo de conversão inválido.");
    await fs.writeFile(path.join(conversion.temporary, name), Buffer.from(data));
  });
  handle("conversion-finish", async () => {
    if (!conversion) throw new Error("Nenhuma conversão em andamento.");
    await fs.rename(conversion.temporary, conversion.target);
    conversion = null;
  });
  handle("conversion-cancel", async () => {
    if (conversion) { await fs.rm(conversion.temporary, { recursive: true, force: true }); conversion = null; }
  });
  handle("mobile-export", async (_event, parts) => {
    const source = modelDir;
    if (!source || !fss.existsSync(path.join(source, "chunks.json")))
      throw new Error("Abra uma pasta convertida antes de exportar para o celular.");
    const parentChoice = await dialog.showOpenDialog(win, {
      title: "Onde salvar o modelo para celular?", properties: ["openDirectory"],
    });
    if (parentChoice.canceled) return null;
    const parent = path.resolve(parentChoice.filePaths[0]);
    const target = path.join(parent, path.basename(source) + "-modelo");
    if (fss.existsSync(target)) throw new Error("A pasta de destino já existe. Escolha outro local ou renomeie a pasta existente.");
    const temporary = await fs.mkdtemp(path.join(parent, ".pvs-mobile-"));
    try {
      await exportMobile(source, temporary, parts);
      await fs.rename(temporary, target);
      return target;
    } catch (error) {
      // Only remove the temporary directory we just created inside the chosen parent.
      if (path.dirname(path.resolve(temporary)) === parent) await fs.rm(temporary, { recursive: true, force: true });
      throw error;
    }
  });
  handle("obj-begin", async (_event, suggestedName) => {
    if (objExport) throw new Error("Já existe uma exportação em andamento.");
    const result = await dialog.showSaveDialog(win, {
      title: "Exportar peças em OBJ", defaultPath: String(suggestedName).replace(/[\\/]/g, "_"),
      filters: [{ name: "Wavefront OBJ", extensions: ["obj"] }],
    });
    if (result.canceled) return false;
    const temporary = result.filePath + ".partial-" + require("node:crypto").randomUUID();
    objExport = { target: result.filePath, temporary, handle: await fs.open(temporary, "wx") };
    return true;
  });
  handle("obj-write", async (_event, text) => {
    if (!objExport) throw new Error("Nenhuma exportação em andamento.");
    await objExport.handle.write(text);
  });
  handle("obj-finish", async () => {
    if (!objExport) throw new Error("Nenhuma exportação em andamento.");
    const { handle, temporary, target } = objExport;
    await handle.close();
    await fs.rename(temporary, target);
    objExport = null;
  });
  handle("obj-cancel", async () => {
    if (!objExport) return;
    const { handle, temporary } = objExport;
    objExport = null;
    await handle.close();
    await fs.rm(temporary, { force: true });
  });

  win = new BrowserWindow({
    width: 1500, height: 950, title: "Visualizador PVS", autoHideMenuBar: true, backgroundColor: "#eef1f5",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  // links: https opens in the user's browser; nothing else leaves the app (files, other programs)
  win.webContents.setWindowOpenHandler(({ url }) => { if (isExternalLink(url)) shell.openExternal(url); return { action: "deny" }; });
  // the window stays on the viewer: a dropped file or a link cannot take it (and the bridge) elsewhere
  const stay = (event, url) => { if (!isViewerURL(url)) event.preventDefault(); };
  win.webContents.on("will-navigate", stay);
  win.webContents.on("will-redirect", stay);
  win.loadURL("app://viewer/index.html");
});

app.on("window-all-closed", () => app.quit());
