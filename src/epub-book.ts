import JSZip from "jszip";

export const MAX_EPUB_BYTES = 64 * 1024 * 1024;
const MAX_XML = 2 * 1024 * 1024;
export type BookItem = { path: string; type: string; properties: string; title: string };
export type BookLink = { path: string; fragment: string };

// Reject excessive ZIP metadata before JSZip allocates a file object for every entry.
function validateContainer(bytes: ArrayBuffer): void {
  const data = new DataView(bytes);
  let end = -1;
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 65557); at--) {
    if (data.getUint32(at, true) === 0x06054b50 && at + 22 + data.getUint16(at + 20, true) === bytes.byteLength) { end = at; break; }
  }
  if (end < 0) throw new Error("EPUB is not a complete ZIP archive");
  const count = data.getUint16(end + 10, true), size = data.getUint32(end + 12, true), offset = data.getUint32(end + 16, true);
  if (data.getUint16(end + 4, true) || data.getUint16(end + 6, true) || count > 12000 || size === 0xffffffff || offset === 0xffffffff) throw new Error("EPUB has too many entries or uses an unsupported split or ZIP64 archive");
  if (offset + size > end) throw new Error("Invalid EPUB directory bounds");
  let found = 0;
  for (let at = offset; at < offset + size;) {
    if (at + 46 > offset + size || data.getUint32(at, true) !== 0x02014b50 || ++found > 12000) throw new Error("Invalid EPUB directory entry");
    at += 46 + data.getUint16(at + 28, true) + data.getUint16(at + 30, true) + data.getUint16(at + 32, true);
    if (at > offset + size) throw new Error("EPUB directory is out of bounds");
  }
  if (found !== count) throw new Error("EPUB directory entry count does not match");
}

/** Resolve container-relative URLs, never filesystem/remote URLs. */
export function bookLink(base: string, href: string): BookLink | null {
  try {
    const hash = href.indexOf("#");
    const fragment = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
    const path = decodeURIComponent((hash < 0 ? href : href.slice(0, hash)).split("?")[0]);
    if (/[\x00-\x20\\:]/.test(path.replaceAll(" ", "")) || path.startsWith("/")) return null;
    if (!path) return { path: base, fragment };
    const segments = base.split("/").slice(0, -1);
    for (const part of path.split("/")) {
      if (part === "..") { if (!segments.length) return null; segments.pop(); }
      else if (part && part !== ".") segments.push(part);
    }
    return segments.length ? { path: segments.join("/"), fragment } : null;
  } catch { return null; }
}

export function elements(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", name));
}

export function parseBookXml(text: string): Document {
  // External DTDs/entities are unnecessary for this semantic preview.
  if (/<!ENTITY\s/i.test(text) || /<!DOCTYPE[^>]*\[/i.test(text)) throw new Error("This book contains unsupported XML entity declarations");
  const clean = text.replace(/<!DOCTYPE[^>]*>/gi, "").replace(/&nbsp;/g, "&#160;");
  const doc = new DOMParser().parseFromString(clean, "application/xml");
  if (elements(doc, "parsererror").length) throw new Error("This chapter is damaged or is not valid XHTML");
  return doc;
}

/** Streaming inflate enforces the actual output limit, not only the untrusted ZIP header size. */
export function readBookEntry(zip: JSZip, path: string, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const entry = zip.file(path);
  if (!entry) return Promise.reject(new Error(`Missing file in book: ${path}`));
  const declaredSize = (entry as typeof entry & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (declaredSize !== undefined && declaredSize > limit) return Promise.reject(new Error("Chapter or image exceeds the preview size limit"));
  return new Promise((resolve, reject) => {
    // JSZip documents this API but its bundled typings omit it on JSZipObject.
    const stream = (entry as JSZip.JSZipObject & { internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array> }).internalStream("uint8array");
    let chunks: Uint8Array[] = [];
    let length = 0;
    let done = false;
    const stop = (error?: unknown): void => {
      if (done) return;
      done = true; stream.pause(); clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) { chunks = []; reject(error); }
      else {
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        chunks = []; resolve(bytes);
      }
    };
    const abort = (): void => stop(new DOMException("Preview cancelled", "AbortError"));
    const timer = setTimeout(() => stop(new Error("Reading the book timed out")), 8000);
    signal.addEventListener("abort", abort, { once: true });
    stream.on("data", chunk => {
      if (done) return;
      length += chunk.length;
      if (length > limit) stop(new Error("Chapter or image exceeds the preview size limit"));
      else chunks.push(chunk);
    });
    stream.on("error", error => stop(error)); stream.on("end", () => stop());
    if (signal.aborted) abort(); else stream.resume();
  });
}

export async function openEpub(bytes: ArrayBuffer, signal: AbortSignal) {
  if (bytes.byteLength > MAX_EPUB_BYTES) throw new Error("EPUB exceeds the 64 MB preview limit");
  signal.throwIfAborted();
  validateContainer(bytes);
  const zip = await JSZip.loadAsync(bytes, { createFolders: false });
  signal.throwIfAborted();
  if (Object.keys(zip.files).length > 12000) throw new Error("This book has too many files to preview");
  const readXml = async (path: string, readingSignal = signal): Promise<Document> => {
    const data = await readBookEntry(zip, path, MAX_XML, readingSignal);
    const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le" : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-8";
    return parseBookXml(new TextDecoder(encoding).decode(data));
  };
  try {
    const container = await readXml("META-INF/container.xml");
    const root = elements(container, "rootfile").find(item => item.getAttribute("media-type") === "application/oebps-package+xml") ?? elements(container, "rootfile")[0];
    const packagePath = bookLink("", root?.getAttribute("full-path") ?? "")?.path;
    if (!packagePath) throw new Error("EPUB package could not be found");
    const pkg = await readXml(packagePath);
    const manifest = new Map<string, BookItem>();
    for (const item of elements(pkg, "item")) {
      const path = bookLink(packagePath, item.getAttribute("href") ?? "")?.path;
      const id = item.getAttribute("id");
      if (path && id) manifest.set(id, { path, type: item.getAttribute("media-type") ?? "", properties: item.getAttribute("properties") ?? "", title: "" });
    }
    const chapters: BookItem[] = [];
    for (const ref of elements(pkg, "itemref")) {
      const item = manifest.get(ref.getAttribute("idref") ?? "");
      if (item && ["application/xhtml+xml", "text/html"].includes(item.type)) chapters.push({ ...item, title: `Chapter ${chapters.length + 1}` });
    }
    if (!chapters.length || chapters.length > 2000) throw new Error("EPUB has no readable chapters or too many chapters");
    const encrypted = new Set<string>();
    if (zip.file("META-INF/encryption.xml")) {
      const xml = await readXml("META-INF/encryption.xml");
      for (const item of elements(xml, "CipherReference")) {
        const path = bookLink("", item.getAttribute("URI") ?? "")?.path;
        if (path) encrypted.add(path);
      }
      if (chapters.some(item => encrypted.has(item.path))) throw new Error("DRM-protected EPUB files are not supported");
    }
    const toc: Array<{ title: string; target: BookLink }> = [];
    const nav = [...manifest.values()].find(item => item.properties.split(/\s+/).includes("nav"));
    const ncx = manifest.get(elements(pkg, "spine")[0]?.getAttribute("toc") ?? "") ?? [...manifest.values()].find(item => item.type === "application/x-dtbncx+xml");
    try {
      if (nav) {
        const xml = await readXml(nav.path);
        const navigation = elements(xml, "nav").find(el => (el.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? el.getAttribute("epub:type"))?.split(/\s+/).includes("toc"));
        for (const a of navigation ? elements(navigation, "a").slice(0, 4000) : []) {
          const target = bookLink(nav.path, a.getAttribute("href") ?? "");
          if (target) toc.push({ target, title: (a.textContent ?? "").trim().slice(0, 200) });
        }
      } else if (ncx) {
        const xml = await readXml(ncx.path);
        for (const point of elements(xml, "navPoint").slice(0, 4000)) {
          const target = bookLink(ncx.path, elements(point, "content")[0]?.getAttribute("src") ?? "");
          if (target) toc.push({ target, title: (elements(point, "text")[0]?.textContent ?? "").trim().slice(0, 200) });
        }
      }
    } catch { signal.throwIfAborted(); /* The spine still provides reliable reading order. */ }
    const titles = new Map<string, string>();
    for (const entry of toc) if (!titles.has(entry.target.path)) titles.set(entry.target.path, entry.title);
    for (const chapter of chapters) chapter.title = titles.get(chapter.path) || chapter.title;
    const metadata = elements(pkg, "metadata")[0];
    const title = metadata ? elements(metadata, "title")[0]?.textContent?.trim().slice(0, 300) : "";
    const author = metadata ? elements(metadata, "creator").map(el => el.textContent?.trim()).filter(Boolean).join(" / ").slice(0, 300) : "";
    const images = new Map([...manifest.values()].filter(item => /^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(item.type) && !encrypted.has(item.path)).map(item => [item.path, item]));
    return { title: title || "Untitled book", author, chapters, images, toc, readXml,
      readImage: (path: string, readingSignal: AbortSignal) => readBookEntry(zip, path, 8 * 1024 * 1024, readingSignal),
      dispose() { zip.files = {}; manifest.clear(); images.clear(); toc.length = 0; chapters.length = 0; },
    };
  } catch (error) { zip.files = {}; throw error; }
}

export type EpubBook = Awaited<ReturnType<typeof openEpub>>;
