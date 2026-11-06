// Copies ../viewer into app/viewer for packing (without converted models or the Python server).
const fs = require("node:fs");
const path = require("node:path");

const src = path.resolve(__dirname, "..", "..", "viewer");
const dst = path.resolve(__dirname, "..", "app", "viewer");
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, {
  recursive: true,
  filter: (s) => {
    const rel = path.relative(src, s).replace(/\\/g, "/");
    return !(rel === "data" || rel.startsWith("data/") || rel.startsWith("data_") || rel.endsWith(".py"));
  },
});
console.log("viewer copiado para", dst);
