// Recently opened models, to reopen them in one click. The browser version keeps the folder / ZIP
// handle that the user picked (IndexedDB can store handles; nothing is copied, and the browser
// asks again for permission when needed). The desktop app keeps the folder path.
const DB = "pvs-viewer", STORE = "recent", MAX = 8;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
    const out = fn(s);
    t.oncomplete = () => { db.close(); resolve(out && "result" in out ? out.result : undefined); };
    t.onerror = t.onabort = () => { db.close(); reject(t.error); };
  }));
}

// entry: { kind: "dir" | "zip" | "path" | "kept", name, handle?, path?, size? }
// ("kept": a copy of a ZIP stored on this device, see keepZip below; path = its stored name)
export async function addRecent(entry) {
  try {
    const id = entry.kind + ":" + (entry.path || entry.name);
    await tx("readwrite", (s) => s.put({ ...entry, id, when: Date.now() }));
    const all = await listRecent();
    for (const old of all.slice(MAX)) await removeRecent(old.id);
  } catch { /* private window or storage blocked: no list */ }
}

export async function listRecent() {
  try {
    const all = await tx("readonly", (s) => s.getAll());
    return (all || []).sort((a, b) => b.when - a.when);
  } catch { return []; }
}

export async function removeRecent(id) {
  try { await tx("readwrite", (s) => s.delete(id)); } catch { /* nothing to remove */ }
}

// Ask (again) for permission to read a stored handle; must run inside a click.
export async function allow(handle) {
  if (!handle.queryPermission) return true;
  if (await handle.queryPermission({ mode: "read" }) === "granted") return true;
  return await handle.requestPermission({ mode: "read" }) === "granted";
}

// ------------------------------------------------------------ models kept on this device
// A ZIP picked with a plain file selector (phones) can only be read while the page is open: when
// the browser closes the tab, the model is gone. So a copy is kept in the site's private storage
// on the device (Origin Private File System): it survives closing the browser and reopens with no
// file selector. Only the browser of this device sees it; it is erased with the site's data.
const DIR = "modelos", KEEP = 3;
const opfsOk = () => !!(navigator.storage && navigator.storage.getDirectory);
async function savedDir() { return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true }); }
const savedName = (file) => (file.name.replace(/[^\w.\- ]+/g, "_").replace(/\.zip$/i, "") || "modelo") + "-" + file.size + ".zip";

// Can this browser keep a copy? (Writing needs createWritable, missing in some browsers.)
export function canKeep() {
  return opfsOk() && typeof FileSystemFileHandle !== "undefined" && "createWritable" in FileSystemFileHandle.prototype;
}

// Copy `file` to the device and put it at the top of the recent list. onProgress(fraction).
// Returns the stored name, or throws.
export async function keepZip(file, onProgress = () => {}) {
  if (!canKeep()) throw new Error("Este navegador não permite guardar o modelo no aparelho.");
  const name = savedName(file);
  const dir = await savedDir();
  const listed = () => addRecent({ kind: "kept", name: file.name, path: name, size: file.size });
  try { // already kept (same name and size): nothing to copy
    const old = await (await dir.getFileHandle(name)).getFile();
    if (old.size === file.size) { await listed(); return name; }
  } catch { /* not kept yet */ }
  const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
  if (est && est.quota && est.quota - est.usage < file.size * 1.05)
    throw new Error(`sem espaço para guardar (${mb(file.size)} necessários, ${mb(est.quota - est.usage)} livres para o site).`);
  // ask the browser not to erase the site's storage when the device runs short of space
  if (navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const part = name + ".parcial";
  const h = await dir.getFileHandle(part, { create: true });
  const w = await h.createWritable();
  let done = 0;
  try {
    await file.stream().pipeThrough(new TransformStream({
      transform(chunk, ctl) { done += chunk.byteLength; onProgress(done / file.size); ctl.enqueue(chunk); },
    })).pipeTo(w);
  } catch (e) { await dir.removeEntry(part).catch(() => {}); throw e; }
  if (h.move) await h.move(name); // rename once complete, so a half copy is never opened
  else { await copyEntry(dir, part, name); await dir.removeEntry(part).catch(() => {}); }
  await listed();
  await trimKept();
  return name;
}
async function copyEntry(dir, from, to) {
  const f = await (await dir.getFileHandle(from)).getFile();
  const w = await (await dir.getFileHandle(to, { create: true })).createWritable();
  await f.stream().pipeTo(w);
}
const mb = (n) => (n / 1048576).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " MB";

export async function keptFile(name) {
  return (await (await savedDir()).getFileHandle(name)).getFile();
}
export async function dropKept(name) {
  try { await (await savedDir()).removeEntry(name); } catch { /* already gone */ }
}
// Keep only the most recent few copies (each can be hundreds of MB).
async function trimKept() {
  const kept = (await listRecent()).filter((r) => r.kind === "kept");
  for (const r of kept.slice(KEEP)) { await dropKept(r.path); await removeRecent(r.id); }
  // copies not in the list any more (e.g. the list was cleared)
  try {
    const known = new Set(kept.slice(0, KEEP).map((r) => r.path));
    const dir = await savedDir();
    for await (const [n] of dir.entries()) if (!known.has(n) && !n.endsWith(".parcial")) await dir.removeEntry(n).catch(() => {});
  } catch { /* storage unavailable */ }
}
export { mb as sizeText };
