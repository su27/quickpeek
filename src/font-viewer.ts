import { previewTask } from "./preview-task";
let nextFont = 0;
export async function renderFontViewer(url: string, name: string, host: HTMLElement, signal: AbortSignal) {
  const family = `QuickPeekFont${++nextFont}`;
  const face = new FontFace(family, `url(${JSON.stringify(url)})`);
  await previewTask(face.load(), signal);
  signal.throwIfAborted();
  const frame = document.createElement("section");
  frame.className = "font-viewer";
  const title = document.createElement("h1");
  title.textContent = name;
  const hint = document.createElement("p");
  hint.className = "font-viewer-hint";
  hint.textContent = "Aa · 字体样张（字体缺少的字符由系统字体补齐）";
  frame.append(title, hint);
  for (const size of [18, 24, 36, 60]) {
    const row = document.createElement("div");
    row.className = "font-viewer-row";
    const label = document.createElement("small"); label.textContent = `${size} px`;
    const sample = document.createElement("p");
    sample.style.fontFamily = `"${family}", sans-serif`;
    sample.style.fontSize = `${size}px`;
    sample.textContent = "The quick brown fox jumps over the lazy dog.\n天地玄黄，宇宙洪荒。0123456789 !? @#%&";
    row.append(label, sample); frame.append(row);
  }
  document.fonts.add(face);
  host.classList.add("is-font"); host.append(frame);
  return { destroy() { frame.remove(); document.fonts.delete(face); } };
}
