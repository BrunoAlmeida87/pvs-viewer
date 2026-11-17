// Checks of the desktop app (main.js) kept here, without Electron, so that they can be tested.
const path = require("node:path");

// True when `file` (an absolute, normalized path) is `root` itself or inside it. A sibling folder whose
// name starts like the root ("SBR" and "SBR-convertido") is outside. (`p`: path rules, for the tests.)
function insideFolder(root, file, p = path) {
  const rel = p.relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + p.sep) && !p.isAbsolute(rel));
}

// The pages of the viewer packed with the app: the only ones that may use the desktop bridge (IPC).
function isViewerURL(url) {
  return typeof url === "string" && url.startsWith("app://viewer/");
}

// Links that may be opened in the user's browser: https only (never files, other programs or scripts).
function isExternalLink(url) {
  try { return new URL(url).protocol === "https:"; } catch { return false; }
}

module.exports = { insideFolder, isViewerURL, isExternalLink };
