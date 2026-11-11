// Export parts as IFC4 (STEP text): each part an IfcBuildingElementProxy with its triangle mesh
// (IfcTriangulatedFaceSet, metres, z up as in the model), its colour, and a property set "PVS" with
// the part's properties, its bigrama and its place in the assembly tree. Everything sits in one
// IfcSite of one IfcProject. Opens in BIM tools (Navisworks, Solibri, BIMcollab, the Revit IFC viewer…).

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
// IFC GlobalId: 128 random bits in 22 characters (2 bits, then 21 × 6 bits)
export function ifcGuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; // a version 4 UUID
  let bits = "";
  for (const x of b) bits += x.toString(2).padStart(8, "0");
  let s = CHARS[parseInt(bits.slice(0, 2), 2)];
  for (let i = 2; i < 128; i += 6) s += CHARS[parseInt(bits.slice(i, i + 6), 2)];
  return s;
}
// STEP string: quotes doubled, backslash doubled, anything beyond ASCII as \X2\hhhh\X0\
export function stepStr(v) {
  let out = "";
  for (const ch of String(v ?? "")) {
    const c = ch.codePointAt(0);
    if (ch === "'") out += "''";
    else if (ch === "\\") out += "\\\\";
    else if (c >= 32 && c < 127) out += ch;
    else if (c < 32) out += " ";
    else {
      const u = c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)] : [c];
      out += "\\X2\\" + u.map((x) => x.toString(16).toUpperCase().padStart(4, "0")).join("") + "\\X0\\";
    }
  }
  return "'" + out + "'";
}
// STEP real: always with a decimal point
export function real(v) {
  if (!Number.isFinite(v) || Object.is(v, -0)) v = 0;
  let s = String(+v.toFixed(6));
  if (!/[.eE]/.test(s)) s += ".";
  return s.replace("e", "E");
}

export async function writeIFC(app, parts, progress = () => {}) {
  const t = app.tree, lines = [];
  let id = 0;
  const add = (s) => { lines.push(`#${++id}=${s};`); return `#${id}`; };
  const name = (app.title || "modelo").replace(/\.pvs$/i, "");
  const now = new Date().toISOString().slice(0, 19);

  const origin = add("IFCCARTESIANPOINT((0.,0.,0.))");
  const z = add("IFCDIRECTION((0.,0.,1.))"), x = add("IFCDIRECTION((1.,0.,0.))");
  const axes = add(`IFCAXIS2PLACEMENT3D(${origin},${z},${x})`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${axes},$)`);
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const units = [".LENGTHUNIT.,$,.METRE.", ".AREAUNIT.,$,.SQUARE_METRE.", ".VOLUMEUNIT.,$,.CUBIC_METRE.", ".PLANEANGLEUNIT.,$,.RADIAN."]
    .map((u) => add(`IFCSIUNIT(*,${u})`));
  const unitSet = add(`IFCUNITASSIGNMENT((${units.join(",")}))`);
  const project = add(`IFCPROJECT(${stepStr(ifcGuid())},$,${stepStr(name)},$,$,$,$,(${ctx}),${unitSet})`);
  const sitePlace = add(`IFCLOCALPLACEMENT($,${axes})`);
  const site = add(`IFCSITE(${stepStr(ifcGuid())},$,'Modelo',$,$,${sitePlace},$,$,.ELEMENT.,$,$,$,$,$)`);
  add(`IFCRELAGGREGATES(${stepStr(ifcGuid())},$,$,$,${project},(${site}))`);

  const styles = new Map(); // rgb -> IfcSurfaceStyle
  const style = (rgb) => {
    if (rgb < 0) rgb = 0xb4b8bf;
    if (!styles.has(rgb)) {
      const c = add(`IFCCOLOURRGB($,${real(((rgb >> 16) & 255) / 255)},${real(((rgb >> 8) & 255) / 255)},${real((rgb & 255) / 255)})`);
      const sh = add(`IFCSURFACESTYLESHADING(${c},0.)`);
      styles.set(rgb, add(`IFCSURFACESTYLE('#${rgb.toString(16).padStart(6, "0")}',.BOTH.,(${sh}))`));
    }
    return styles.get(rgb);
  };
  const kb = app.keyIndex("Bigrama"), ko = app.keyIndex("part_objectid"), kd = app.keyIndex("Description");
  const elements = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k], g = await app.partGeometry(p);
    progress(k + 1, parts.length);
    if (!g || !g.idx.length) continue;
    const n = app.partNode[p], P = g.pos, I = g.idx;
    let pts = "", tri = "";
    for (let i = 0; i < P.length; i += 3) pts += (i ? "," : "") + `(${real(P[i])},${real(P[i + 1])},${real(P[i + 2])})`;
    for (let i = 0; i < I.length; i += 3) tri += (i ? "," : "") + `(${I[i] + 1},${I[i + 1] + 1},${I[i + 2] + 1})`;
    const list = add(`IFCCARTESIANPOINTLIST3D((${pts}))`);
    const faces = add(`IFCTRIANGULATEDFACESET(${list},$,$,(${tri}),$)`);
    add(`IFCSTYLEDITEM(${faces},(${style(app.partRGB(p))}),$)`);
    const rep = add(`IFCSHAPEREPRESENTATION(${body},'Body','Tessellation',(${faces}))`);
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
    const place = add(`IFCLOCALPLACEMENT(${sitePlace},${axes})`);
    let code = ko >= 0 ? app.prop(n, ko) || "" : "";
    if (code.includes("/")) code = code.slice(code.indexOf("/") + 1);
    const desc = kd >= 0 ? app.prop(n, kd) : null;
    const el = add(`IFCBUILDINGELEMENTPROXY(${stepStr(ifcGuid())},$,${stepStr(t.names[n])},${desc ? stepStr(desc) : "$"},$,${place},${shape},${code ? stepStr(code) : "$"},.ELEMENT.)`);
    elements.push(el);
    // properties: the part's own, its bigrama (from the equipment above when it has none) and its path
    const values = [];
    const prop = (key, v) => values.push(add(`IFCPROPERTYSINGLEVALUE(${stepStr(key)},$,IFCLABEL(${stepStr(String(v).slice(0, 1000))}),$)`));
    for (const [key, v] of app.nodeProps(n)) prop(key, v);
    if (kb >= 0 && app.prop(n, kb) == null && app.bigramaEff && app.bigramaEff[n]) prop("Bigrama", app.bigramaEff[n]);
    prop("Caminho na árvore", app.path(n));
    const pset = add(`IFCPROPERTYSET(${stepStr(ifcGuid())},$,'PVS',$,(${values.join(",")}))`);
    add(`IFCRELDEFINESBYPROPERTIES(${stepStr(ifcGuid())},$,$,$,(${el}),${pset})`);
  }
  if (!elements.length) return null;
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${stepStr(ifcGuid())},$,$,$,(${elements.join(",")}),${site})`);
  const head = [
    "ISO-10303-21;", "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    `FILE_NAME(${stepStr(name + ".ifc")},'${now}',(''),(''),'Visualizador PVS','Visualizador PVS','');`,
    "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;",
  ];
  return { text: head.concat(lines, ["ENDSEC;", "END-ISO-10303-21;", ""]).join("\n"), parts: elements.length };
}
