// Loading by region: a dialog to choose which level-1 / level-2 assemblies to load, used before
// the first load (option on the open card) and later by the "Carregar…" button.
import { $, el, fmt } from "./util.js";

// Resolves to Uint8Array flags per part, null for "everything", or undefined when cancelled.
export function chooseRegions(app, more = false) {
  return new Promise((resolve) => {
    const dlg = $("#regionDlg"), list = $("#regionList");
    list.innerHTML = "";
    const t = app.tree;
    const availableIn = (n) => { let k = 0; for (let p = t.p0[n]; p < t.p1[n]; p++) k += app.availableParts[p]; return k; };
    const loadedIn = (n) => { let k = 0; for (let p = t.p0[n]; p < t.p1[n]; p++) k += app.availableParts[p] && app.partLoaded[p]; return k; };
    const boxes = [];
    for (const n of app.kids(0)) {
      const total = availableIn(n);
      if (!total) continue;
      const done = loadedIn(n);
      const cb = el("input", { type: "checkbox", disabled: done === total, checked: done === total });
      const sub = [];
      const kids = el("div.sub");
      for (const k of app.kids(n)) {
        const kt = availableIn(k);
        if (!kt) continue;
        const kd = loadedIn(k);
        const kcb = el("input", { type: "checkbox", disabled: kd === kt, checked: kd === kt });
        kcb.onchange = () => { cb.checked = sub.every((s) => s.cb.checked); };
        sub.push({ node: k, cb: kcb });
        kids.append(el("label", null, kcb, ` ${t.names[k]} `, el("span.muted", { text: `${fmt(kt)} peças` + (kd && kd < kt ? ` (${fmt(kd)} carregadas)` : "") })));
      }
      cb.onchange = () => { for (const s of sub) if (!s.cb.disabled) s.cb.checked = cb.checked; };
      boxes.push({ node: n, cb, sub });
      const head = el("summary", null, cb, ` ${t.names[n]} `, el("span.muted", { text: `${fmt(total)} peças` + (done && done < total ? ` (${fmt(done)} carregadas)` : "") }));
      head.querySelector("input").onclick = (e) => e.stopPropagation();
      list.append(sub.length ? el("details", null, head, kids) : el("div.row1", null, ...head.childNodes));
    }
    $("#regionTitle").textContent = more ? "Carregar mais partes do modelo" : "Escolha o que carregar";
    const mobile = document.documentElement.classList.contains("mobile");
    $("#regionHint").textContent = mobile && !more
      ? "Escolha seções ou toque em Prévia geral. A primeira abertura carrega até 2,5 milhões de triângulos; use Carregar para acrescentar o restante."
      : "Marque as seções (nível 1) ou abra uma delas para escolher os subsistemas (nível 2).";
    $("#regionAll").textContent = mobile && !more ? "Prévia geral" : "Tudo";
    $("#regionSel").disabled = !app.selNodes.size;
    dlg.hidden = false;
    const close = (v) => { dlg.hidden = true; resolve(v); };
    const flags = (fill) => {
      const f = new Uint8Array(app.nParts);
      fill(f);
      for (let p = 0; p < f.length; p++) f[p] &= app.availableParts[p];
      return f;
    };
    $("#regionOk").onclick = () => close(flags((f) => {
      for (const b of boxes) {
        if (b.sub.length) { for (const s of b.sub) if (s.cb.checked && !s.cb.disabled) f.fill(1, t.p0[s.node], t.p1[s.node]); }
        else if (b.cb.checked && !b.cb.disabled) f.fill(1, t.p0[b.node], t.p1[b.node]);
      }
      // parts directly under a level-1 assembly (not inside a level-2 one)
      for (const b of boxes) if (b.sub.length && b.cb.checked && !b.cb.disabled) {
        for (let p = t.p0[b.node]; p < t.p1[b.node]; p++) if (app.depth[app.partNode[p]] === 2) f[p] = 1;
      }
    }));
    $("#regionSel").onclick = () => close(flags((f) => { for (const n of app.selNodes) f.fill(1, t.p0[n], t.p1[n]); }));
    $("#regionAll").onclick = () => close(app.availableParts.every((v) => v) ? null : app.availableParts.slice());
    $("#regionCancel").onclick = () => close(more ? undefined : document.documentElement.classList.contains("mobile") ? new Uint8Array(app.nParts) : null);
  });
}

export function initRegions(app) {
  $("#loadMoreBtn").onclick = async () => {
    const want = await chooseRegions(app, true);
    if (want === undefined) return;
    await app.loadParts(want);
  };
}
