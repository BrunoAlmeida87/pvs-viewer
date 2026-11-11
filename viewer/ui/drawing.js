// "Vista 2D" panel: a plan, an elevation or the current view as a drawing with dimensions, on a
// sheet, saved as SVG, PDF or DXF (lib/drawing.js). It draws what is visible now, with the cuts:
// cut in Z and draw the plan to get a floor plan at that height.
import { $, status, saveBytes } from "./util.js";
import { buildDrawing, layout, toSVG, toPDF, toDXF } from "../lib/drawing.js";

export function initDrawing(app) {
  const panel = $("#drawPanel"), btn = $("#drawBtn"), hint = $("#drawHint"), preview = $("#drawPreview");
  let sheet = null; // the last layout
  const opts = () => ({
    view: $("#drawView").value, sheet: $("#drawSheet").value, scale: $("#drawScale").value,
    overall: $("#drawOverall").checked, measures: $("#drawMeasures").checked, codes: $("#drawCodes").checked,
    title: (app.title || "modelo").replace(/\.pvs$/i, ""),
  });
  const setOut = (on) => { for (const id of ["#drawSvg", "#drawPdf", "#drawDxf"]) $(id).disabled = !on; };
  async function make() {
    if (!app.tree) return;
    if (!app.canReadGeometry()) { hint.textContent = "A vista 2D precisa da geometria das peças (abra a pasta do modelo ou uma pasta convertida)."; return; }
    $("#drawMake").disabled = true;
    setOut(false);
    try {
      hint.textContent = "Desenhando…";
      const o = opts();
      const d = await buildDrawing(app, o, (i, n) => { hint.textContent = `Desenhando… ${Math.round(i / Math.max(1, n) * 100)}%`; });
      if (!d) { hint.textContent = "Nada visível para desenhar."; sheet = null; preview.innerHTML = ""; return; }
      sheet = layout(d, o);
      preview.innerHTML = toSVG(sheet);
      setOut(true);
      hint.textContent = `${d.segs.length.toLocaleString("pt-BR")} linhas · escala 1:${sheet.scale}` + (sheet.fits ? "" : " · o desenho passa da folha: escolha outra escala ou uma folha maior");
    } catch (e) {
      hint.textContent = "Erro ao desenhar: " + e.message;
      console.error(e);
    } finally { $("#drawMake").disabled = false; }
  }
  const name = (ext) => `${opts().title}-${$("#drawView").selectedOptions[0].textContent.split(" ")[0].toLowerCase()}.${ext}`;
  async function save(kind) {
    if (!sheet) return;
    const r = kind === "svg" ? await saveBytes(name("svg"), new TextEncoder().encode(toSVG(sheet)), { description: "Desenho SVG", mime: "image/svg+xml", ext: "svg" })
      : kind === "pdf" ? await saveBytes(name("pdf"), toPDF(sheet), { description: "PDF", mime: "application/pdf", ext: "pdf" })
        : await saveBytes(name("dxf"), toDXF(sheet), { description: "DXF", mime: "image/vnd.dxf", ext: "dxf" });
    if (r) status("Desenho salvo: " + r);
  }
  $("#drawMake").onclick = make;
  $("#drawSvg").onclick = () => save("svg");
  $("#drawPdf").onclick = () => save("pdf");
  $("#drawDxf").onclick = () => save("dxf");
  // a change of the options asks for a new drawing
  for (const id of ["#drawView", "#drawSheet", "#drawScale", "#drawOverall", "#drawMeasures", "#drawCodes"]) $(id).addEventListener("change", () => { if (sheet) make(); });
  btn.onclick = () => { panel.hidden = !panel.hidden; };
  new MutationObserver(() => btn.classList.toggle("on", !panel.hidden)).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  app.on("model", () => { sheet = null; preview.innerHTML = ""; setOut(false); });
  app.makeDrawing = make;
}
