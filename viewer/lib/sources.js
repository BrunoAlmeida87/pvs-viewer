// Where a model is read from. A model is either a folder converted by tools/build.py (chunks.json,
// tree.json, ...) or an original Creo View folder (.pvs + .ol files) that is parsed in the browser;
// local folders are read by the browser and are never uploaded. Each reader returns
// {kind: "converted", src: {json(name), buf(name)}} or {kind: "raw", name, pvs, access}.
// Moved out of viewer.js unchanged; tested in desktop/test/sources.test.js.

export function ok(r, name) { if (!r.ok) throw new Error(name + ": HTTP " + r.status); return r; }

export const httpSrc = (base) => ({
  json: (n) => fetch(base + n).then((r) => ok(r, n).json()),
  buf: (n) => fetch(base + n).then((r) => ok(r, n).arrayBuffer()),
});

export function filesConverted(all, prefix) {
  const get = (n) => { const f = all.get(prefix + n); if (!f) throw new Error("arquivo ausente: " + n); return f; };
  return { json: async (n) => JSON.parse(await get(n).text()), buf: async (n) => get(n).arrayBuffer() };
}

export function dirConverted(dir) {
  const file = async (n) => {
    const parts = n.split("/");
    let d = dir;
    for (const s of parts.slice(0, -1)) d = await d.getDirectoryHandle(s);
    return (await d.getFileHandle(parts[parts.length - 1])).getFile();
  };
  return { json: async (n) => JSON.parse(await (await file(n)).text()), buf: async (n) => (await file(n)).arrayBuffer() };
}

export const NO_MODEL = "A pasta não tem arquivo .pvs nem um modelo convertido (chunks.json). Escolha a pasta que contém o .pvs e os arquivos .ol.";

export async function fromDesktop(r) {
  if (r.converted) return { kind: "converted", src: httpSrc(r.base) };
  if (!r.pvs) throw new Error(NO_MODEL);
  const buf = await fetch(r.base + encodeURIComponent(r.pvs)).then((x) => ok(x, r.pvs).arrayBuffer());
  return { kind: "raw", name: r.pvs, pvs: buf, access: { base: r.base, list: r.files } };
}

export async function fromDirectory(dir) {
  try { await dir.getFileHandle("chunks.json"); return { kind: "converted", src: dirConverted(dir) }; } catch { /* not converted */ }
  let found = null;
  for await (const [name, h] of dir.entries()) {
    if (h.kind === "file" && name.toLowerCase().endsWith(".pvs")) { found = h; break; }
  }
  if (!found) throw new Error(NO_MODEL);
  const f = await found.getFile();
  return { kind: "raw", name: f.name, pvs: await f.arrayBuffer(), access: { dir } };
}

export async function fromFileList(files) {
  const all = new Map();
  for (const f of files) all.set((f.webkitRelativePath || f.name).replace(/\\/g, "/"), f);
  const keys = [...all.keys()];
  const meta = keys.filter((k) => k.endsWith("chunks.json")).sort((a, b) => a.length - b.length)[0];
  if (meta) return { kind: "converted", src: filesConverted(all, meta.slice(0, -"chunks.json".length)) };
  const pvs = keys.filter((k) => k.toLowerCase().endsWith(".pvs")).sort((a, b) => a.length - b.length)[0];
  if (!pvs) throw new Error(NO_MODEL);
  const prefix = pvs.slice(0, pvs.lastIndexOf("/") + 1);
  const byName = new Map();
  for (const [k, f] of all) if (k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) byName.set(k.slice(prefix.length), f);
  const f = all.get(pvs);
  return { kind: "raw", name: f.name, pvs: await f.arrayBuffer(), access: { files: byName } };
}
