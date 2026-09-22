import JSZip from "jszip";
import { readBookEntry } from "./epub-book";
import { validateOfficeDirectory } from "./office-limits";
import { normalizeSpreadsheetXml } from "./spreadsheet-xml";

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const input = event.data;
    validateOfficeDirectory(input);
    const zip = await JSZip.loadAsync(input, { createFolders: false });
    // Spreadsheet cells contain several XML elements each; the renderer has a
    // separate 200,000-cell budget. Keep the smaller document budget for Word
    // and PowerPoint while allowing workbooks within that cell budget through.
    const isWorkbook = Boolean(zip.file("xl/workbook.xml"));
    const maximumTags = isWorkbook ? 2_000_000 : 200_000;
    const output = new JSZip();
    const signal = new AbortController().signal;
    let total = 0;
    let nodes = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const xml = /\.(xml|rels)$/i.test(entry.name);
      const bytes = await readBookEntry(zip, entry.name, Math.min(xml ? 8 * 1024 * 1024 : 32 * 1024 * 1024, 64 * 1024 * 1024 - total), signal);
      total += bytes.byteLength;
      if (xml) {
        for (const byte of bytes) if (byte === 60 && ++nodes > maximumTags) throw new Error("Office document is too complex to preview");
      }
      if (xml && isWorkbook) {
        const text = new TextDecoder().decode(bytes);
        const normalized = normalizeSpreadsheetXml(text, entry.name);
        output.file(entry.name, normalized === text ? bytes : normalized);
      } else output.file(entry.name, bytes);
    }
    // Renderers consume a stored archive: no second expensive inflate on the UI
    // thread, and actual decompressed sizes have already been checked.
    const bytes = await output.generateAsync({ type: "arraybuffer", compression: "STORE" });
    (self as unknown as Worker).postMessage({ result: bytes }, [bytes]);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
