// GLSL of the model's materials (viewer.js): the shared part (cuts, ids), the vertex stage, the
// shaded surfaces, the CAD edges and the walking-map slices. Moved out of viewer.js unchanged.

// itemTex: one texel per draw item.  rgb = colour, a = state:
//   0 = hidden, otherwise bit 7 = selected and bits 0..6 = opacity (127 = opaque).
// offTex: per item xyz offset (exploded view).
// Every chunk is drawn twice: pass 0 draws opaque items, pass 1 the translucent ones.
// pickMode 1 writes item ids, 2 writes the view depth (float bits).
export const COMMON = /* glsl */ `
precision highp float;
precision highp int;
uniform int pickMode;
uniform int style;
uniform int clipOn;
uniform int clipInvert;
uniform vec3 clipMin;
uniform vec3 clipMax;
uniform int planeOn;  // free section plane: removes where dot(w, plane.xyz) > plane.w
uniform vec4 plane;
uniform int nbClip;   // neighbourhood cut: 0 off, 1 sphere, 2 box
uniform vec3 nbC;
uniform float nbR;
uniform vec3 nbMin;
uniform vec3 nbMax;
bool clipped(vec3 w) {
  if (planeOn == 1 && dot(w, plane.xyz) > plane.w) return true;
  if (nbClip == 1 && distance(w, nbC) > nbR) return true;
  if (nbClip == 2 && (any(lessThan(w, nbMin)) || any(greaterThan(w, nbMax)))) return true;
  if (clipOn == 0) return false;
  bool inside = all(greaterThanEqual(w, clipMin)) && all(lessThanEqual(w, clipMax));
  return clipInvert == 1 ? inside : !inside;
}
vec4 packId(uint id) {
  return vec4(float(id & 255u), float((id >> 8) & 255u), float((id >> 16) & 255u), float(id >> 24)) / 255.0;
}`;

export const VERT_HEAD = /* glsl */ `
in uvec4 qpos;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 bmin;
uniform vec3 bext;
uniform int itemOffset;
uniform int exploded;
uniform sampler2D itemTex;
uniform sampler2D offTex;
out vec3 vView;
out vec3 vWorld;
flat out vec4 vCol;
flat out float vSel;
flat out uint vId;
int op;
bool sel;
vec4 itemState(out ivec2 tc) {
  int idx = itemOffset + int(qpos.w);
  tc = ivec2(idx & 4095, idx >> 12);
  vec4 t = texelFetch(itemTex, tc, 0);
  int av = int(t.a * 255.0 + 0.5);
  op = av & 127;
  sel = av >= 128;
  vId = uint(idx + 1);
  vSel = sel ? 1.0 : 0.0;
  return t;
}
vec4 place(ivec2 tc) {
  vec3 p = bmin + vec3(qpos.xyz) * (bext / 65535.0);
  if (exploded == 1) p += texelFetch(offTex, tc, 0).xyz;
  vWorld = p;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = mv.xyz;
  return projectionMatrix * mv;
}`;

export const VERT = COMMON + VERT_HEAD + /* glsl */ `
in vec4 nrm;
uniform mat3 normalMatrix;
uniform int pass;
out vec3 vNormal;
const int XRAY_OP = 20;
void main() {
  ivec2 tc;
  vec4 t = itemState(tc);
  if (style == 4 && pickMode == 0 && !sel && op > XRAY_OP) op = XRAY_OP;
  bool draw = op > 0 && (pass == 0 ? op == 127 : op < 127);
  if (pickMode != 0 && pass == 1) draw = false;
  vCol = vec4(t.rgb, float(op) / 127.0);
  vNormal = normalMatrix * nrm.xyz;
  vec4 p = place(tc);
  gl_Position = draw ? p : vec4(0.0, 0.0, 2.0, 1.0);
}`;

export const FRAG = COMMON + /* glsl */ `
in vec3 vView;
in vec3 vWorld;
in vec3 vNormal;
flat in vec4 vCol;
flat in float vSel;
flat in uint vId;
uniform int pass;
uniform int ortho;
uniform int smoothOn;
uniform int capOn;
uniform vec3 light;   // ambient, diffuse, specular
uniform vec3 skyDir;  // view space
uniform float skyMix;
uniform float bright;
out vec4 outColor;
void main() {
  if ((clipOn == 1 || nbClip > 0 || planeOn == 1) && clipped(vWorld)) discard;
  if (pickMode == 1) { outColor = packId(vId); return; }
  if (pickMode == 2) { outColor = packId(floatBitsToUint(-vView.z)); return; }
  vec3 base = vCol.rgb;
  if (style == 2) base = vec3(1.0);
  if (vSel > 0.5) base = mix(base, vec3(1.0, 0.42, 0.05), style == 2 ? 0.35 : 0.7);
  if (capOn == 1 && (clipOn == 1 || nbClip > 0 || planeOn == 1) && !gl_FrontFacing) {
    // inside of a cut solid: flat hatched cap
    vec3 c = base * 0.62 * bright;
    if (mod(gl_FragCoord.x - gl_FragCoord.y, 7.0) < 1.3) c *= 0.55;
    outColor = vec4(c, 1.0);
    return;
  }
  if (style == 2) { outColor = vec4(base, 1.0); return; }
  vec3 fn = normalize(cross(dFdx(vView), dFdy(vView))); // faces the camera
  vec3 n = fn;
  if (smoothOn == 1) {
    float l = length(vNormal);
    if (l > 0.05) {
      vec3 s = vNormal / l;
      if (!gl_FrontFacing) s = -s;
      if (dot(s, fn) > 0.82) n = s; // a normal far from the facet comes from a crease: stay flat
    }
  }
  vec3 V = ortho == 1 ? vec3(0.0, 0.0, 1.0) : normalize(-vView);
  float d = max(dot(n, V), 0.0);
  float dif = mix(d, 0.55 * d + 0.45 * (0.5 + 0.5 * dot(n, skyDir)), skyMix);
  vec3 c = (base * (light.x + light.y * dif) + vec3(light.z) * pow(d, 30.0)) * bright;
  float a = 1.0;
  if (pass == 1) {
    a = vCol.a;
    if (style == 4 && vSel < 0.5) { float f = 1.0 - d; a = clamp(a * (0.6 + 2.4 * f * f), 0.04, 0.6); }
  }
  outColor = vec4(c, a);
}`;

export const EDGE_VERT = COMMON + VERT_HEAD + /* glsl */ `
void main() {
  ivec2 tc;
  vec4 t = itemState(tc);
  bool draw = op > 0 && (style == 3 || op == 127);
  vCol = vec4(t.rgb, float(op) / 127.0);
  vec4 p = place(tc);
  gl_Position = draw ? p : vec4(0.0, 0.0, 2.0, 1.0);
}`;

export const EDGE_FRAG = COMMON + /* glsl */ `
in vec3 vView;
in vec3 vWorld;
flat in vec4 vCol;
flat in float vSel;
flat in uint vId;
out vec4 outColor;
void main() {
  if ((clipOn == 1 || nbClip > 0 || planeOn == 1) && clipped(vWorld)) discard;
  if (pickMode == 1) { outColor = packId(vId); return; }
  if (pickMode == 2) { outColor = packId(floatBitsToUint(-vView.z)); return; }
  vec3 c = style == 3 ? vCol.rgb * 0.9 : style == 2 ? vec3(0.08) : vCol.rgb * 0.22;
  if (vSel > 0.5) c = style == 3 ? vec3(1.0, 0.42, 0.05) : vec3(0.7, 0.22, 0.0);
  outColor = vec4(c, 1.0);
}`;

// Walking map: the view depth of every surface (negative for back faces), for viewer.js navSlices.
export const NAV_FRAG = COMMON + /* glsl */ `
in vec3 vView;
in vec3 vWorld;
flat in vec4 vCol;
flat in float vSel;
flat in uint vId;
out vec4 outColor;
void main() {
  if ((clipOn == 1 || nbClip > 0 || planeOn == 1) && clipped(vWorld)) discard;
  float d = -vView.z;
  outColor = packId(floatBitsToUint(gl_FrontFacing ? d : -d));
  // a face of a solid standing on a floor and that floor are at the same depth: the inside wins
  gl_FragDepth = gl_FrontFacing ? gl_FragCoord.z : max(0.0, gl_FragCoord.z - 4e-6);
}`;
