// Choose a bounded first view of a large converted model. Larger pieces are more useful for
// recognizing the assembly; the remaining chunks stay available through "Carregar".
export const MOBILE_PREVIEW_TRIANGLES = 2_500_000;

export function previewChunks(chunks, indices, budget = MOBILE_PREVIEW_TRIANGLES) {
  const total = indices.reduce((sum, i) => sum + chunks[i].ni / 3, 0);
  if (total <= budget) return indices;
  const ranked = [...indices].sort((a, b) => {
    const x = chunks[a], y = chunks[b];
    return Number(x.small) - Number(y.small) || (y.ps || 0) - (x.ps || 0) || a - b;
  });
  const chosen = [];
  let triangles = 0;
  for (const i of ranked) {
    const count = chunks[i].ni / 3;
    if (triangles + count > budget && chosen.length) continue;
    chosen.push(i);
    triangles += count;
  }
  return chosen.sort((a, b) => a - b);
}

export function completedParts(chunks, itemPart, loaded, nParts) {
  const seen = new Uint8Array(nParts), missing = new Uint8Array(nParts);
  chunks.forEach((c, k) => {
    for (let i = c.io; i < c.io + c.ic; i++) {
      const p = itemPart[i];
      seen[p] = 1;
      if (!loaded[k]) missing[p] = 1;
    }
  });
  const complete = new Uint8Array(nParts);
  for (let p = 0; p < nParts; p++) complete[p] = seen[p] ? !missing[p] : 1;
  return complete;
}
