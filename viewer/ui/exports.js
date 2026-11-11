// Export to other programs: glTF (.glb) for any web viewer or Blender, IFC4 for BIM tools. From the
// right-click menu (the item clicked, or the selection it belongs to) and from "Minha estrutura"
// (the selection, or everything visible when nothing is selected). The geometry is the same
// tessellation the viewer draws, in metres.
import { $, status, saveBytes } from "./util.js";
import { writeGLB } from "../lib/gltf.js";
import { writeIFC } from "../lib/ifc.js";

export function initExports(app) {
  const base = () => (app.title || "modelo").replace(/\.pvs$/i, "");
  const partsOf = (nodes) => { const out = [], seen = new Uint8Array(app.nParts); app.forParts(nodes, (p) => { if (!seen[p]) { seen[p] = 1; out.push(p); } }); return out; };
  function chosen() {
    if (app.selNodes.size) return partsOf([...app.selNodes]);
    const out = [];
    for (let p = 0; p < app.nParts; p++) if (app.partVisible[p]) out.push(p);
    return out;
  }
  let busy = false;
  async function run(kind, parts, label) {
    if (busy) return;
    if (!app.canReadGeometry()) { status("Exportar precisa da geometria das peças (abra a pasta do modelo ou uma pasta convertida)."); return; }
    if (!parts.length) { status("Nada para exportar."); return; }
    busy = true;
    const what = kind === "glb" ? "glTF" : "IFC";
    try {
      const progress = (i, n) => { if (i % 25 === 0 || i === n) status(`Exportando ${what}: ${i.toLocaleString("pt-BR")}/${n.toLocaleString("pt-BR")} peças`); };
      const r = kind === "glb" ? await writeGLB(app, parts, progress) : await writeIFC(app, parts, progress);
      if (!r) { status("Nenhuma das peças tem geometria disponível."); return; }
      const name = `${base()}-${label}.${kind === "glb" ? "glb" : "ifc"}`;
      const where = kind === "glb"
        ? await saveBytes(name, r.bytes, { description: "glTF binário", mime: "model/gltf-binary", ext: "glb" })
        : await saveBytes(name, new TextEncoder().encode(r.text), { description: "IFC", mime: "application/x-step", ext: "ifc" });
      if (where) status(`${what} salvo com ${r.parts.toLocaleString("pt-BR")} peças: ${where}`);
    } catch (e) {
      status(`Erro ao exportar ${what}: ${e.message}`);
      console.error(e);
    } finally { busy = false; }
  }
  const labelOf = (nodes) => (nodes.length === 1 ? String(app.tree.names[nodes[0]]) : "selecao").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
  app.addContextItems((nodes, node) => {
    const target = nodes.includes(node) ? nodes : [node];
    return [
      { label: "Exportar em glTF (.glb)…", title: "Para qualquer visualizador 3D na web ou o Blender (cores, árvore e propriedades)", onClick: () => run("glb", partsOf(target), labelOf(target)) },
      { label: "Exportar em IFC…", title: "Para ferramentas BIM (geometria, cores e propriedades)", onClick: () => run("ifc", partsOf(target), labelOf(target)) },
    ];
  });
  $("#gltfExport").onclick = () => run("glb", chosen(), app.selNodes.size ? "selecao" : "visivel");
  $("#ifcExport").onclick = () => run("ifc", chosen(), app.selNodes.size ? "selecao" : "visivel");
  app.exportAs = (kind, parts, label) => run(kind, parts, label || "export");
}
