// Small DOM and data helpers shared by the UI modules.
export const $ = (s) => document.querySelector(s);
// shown on the phone (tools sheet, AR) so that it is easy to tell which version is running
export const VERSION = "1.2.1";

export function status(t) { $("#load").textContent = t; }

// el("div.cls", {title: ...}, child1, "text", ...)
export function el(spec, attrs, ...kids) {
  const [tag, ...cls] = spec.split(".");
  const e = document.createElement(tag || "div");
  if (cls.length) e.className = cls.join(" ");
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "text") e.textContent = v;
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

export const fmt = (n) => n.toLocaleString("pt-BR");

// Number in a property value ("12", "0,5", ".24335"); NaN when not numeric.
export function num(v) {
  if (v == null) return NaN;
  const s = String(v).trim().replace(",", ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return NaN;
  return parseFloat(s);
}

export const hex = (rgb) => "#" + rgb.toString(16).padStart(6, "0");
export const parseHex = (h) => parseInt(h.slice(1), 16);

// Distinct categorical colours (golden-angle hues), returned as 0xRRGGBB.
export function palette(i) {
  const fixed = [0x1f77b4, 0xff7f0e, 0x2ca02c, 0xd62728, 0x9467bd, 0x8c564b, 0xe377c2, 0x17becf, 0xbcbd22, 0x7f7f7f,
    0x393b79, 0xe6550d, 0x31a354, 0x843c39, 0x7b4173, 0x3182bd, 0xfd8d3c, 0x74c476, 0xd6616b, 0x9e9ac8];
  if (i < fixed.length) return fixed[i];
  const h = (i * 137.508) % 360, s = 0.55, l = 0.5;
  return hsl(h, s, l);
}

export function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

// Blue -> red ramp for t in [0, 1].
export function ramp(t) { return hsl(240 - 240 * Math.max(0, Math.min(1, t)), 0.75, 0.5); }

export function download(name, text, type = "text/csv;charset=utf-8") {
  const blob = new Blob(["﻿" + text], { type });
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Save binary data where the user chooses: the desktop app's save dialog, the browser's file picker
// (Chrome / Edge, starting in `startIn` when given) or an ordinary download. Returns a short
// description of where it went, or null when cancelled.
export async function saveBytes(name, data, { description, mime, ext, startIn } = {}) {
  if (window.desktop?.saveFile) return window.desktop.saveFile(name, data, description, [ext]);
  if (window.showSaveFilePicker) {
    try {
      const opts = { suggestedName: name, types: [{ description, accept: { [mime]: ["." + ext] } }] };
      if (startIn) opts.startIn = startIn;
      const h = await window.showSaveFilePicker(opts);
      const w = await h.createWritable();
      await w.write(data);
      await w.close();
      return h.name;
    } catch (e) {
      if (e.name === "AbortError") return null;
      if (e.name !== "SecurityError" && e.name !== "TypeError") throw e; // not allowed here: download instead
    }
  }
  const a = el("a", { href: URL.createObjectURL(new Blob([data], { type: mime })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return "Downloads/" + name;
}

// CSV with ";" (opens as columns in Excel pt-BR).
export function csv(rows) {
  const q = (v) => {
    const s = v == null ? "" : String(v);
    return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(q).join(";")).join("\r\n");
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
