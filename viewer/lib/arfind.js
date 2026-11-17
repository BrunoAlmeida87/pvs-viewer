// Finding an item at real size in the augmented reality (like a tracker's "precision finding"): from
// where you stand and the way the phone points, where the item is — which way, how far, how high —
// and when you are there. Everything in model coordinates (metres, z up). Pure: tested in Node.

const DEG = Math.PI / 180;
export const NEAR_STEPS = [20, 10, 5, 2]; // metres: a buzz when getting closer than these
const REACH_UP = 2.0; // metres over the floor that a hand still reaches: higher is "acima"

// user: {x, y, feet} (feet: the floor under the phone) · heading: [hx, hy] the way the phone points,
// in plan · boxes: [[minx, miny, minz, maxx, maxy, maxz], …] (several items: the nearest one counts).
// → {index, target: [x, y, z], dist (m, in plan; 0 over it), rel (rad, + to the right), side,
//    level: {kind: "same" | "above" | "below", dz (m)}, arrived}
export function findInfo(user, heading, boxes) {
  let best = null;
  boxes.forEach((b, index) => {
    const tx = Math.max(b[0], Math.min(b[3], user.x)), ty = Math.max(b[1], Math.min(b[4], user.y));
    const dist = Math.hypot(tx - user.x, ty - user.y);
    const level = levelOf(b, user.feet);
    const score = dist + (level.kind === "same" ? 0 : level.dz * 3); // another deck is farther than it looks
    if (!best || score < best.score) best = { index, score, dist, level, target: [tx, ty, Math.max(b[2], Math.min(b[5], user.feet + 1.2))], box: b };
  });
  if (!best) return null;
  // the direction: to the nearest point of the item, or to its middle when standing over it
  let vx = best.target[0] - user.x, vy = best.target[1] - user.y;
  if (Math.hypot(vx, vy) < 0.05) { vx = (best.box[0] + best.box[3]) / 2 - user.x; vy = (best.box[1] + best.box[4]) / 2 - user.y; }
  const hl = Math.hypot(heading[0], heading[1]) || 1, hx = heading[0] / hl, hy = heading[1] / hl;
  const rel = Math.atan2(vx * hy - vy * hx, vx * hx + vy * hy); // right of (hx, hy) is (hy, -hx)
  return {
    index: best.index, target: best.target, dist: best.dist, rel, side: sideText(rel, best.dist), level: best.level,
    arrived: best.dist < 1 && best.level.kind === "same",
  };
}

function levelOf(b, feet) {
  if (b[2] - feet > REACH_UP) return { kind: "above", dz: b[2] - feet };
  if (b[5] < feet - 0.3) return { kind: "below", dz: feet - b[5] };
  return { kind: "same", dz: 0 };
}

export function sideText(rel, dist = Infinity) {
  if (dist < 0.3) return "aqui";
  const a = Math.abs(rel) / DEG, s = rel > 0 ? "à direita" : "à esquerda";
  if (a < 25) return "à frente";
  if (a < 65) return "à frente, " + s;
  if (a < 115) return s;
  if (a < 155) return "atrás, " + s;
  return "atrás de você";
}

export const metres = (m) => (m < 10 ? Math.max(0, m).toFixed(1).replace(".", ",").replace(/,0$/, "") : String(Math.round(m))) + " m";

// the line under the name: "12 m · à direita · 3,5 m acima"
export function findLine(info) {
  if (info.arrived) return info.side === "aqui" ? "você está junto dele" : info.side;
  const parts = [metres(info.dist), info.side];
  if (info.level.kind === "above") parts.push(metres(info.level.dz) + " acima");
  if (info.level.kind === "below") parts.push(metres(info.level.dz) + " abaixo (outro nível)");
  return parts.join(" · ");
}

// the step of NEAR_STEPS passed when going from `before` to `now` metres away (getting closer), or 0
export function closerStep(before, now) {
  for (const s of NEAR_STEPS.slice().reverse()) if (before > s && now <= s) return s;
  return 0;
}
