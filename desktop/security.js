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

// Content Security Policy of a viewer page: scripts only from the app itself and the page's own inline
// scripts, allowed by their hash (computed from the page, so editing index.html never breaks it); no
// eval, no plugins. Models are read through model://; blob: and data: are images, downloads and
// the drawings of the page.
function viewerCSP(html) {
  const crypto = require("node:crypto");
  const hashes = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1])) continue; // an external script: allowed by 'self'
    hashes.push(`'sha256-${crypto.createHash("sha256").update(m[2], "utf8").digest("base64")}'`);
  }
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.length ? " " + hashes.join(" ") : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: model:",
    "connect-src 'self' model: blob: data:",
    "worker-src 'self'",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

module.exports = { insideFolder, isViewerURL, isExternalLink, viewerCSP };
