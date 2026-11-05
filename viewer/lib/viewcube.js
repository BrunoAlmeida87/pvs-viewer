// View cube drawn in a corner of the main canvas. Clicking a face, edge or corner returns the
// direction (from the target towards the camera) of that view. Z is up; the "front" is +X.
import * as THREE from "three";

const LABELS = ["FRENTE", "TRÁS", "TOPO", "BASE", "ESQ.", "DIR."]; // +X -X +Z -Z -Y +Y

function faceTexture(text) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#f3f5f8"; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "#9aa3b0"; g.lineWidth = 6; g.strokeRect(3, 3, 122, 122);
  g.fillStyle = "#394150"; g.font = "bold 24px Segoe UI, sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class ViewCube {
  constructor() {
    this.size = 96;
    this.margin = 8;
    this.visible = true;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.1, 10);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.rotateX(Math.PI / 2); // box faces: +X, -X, +Z, -Z, -Y, +Y with labels upright for Z-up
    this.mats = LABELS.map((l) => new THREE.MeshBasicMaterial({ map: faceTexture(l) }));
    this.cube = new THREE.Mesh(geo, this.mats);
    this.scene.add(this.cube);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x6b7280 }));
    this.scene.add(edges);
    // axis triad at the -X -Y -Z corner
    const axis = (dir, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(-0.5, -0.5, -0.5).addScaledVector(dir, 0.75)]);
      this.scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
    };
    axis(new THREE.Vector3(1, 0, 0), 0xd03b3b); axis(new THREE.Vector3(0, 1, 0), 0x2f9e44); axis(new THREE.Vector3(0, 0, 1), 0x1c7ed6);
    this.ray = new THREE.Raycaster();
  }

  // Draw over the current frame (call after the main render).
  render(renderer, mainCamera, viewW, viewH) {
    if (!this.visible) return;
    const q = mainCamera.quaternion;
    this.camera.position.set(0, 0, 3).applyQuaternion(q);
    this.camera.quaternion.copy(q);
    this.camera.updateMatrixWorld();
    const s = this.size, m = this.margin;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setViewport(m, viewH - s - m, s, s);
    renderer.setScissor(m, viewH - s - m, s, s);
    renderer.setScissorTest(true);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, viewW, viewH);
    renderer.autoClear = auto;
  }

  inside(x, y) { // x, y relative to the canvas, CSS pixels
    const s = this.size, m = this.margin;
    return this.visible && x >= m && x <= m + s && y >= m && y <= m + s;
  }

  // View direction for a click at canvas position (x, y), or null.
  pick(x, y) {
    if (!this.inside(x, y)) return null;
    const s = this.size, m = this.margin;
    const ndc = new THREE.Vector2(((x - m) / s) * 2 - 1, -(((y - m) / s) * 2 - 1));
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.intersectObject(this.cube, false)[0];
    if (!hit) return null;
    const p = hit.point;
    const d = new THREE.Vector3(...[p.x, p.y, p.z].map((c) => (Math.abs(c) > 0.3 ? Math.sign(c) : 0)));
    return d.lengthSq() ? d.normalize() : null;
  }
}
