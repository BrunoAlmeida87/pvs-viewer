// Screen-space ambient occlusion: the scene is drawn into an off-screen target (colour + depth),
// occlusion is estimated from the depth buffer at half resolution and multiplied into the colour.
import * as THREE from "three";

const QUAD_VERT = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const N = 16;
const AO_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D tDepth;
uniform mat4 proj;
uniform mat4 invProj;
uniform vec2 texel;
uniform float radius;
uniform vec3 kernel[${N}];
out vec4 outColor;
vec3 viewPos(vec2 uv) {
  float d = texture(tDepth, uv).x;
  vec4 p = invProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  float d = texture(tDepth, vUv).x;
  if (d >= 1.0) { outColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv);
  vec3 px = viewPos(vUv + vec2(texel.x, 0.0)), nx = viewPos(vUv - vec2(texel.x, 0.0));
  vec3 py = viewPos(vUv + vec2(0.0, texel.y)), ny = viewPos(vUv - vec2(0.0, texel.y));
  vec3 dx = abs(px.z - P.z) < abs(P.z - nx.z) ? px - P : P - nx;
  vec3 dy = abs(py.z - P.z) < abs(P.z - ny.z) ? py - P : P - ny;
  vec3 n = normalize(cross(dx, dy));
  float a = hash(gl_FragCoord.xy) * 6.2831853;
  vec3 r = vec3(cos(a), sin(a), 0.0);
  vec3 t = normalize(r - n * dot(r, n));
  mat3 tbn = mat3(t, cross(n, t), n);
  float occ = 0.0;
  for (int i = 0; i < ${N}; i++) {
    vec3 s = P + tbn * kernel[i] * radius;
    vec4 o = proj * vec4(s, 1.0);
    vec2 uv = o.xy / o.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    float sz = viewPos(uv).z;
    float range = smoothstep(0.0, 1.0, radius / max(abs(P.z - sz), 1e-6));
    occ += (sz >= s.z + radius * 0.03 ? 1.0 : 0.0) * range;
  }
  outColor = vec4(vec3(1.0 - occ / float(${N})), 1.0);
}`;

const COMP_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tAO;
uniform vec2 aoTexel;
uniform float strength;
out vec4 outColor;
void main() {
  vec4 c = texture(tColor, vUv);
  float ao = 0.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) ao += texture(tAO, vUv + vec2(x, y) * aoTexel).r;
  ao /= 9.0;
  outColor = vec4(c.rgb * mix(1.0, ao, strength), c.a);
}`;

export class SSAO {
  constructor(renderer) {
    this.renderer = renderer;
    this.size = new THREE.Vector2();
    this.rt = null; this.aoRT = null;
    const kernel = [];
    for (let i = 0; i < N; i++) {
      // points in the upper hemisphere, denser near the centre
      const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 0.9 + 0.1).normalize();
      let s = i / N; s = 0.1 + 0.9 * s * s;
      kernel.push(v.multiplyScalar(s * (0.5 + 0.5 * Math.random())));
    }
    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.aoMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: QUAD_VERT, fragmentShader: AO_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tDepth: { value: null }, proj: { value: new THREE.Matrix4() }, invProj: { value: new THREE.Matrix4() },
        texel: { value: new THREE.Vector2() }, radius: { value: 1 }, kernel: { value: kernel } },
    });
    this.compMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: QUAD_VERT, fragmentShader: COMP_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tColor: { value: null }, tAO: { value: null }, aoTexel: { value: new THREE.Vector2() }, strength: { value: 0.85 } },
    });
    this.quad = new THREE.Mesh(tri, this.aoMat);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  ensure() {
    const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.rt && s.equals(this.size)) return;
    this.size.copy(s);
    if (this.rt) { this.rt.depthTexture.dispose(); this.rt.dispose(); this.aoRT.dispose(); }
    const depth = new THREE.DepthTexture(s.x, s.y, THREE.UnsignedIntType);
    depth.minFilter = depth.magFilter = THREE.NearestFilter;
    this.rt = new THREE.WebGLRenderTarget(s.x, s.y, { samples: 4, depthTexture: depth, depthBuffer: true });
    const hw = Math.max(1, s.x >> 1), hh = Math.max(1, s.y >> 1);
    this.aoRT = new THREE.WebGLRenderTarget(hw, hh, { depthBuffer: false });
    this.aoMat.uniforms.texel.value.set(1 / s.x, 1 / s.y);
    this.compMat.uniforms.aoTexel.value.set(1 / hw, 1 / hh);
  }

  // Draws scene into the off-screen target, then the shaded result to the screen.
  render(scene, camera, radius) {
    const r = this.renderer;
    this.ensure();
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(scene, camera);
    const u = this.aoMat.uniforms;
    u.tDepth.value = this.rt.depthTexture;
    u.proj.value.copy(camera.projectionMatrix);
    u.invProj.value.copy(camera.projectionMatrixInverse);
    u.radius.value = radius;
    this.quad.material = this.aoMat;
    r.setRenderTarget(this.aoRT);
    r.render(this.quadScene, this.quadCam);
    this.compMat.uniforms.tColor.value = this.rt.texture;
    this.compMat.uniforms.tAO.value = this.aoRT.texture;
    this.quad.material = this.compMat;
    r.setRenderTarget(null);
    r.clear();
    r.render(this.quadScene, this.quadCam);
  }

  dispose() {
    if (this.rt) { this.rt.depthTexture.dispose(); this.rt.dispose(); this.aoRT.dispose(); this.rt = null; }
  }
}
