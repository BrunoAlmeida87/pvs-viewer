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

// entry: { kind: "dir" | "zip" | "path", name, handle?, path? }
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
