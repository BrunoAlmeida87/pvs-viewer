// Bigrama: the two letters that follow "LPR-" in an equipment code and tell which system (diagram)
// it belongs to: LPR-DT20003 -> DT. The PVS does not store it as a field, it only exists inside the
// code (property part_objectid "LPR/LPR-DT20003", or the first word of the node name), so it is
// derived here when the model is loaded and added as an ordinary property ("Bigrama"). That way the
// search, the part list, "same value", colour by property and the properties panel all see it.
//
// Codes with three letters before the digits (LPR-GBA04C, LPR-AXF01C) follow another scheme and get
// no bigrama.
export const BIGRAMA_KEY = "Bigrama";

const CODE = /^LPR-[^A-Za-z0-9]*([A-Za-z]{2})\d/; // some codes carry a stray space or byte after the dash

export function bigramaOf(objectId, name) {
  let code = objectId || "";
  const slash = code.indexOf("/");
  if (slash >= 0) code = code.slice(slash + 1);
  let m = CODE.exec(code);
  if (!m) {
    const first = (name || "").split(" - ")[0];
    m = CODE.exec(first);
  }
  return m ? m[1].toUpperCase() : "";
}

// Adds the Bigrama property to the tree (props: keys / vals / start / kv). Returns how many nodes got one.
export function addBigrama(tree) {
  const P = tree.props;
  if (P.keys.includes(BIGRAMA_KEY)) return 0; // a converter that already wrote it wins
  const oi = P.keys.indexOf("part_objectid");
  const ki = P.keys.length;
  const valIx = new Map();
  const n = tree.names.length;
  const start = new Array(n + 1);
  const kv = [];
  let found = 0;
  start[0] = 0;
  for (let node = 0; node < n; node++) {
    let id = "";
    for (let i = P.start[node]; i < P.start[node + 1]; i++) {
      kv.push(P.kv[2 * i], P.kv[2 * i + 1]);
      if (oi >= 0 && P.kv[2 * i] === oi) id = P.vals[P.kv[2 * i + 1]];
    }
    const b = bigramaOf(id, tree.names[node]);
    if (b) {
      let vi = valIx.get(b);
      if (vi === undefined) { vi = P.vals.length; P.vals.push(b); valIx.set(b, vi); }
      kv.push(ki, vi);
      found++;
    }
    start[node + 1] = kv.length / 2;
  }
  if (!found) return 0;
  P.keys.push(BIGRAMA_KEY);
  P.start = start;
  P.kv = kv;
  return found;
}
