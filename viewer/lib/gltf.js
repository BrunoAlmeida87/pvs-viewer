// Export parts as binary glTF 2.0 (.glb): one mesh per part, the assembly tree as nodes, one material
// per colour, the part properties as "extras" (Blender shows them as custom properties). glTF is
// y-up: the model's z-up metres become (x, z, -y). No normals: viewers then shade the triangles flat,
// as the CAD faces mostly are.
export async function writeGLB(app, parts, progress = () => {}) {
  const t = app.tree;
  const gltf = {
    asset: { version: "2.0", generator: "Visualizador PVS" },
    scene: 0, scenes: [{ name: app.title || "modelo", nodes: [] }],
    nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [],
  };
  const bins = [];
  let binLen = 0;
  const addView = (arr, target) => {
    const pad = (4 - (binLen % 4)) % 4;
    if (pad) { bins.push(new Uint8Array(pad)); binLen += pad; }
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    bins.push(bytes);
    gltf.bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: bytes.byteLength, target });
    binLen += bytes.byteLength;
    return gltf.bufferViews.length - 1;
  };
  const materials = new Map(); // rgb -> index
  const material = (rgb) => {
    if (rgb < 0) rgb = 0xb4b8bf;
    if (!materials.has(rgb)) {
      const c = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255].map((v) => Math.pow(v / 255, 2.2)); // sRGB → linear
      gltf.materials.push({ name: "#" + rgb.toString(16).padStart(6, "0"), pbrMetallicRoughness: { baseColorFactor: [...c, 1], metallicFactor: 0.1, roughnessFactor: 0.7 } });
      materials.set(rgb, gltf.materials.length - 1);
    }
    return materials.get(rgb);
  };
  // a glTF node for every tree node on the way from the root to an exported part
  const nodeOf = new Map();
  const props = (n) => { const o = {}; for (const [k, v] of app.nodeProps(n)) o[k] = v; return o; };
  function treeNode(n) {
    if (nodeOf.has(n)) return nodeOf.get(n);
    const g = { name: t.names[n] };
    const extras = props(n);
    if (Object.keys(extras).length) g.extras = extras;
    gltf.nodes.push(g);
    const i = gltf.nodes.length - 1;
    nodeOf.set(n, i);
    const up = t.parent[n];
    if (up >= 0) { const pi = treeNode(up); (gltf.nodes[pi].children ||= []).push(i); }
    else gltf.scenes[0].nodes.push(i);
    return i;
  }
  let done = 0;
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k], g = await app.partGeometry(p);
    progress(k + 1, parts.length);
    if (!g || !g.idx.length) continue;
    const P = g.pos, pos = new Float32Array(P.length);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) {
      const v = [P[i], P[i + 2], -P[i + 1]];
      pos[i] = v[0]; pos[i + 1] = v[1]; pos[i + 2] = v[2];
      for (let a = 0; a < 3; a++) { if (v[a] < min[a]) min[a] = v[a]; if (v[a] > max[a]) max[a] = v[a]; }
    }
    const nv = P.length / 3, idx = nv < 65536 ? Uint16Array.from(g.idx) : Uint32Array.from(g.idx);
    gltf.accessors.push({ bufferView: addView(pos, 34962), componentType: 5126, count: nv, type: "VEC3", min, max });
    const pa = gltf.accessors.length - 1;
    gltf.accessors.push({ bufferView: addView(idx, 34963), componentType: idx instanceof Uint16Array ? 5123 : 5125, count: idx.length, type: "SCALAR" });
    const ia = gltf.accessors.length - 1;
    gltf.meshes.push({ name: t.shapes ? String(t.shapes[p] || "") : "", primitives: [{ attributes: { POSITION: pa }, indices: ia, material: material(app.partRGB(p)) }] });
    const ni = treeNode(app.partNode[p]);
    gltf.nodes[ni].mesh = gltf.meshes.length - 1;
    done++;
  }
  if (!done) return null;
  gltf.buffers.push({ byteLength: binLen });
  // GLB: header, JSON chunk (padded with spaces), BIN chunk (padded with zeros)
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  const jp = (4 - (json.length % 4)) % 4;
  if (jp) { const j = new Uint8Array(json.length + jp).fill(0x20); j.set(json); json = j; }
  const bp = (4 - (binLen % 4)) % 4, binTotal = binLen + bp;
  const total = 12 + 8 + json.length + 8 + binTotal;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, json.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(json, 20);
  let o = 20 + json.length;
  dv.setUint32(o, binTotal, true); dv.setUint32(o + 4, 0x004e4942, true); o += 8;
  for (const b of bins) { out.set(b, o); o += b.length; }
  return { bytes: out, parts: done };
}
