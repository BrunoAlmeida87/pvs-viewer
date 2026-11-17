const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { insideFolder, isViewerURL, isExternalLink, viewerCSP } = require("../security");
const crypto = require("node:crypto");

test("a file is served only from inside its folder, not from a sibling with the same prefix", () => {
  const root = path.resolve("/modelos/SBR");
  const at = (p) => path.normalize(path.join(root, p));
  assert.equal(insideFolder(root, at("/tree.json")), true);
  assert.equal(insideFolder(root, at("/c/00001.bin")), true);
  assert.equal(insideFolder(root, at("/..foo.json")), true); // a name that starts with two dots is still inside
  assert.equal(insideFolder(root, at("/../SBR-convertido/tree.json")), false); // the sibling folder
  assert.equal(insideFolder(root, at("/../../etc/passwd")), false);
  assert.equal(insideFolder(root, root), true);
});

test("the same with Windows paths (drive letters, backslashes, any letter case)", () => {
  const w = path.win32, root = "C:\\Modelos\\SBR";
  const at = (p) => w.normalize(w.join(root, p));
  assert.equal(insideFolder(root, at("/c/00001.bin"), w), true);
  assert.equal(insideFolder(root, "c:\\modelos\\sbr\\tree.json", w), true);
  assert.equal(insideFolder(root, at("/../SBR-convertido/tree.json"), w), false);
  assert.equal(insideFolder(root, at("\\..\\..\\Windows\\win.ini"), w), false);
  assert.equal(insideFolder(root, "D:\\SBR\\tree.json", w), false);
});

test("only the viewer's own pages may use the desktop bridge", () => {
  assert.equal(isViewerURL("app://viewer/index.html"), true);
  assert.equal(isViewerURL("app://viewer/index.html?abrir=#vista=x"), true);
  for (const u of ["file:///C:/model/x.html", "https://example.com/", "app://viewerx/index.html", "model://local/a.html", "", null, undefined])
    assert.equal(isViewerURL(u), false, String(u));
});

test("the content policy allows the page's own inline scripts by their hash, and nothing inline else", () => {
  const html = `<html><head><script>let a = 1;</script>
<script type="importmap">{ "imports": { "three": "./vendor/three.module.min.js" } }</script>
<script src="other.js"></script></head><body><script type="module">
import("./viewer.js");
</script></body></html>`;
  const csp = viewerCSP(html);
  const h = (s) => `'sha256-${crypto.createHash("sha256").update(s, "utf8").digest("base64")}'`;
  const script = csp.split("; ").find((d) => d.startsWith("script-src "));
  for (const inline of ["let a = 1;", `{ "imports": { "three": "./vendor/three.module.min.js" } }`, `\nimport("./viewer.js");\n`])
    assert.ok(script.includes(h(inline)), "missing the hash of: " + inline);
  assert.equal(script.split(" ").length, 2 + 3, script); // script-src 'self' + three hashes (the src one needs none)
  assert.ok(!/unsafe-inline|unsafe-eval/.test(script));
  for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'none'"]) assert.ok(csp.includes(d), d);
  assert.match(csp, /connect-src [^;]*model:/); // the model folder is read through model://
});

test("links opened outside the app: https only", () => {
  assert.equal(isExternalLink("https://brunoalmeida87.github.io/pvs-viewer/"), true);
  for (const u of ["file:///C:/Windows/System32/calc.exe", "http://example.com", "ms-settings:", "javascript:alert(1)", "smb://server/share", "not a url"])
    assert.equal(isExternalLink(u), false, u);
});
