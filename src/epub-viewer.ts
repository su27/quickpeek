import { bookLink, elements, openEpub, type BookLink, type EpubBook } from "./epub-book";
import type { RenderContext } from "./document-formats";

const SAFE_TAGS = new Set("p div section article aside header footer h1 h2 h3 h4 h5 h6 span strong b em i u s small sup sub blockquote pre code ul ol li dl dt dd table thead tbody tfoot tr td th caption hr br figure figcaption ruby rt rp a".split(" "));
const DROP_TAGS = new Set("script style link meta base iframe frame object embed applet form input button select textarea audio video source canvas noscript".split(" "));

// Inspect dimensions before handing compressed images to the browser decoder.
function rasterPixels(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 24 && view.getUint32(0) === 0x89504e47) return view.getUint32(16) * view.getUint32(20);
  if (data.length >= 10 && String.fromCharCode(...data.slice(0, 3)) === "GIF") return view.getUint16(6, true) * view.getUint16(8, true);
  if (data.length >= 26 && view.getUint16(0) === 0x424d) return Math.abs(view.getInt32(18, true) * view.getInt32(22, true));
  if (data[0] === 255 && data[1] === 216) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset++] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 7 >= data.length) break;
      const length = view.getUint16(offset);
      if (length < 2) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return view.getUint16(offset + 3) * view.getUint16(offset + 5);
      offset += length;
    }
  }
  if (data.length >= 30 && String.fromCharCode(...data.slice(0,4)) === "RIFF" && String.fromCharCode(...data.slice(8,12)) === "WEBP") {
    const kind = String.fromCharCode(...data.slice(12,16));
    if (kind === "VP8X") return (1 + data[24] + (data[25] << 8) + (data[26] << 16)) * (1 + data[27] + (data[28] << 8) + (data[29] << 16));
    if (kind === "VP8 ") return (view.getUint16(26,true) & 0x3fff) * (view.getUint16(28,true) & 0x3fff);
    if (kind === "VP8L") return (1 + ((data[21] | data[22] << 8) & 0x3fff)) * (1 + ((data[22] >> 6 | data[23] << 2 | data[24] << 10) & 0x3fff));
  }
  return 0; // Unknown image codecs get an alt-text placeholder, not unbounded decoding.
}

async function chapterContent(book: EpubBook, index: number, signal: AbortSignal) {
  const chapter = book.chapters[index];
  const xml = await book.readXml(chapter.path, signal);
  const body = elements(xml, "body")[0];
  if (!body) throw new Error("此章节没有可阅读的正文");
  const article = document.createElement("article"); article.className = "epub-prose";
  const anchors = new Map<string, HTMLElement>();
  const urls: string[] = [];
  const images: Array<{ image: HTMLImageElement; path: string }> = [];
  let nodeCount = 0;
  const copy = (source: Node, target: Node, depth: number): void => {
    if (++nodeCount > 35000 || depth > 80) throw new Error("章节结构超过轻量预览上限");
    if (source.nodeType === Node.TEXT_NODE) { target.appendChild(document.createTextNode(source.textContent ?? "")); return; }
    if (!(source instanceof Element)) return;
    const tag = source.localName.toLowerCase();
    if (DROP_TAGS.has(tag)) return;
    if (tag === "img" || tag === "image") {
      const image = document.createElement("img");
      image.alt = source.getAttribute("alt") || "书内插图";
      image.loading = "lazy"; image.decoding = "async";
      const link = bookLink(chapter.path, source.getAttribute("src") ?? source.getAttribute("href") ?? source.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "");
      if (link && book.images.has(link.path) && images.length < 32) images.push({ image, path: link.path });
      target.appendChild(image); return;
    }
    // Reconstruct only semantic HTML; no publisher CSS, event handlers, remote resources, or live source nodes.
    const result = SAFE_TAGS.has(tag) ? document.createElement(tag) : document.createElement("span");
    const id = source.getAttribute("id"); if (id) { anchors.set(id, result); result.style.scrollMarginTop = "72px"; }
    const dir = source.getAttribute("dir"); if (dir === "ltr" || dir === "rtl") result.dir = dir;
    if (tag === "td" || tag === "th") for (const name of ["colspan", "rowspan"]) {
      const value = Number(source.getAttribute(name)); if (value > 0 && value <= 100) result.setAttribute(name, String(Math.floor(value)));
    }
    if (tag === "a") {
      const href = source.getAttribute("href") ?? "";
      const link = bookLink(chapter.path, href);
      if (link && book.chapters.some(item => item.path === link.path)) {
        result.setAttribute("href", "#"); result.dataset.bookPath = link.path; result.dataset.bookFragment = link.fragment;
      } else if (href) result.title = "预览中不打开外部链接";
    }
    target.appendChild(result);
    for (const child of source.childNodes) copy(child, result, depth + 1);
  };
  try {
    for (const child of body.childNodes) copy(child, article, 0);
    let totalBytes = 0; let totalPixels = 0;
    const loaded = new Map<string, string>();
    for (const item of images) {
      signal.throwIfAborted();
      if (loaded.has(item.path)) { item.image.src = loaded.get(item.path)!; continue; }
      try {
        const bytes = await book.readImage(item.path, signal);
        const pixels = rasterPixels(bytes);
        if (!pixels || pixels > 16_000_000 || totalPixels + pixels > 32_000_000 || totalBytes + bytes.length > 24 * 1024 * 1024) continue;
        totalBytes += bytes.length; totalPixels += pixels;
        const url = URL.createObjectURL(new Blob([bytes], { type: book.images.get(item.path)!.type }));
        loaded.set(item.path, url); urls.push(url); item.image.src = url;
      } catch { signal.throwIfAborted(); /* A damaged illustration should not hide readable text. */ }
    }
    for (const image of article.querySelectorAll("img:not([src])")) {
      const missing = document.createElement("span"); missing.className = "epub-image-note";
      missing.textContent = `[${image.getAttribute("alt")} · 无法预览此插图]`; image.replaceWith(missing);
    }
    const heading = article.querySelector("h1,h2,h3")?.textContent?.trim().slice(0,200);
    return { article, anchors, heading, destroy() { article.remove(); for (const url of urls) URL.revokeObjectURL(url); anchors.clear(); } };
  } catch (error) { for (const url of urls) URL.revokeObjectURL(url); throw error; }
}

export async function renderEpubViewer(bytes: ArrayBuffer, context: RenderContext) {
  const { host, signal, viewport } = context;
  let book: EpubBook | null = await openEpub(bytes, signal);
  const frame = document.createElement("section"); frame.className = "epub-viewer";
  const toolbar = document.createElement("div"); toolbar.className = "epub-toolbar";
  const menu = document.createElement("details"); menu.className = "epub-menu";
  const toggle = document.createElement("summary"); toggle.textContent = "目录";
  const list = document.createElement("nav"); list.setAttribute("aria-label", "章节目录");
  menu.append(toggle, list);
  const position = document.createElement("span"); position.className = "epub-position";
  const previous = document.createElement("button"); previous.textContent = "上一章";
  const next = document.createElement("button"); next.textContent = "下一章";
  toolbar.append(menu, position, previous, next);
  const heading = document.createElement("header"); heading.className = "epub-book-heading";
  const kicker = document.createElement("span"); kicker.textContent = "电子书";
  const title = document.createElement("h1"); title.textContent = book.title;
  const author = document.createElement("p"); author.textContent = book.author;
  heading.append(kicker, title); if (book.author) heading.append(author);
  const content = document.createElement("div");
  const errorNotice = document.createElement("p"); errorNotice.className = "epub-error"; errorNotice.hidden = true; errorNotice.setAttribute("role", "status");
  frame.append(toolbar, heading, errorNotice, content);
  let page = 0; const count = book.chapters.length;
  let sequence = 0; let pending: AbortController | null = null;
  let current: Awaited<ReturnType<typeof chapterContent>> | null = null;
  let disposed = false;
  const buttons: HTMLButtonElement[] = [];
  const update = (): void => {
    heading.hidden = page > 0;
    position.textContent = `${page + 1} / ${count} 章`;
    previous.disabled = page === 0; next.disabled = page + 1 >= count;
    for (const [index, button] of buttons.entries()) button.setAttribute("aria-current", index === page ? "true" : "false");
    if (context.isActive()) context.setPageLabel(`${page + 1}/${count} 章`);
  };
  const jump = (fragment: string): void => {
    if (fragment) current?.anchors.get(fragment)?.scrollIntoView({ block: "start" });
    else viewport.scrollTop = 0;
  };
  const show = async (index: number, fragment = ""): Promise<void> => {
    if (!book || disposed || index < 0 || index >= count) return;
    const request = ++sequence; pending?.abort();
    const cancellation = new AbortController(); pending = cancellation;
    errorNotice.hidden = true;
    try {
      const replacement = await chapterContent(book, index, cancellation.signal);
      if (disposed || request !== sequence) { replacement.destroy(); return; }
      if (context.isActive()) context.contentChanged?.();
      current?.destroy(); current = replacement; page = index;
      if (replacement.heading && /^第 \d+ 节$/.test(book.chapters[index].title)) {
        book.chapters[index].title = replacement.heading; buttons[index].textContent = replacement.heading;
      }
      content.replaceChildren(replacement.article); menu.open = false; update(); if (context.isActive()) jump(fragment);
    } catch (error) {
      if (disposed || cancellation.signal.aborted) return;
      if (!current) throw error;
      errorNotice.textContent = error instanceof Error ? error.message : "章节打开失败"; errorNotice.hidden = false;
    } finally { if (pending === cancellation) pending = null; }
  };
  const navigate = (index: number, fragment = ""): void => { void show(index, fragment); };
  for (const [index, chapter] of book.chapters.entries()) {
    const button = document.createElement("button"); button.textContent = chapter.title;
    button.onclick = () => navigate(index); list.append(button); buttons.push(button);
  }
  previous.onclick = () => navigate(page - 1); next.onclick = () => navigate(page + 1);
  const onClick = (event: MouseEvent): void => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-book-path]") : null;
    if (!anchor || !book) return;
    event.preventDefault();
    const target: BookLink = { path: anchor.dataset.bookPath!, fragment: anchor.dataset.bookFragment ?? "" };
    const index = book.chapters.findIndex(item => item.path === target.path);
    if (index === page) jump(target.fragment); else navigate(index, target.fragment);
  };
  content.addEventListener("click", onClick);
  const destroy = (): void => {
    disposed = true; ++sequence; pending?.abort(); pending = null;
    signal.removeEventListener("abort", destroy); content.removeEventListener("click", onClick);
    current?.destroy(); current = null; book?.dispose(); book = null; frame.remove();
  };
  signal.addEventListener("abort", destroy, { once: true });
  try {
    signal.throwIfAborted(); await show(0); signal.throwIfAborted();
    host.classList.add("is-epub"); host.append(frame);
  } catch (error) { destroy(); throw error; }
  return { get label() { return `${page + 1}/${count} 章`; }, destroy };
}
