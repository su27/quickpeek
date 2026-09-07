import type { CellObject, ColInfo, RowInfo, WorkBook, WorkSheet } from "xlsx";

export type LegacyCellFill = {
  color: string;
  column: number;
  row: number;
};

export type LegacySheetLayout = {
  columns: Array<number | null>;
  fills: LegacyCellFill[];
  name: string;
  rows: Array<number | null>;
};

export type PreparedLegacyWorkbook = {
  layout: LegacySheetLayout[];
  workbook: ArrayBuffer;
};

type LegacyCellStyle = {
  bgColor?: { rgb?: unknown };
  fgColor?: { rgb?: unknown };
  patternType?: unknown;
};

type CfbEntry = {
  content?: ArrayLike<number>;
  name?: string;
};

type WorkbookWithBinaryFiles = WorkBook & {
  cfb?: { FileIndex?: CfbEntry[] };
  Themes?: {
    themeElements?: {
      clrScheme?: Array<{ name?: string; rgb?: string }>;
    };
  };
};

type ExtendedCellFill = LegacyCellFill;

const biff8SingleCellRecords = new Set([
  0x0006, // Formula
  0x00d6, // RString
  0x00fd, // LabelSst
  0x0201, // Blank
  0x0203, // Number
  0x0204, // Label
  0x0205, // BoolErr
  0x027e, // RK
]);

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function columnWidth(column: ColInfo | undefined): number | null {
  if (!column) return null;
  if (column.hidden) return 0.1;
  const pixels = finitePositive(column.wpx);
  if (pixels !== null) return pixels;

  // SheetJS normally supplies wpx for BIFF files. Keep a conservative
  // fallback for unusual producers that only write the character width.
  const characters = finitePositive(column.wch ?? column.width);
  return characters === null ? null : Math.round(characters * 7 + 5);
}

function rowHeight(row: RowInfo | undefined): number | null {
  if (!row) return null;
  if (row.hidden) return 0.1;
  return finitePositive(row.hpx) ?? finitePositive(row.hpt);
}

function normalizedFillColor(cell: CellObject | undefined): string | null {
  const style = cell?.s as LegacyCellStyle | undefined;
  if (!style || style.patternType !== "solid") return null;

  const source = style.fgColor?.rgb ?? style.bgColor?.rgb;
  if (typeof source !== "string") return null;
  const hex = source.replace(/^#/, "").toUpperCase();
  const rgb = hex.length === 8 ? hex.slice(2) : hex;
  if (!/^[0-9A-F]{6}$/.test(rgb) || rgb === "FFFFFF") return null;
  return `#${rgb}`;
}

function workbookBinaryStream(workbook: WorkbookWithBinaryFiles): Uint8Array | null {
  const entry = workbook.cfb?.FileIndex?.find((candidate) =>
    candidate.name === "Workbook" || candidate.name === "Book"
  );
  if (!entry?.content) return null;
  return entry.content instanceof Uint8Array
    ? entry.content
    : Uint8Array.from(entry.content);
}

function recordIterator(
  stream: Uint8Array,
  callback: (recordType: number, payloadOffset: number, length: number, recordOffset: number) => void,
): void {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let offset = 0;
  while (offset + 4 <= stream.byteLength) {
    const recordType = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const payloadOffset = offset + 4;
    if (payloadOffset + length > stream.byteLength) break;
    callback(recordType, payloadOffset, length, offset);
    offset = payloadOffset + length;
  }
}

function themeColors(workbook: WorkbookWithBinaryFiles): Array<string | null> {
  return (workbook.Themes?.themeElements?.clrScheme ?? []).map((color) => {
    const rgb = color.rgb?.toUpperCase();
    return rgb && /^[0-9A-F]{6}$/.test(rgb) ? `#${rgb}` : null;
  });
}

function tintedColor(color: string, rawTint: number): string {
  if (rawTint === 0) return color;
  const tint = rawTint < 0 ? rawTint / 32768 : rawTint / 32767;
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  const adjusted = channels.map((channel) => Math.round(
    tint < 0 ? channel * (1 + tint) : channel + (255 - channel) * tint,
  ));
  return `#${adjusted.map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function extendedColor(
  view: DataView,
  offset: number,
  end: number,
  themes: Array<string | null>,
): string | null {
  if (offset + 16 > end) return null;
  const colorType = view.getUint16(offset, true);
  const tint = view.getInt16(offset + 2, true);
  let color: string | null = null;

  if (colorType === 2) {
    color = `#${[4, 5, 6]
      .map((index) => view.getUint8(offset + index).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
  } else if (colorType === 3) {
    color = themes[view.getUint32(offset + 4, true)] ?? null;
  }

  return color ? tintedColor(color, tint) : null;
}

function extendedFillColors(
  stream: Uint8Array,
  themes: Array<string | null>,
): Map<number, string> {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const fills = new Map<number, string>();

  recordIterator(stream, (recordType, payloadOffset, length) => {
    if (recordType !== 0x087d || length < 20) return; // XFExt
    const recordEnd = payloadOffset + length;
    const styleIndex = view.getUint16(payloadOffset + 14, true);
    const propertyCount = view.getUint16(payloadOffset + 18, true);
    let offset = payloadOffset + 20;

    for (let property = 0; property < propertyCount && offset + 4 <= recordEnd; property += 1) {
      const propertyType = view.getUint16(offset, true);
      const propertyLength = view.getUint16(offset + 2, true);
      if (propertyLength < 4 || offset + propertyLength > recordEnd) break;
      if (propertyType === 0x04) {
        const color = extendedColor(view, offset + 4, offset + propertyLength, themes);
        if (color) fills.set(styleIndex, color);
      }
      offset += propertyLength;
    }
  });

  return fills;
}

function extractExtendedCellFills(
  workbook: WorkbookWithBinaryFiles,
  sheetCount: number,
): ExtendedCellFill[][] {
  const stream = workbookBinaryStream(workbook);
  const result = Array.from({ length: sheetCount }, () => [] as ExtendedCellFill[]);
  if (!stream) return result;

  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const styleColors = extendedFillColors(stream, themeColors(workbook));
  if (styleColors.size === 0) return result;

  const sheetOffsets = new Map<number, number>();
  let sheetIndex = 0;
  recordIterator(stream, (recordType, payloadOffset, length) => {
    if (recordType === 0x0085 && length >= 4) { // BoundSheet8
      sheetOffsets.set(view.getUint32(payloadOffset, true), sheetIndex);
      sheetIndex += 1;
    }
  });

  let activeSheet = -1;
  const addFill = (row: number, column: number, style: number) => {
    if (activeSheet < 0 || activeSheet >= result.length) return;
    const color = styleColors.get(style);
    if (color) result[activeSheet].push({ color, column, row });
  };

  recordIterator(stream, (recordType, payloadOffset, length, recordOffset) => {
    const nextSheet = sheetOffsets.get(recordOffset);
    if (nextSheet !== undefined) activeSheet = nextSheet;
    if (activeSheet < 0) return;

    if (biff8SingleCellRecords.has(recordType) && length >= 6) {
      addFill(
        view.getUint16(payloadOffset, true),
        view.getUint16(payloadOffset + 2, true),
        view.getUint16(payloadOffset + 4, true),
      );
      return;
    }

    if (recordType === 0x00be && length >= 8) { // MulBlank
      const row = view.getUint16(payloadOffset, true);
      const firstColumn = view.getUint16(payloadOffset + 2, true);
      const lastColumn = view.getUint16(payloadOffset + length - 2, true);
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const styleOffset = payloadOffset + 4 + (column - firstColumn) * 2;
        if (styleOffset + 2 > payloadOffset + length - 2) break;
        addFill(row, column, view.getUint16(styleOffset, true));
      }
      return;
    }

    if (recordType === 0x00bd && length >= 12) { // MulRK
      const row = view.getUint16(payloadOffset, true);
      const firstColumn = view.getUint16(payloadOffset + 2, true);
      const lastColumn = view.getUint16(payloadOffset + length - 2, true);
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const styleOffset = payloadOffset + 4 + (column - firstColumn) * 6;
        if (styleOffset + 2 > payloadOffset + length - 2) break;
        addFill(row, column, view.getUint16(styleOffset, true));
      }
    }
  });

  return result;
}

function extractSheetLayout(
  name: string,
  sheet: WorkSheet,
  decodeCell: (address: string) => { c: number; r: number },
  extendedFills: ExtendedCellFill[],
): LegacySheetLayout {
  const fillMap = new Map<string, LegacyCellFill>();
  for (const [address, value] of Object.entries(sheet)) {
    if (address.startsWith("!")) continue;
    const color = normalizedFillColor(value as CellObject);
    if (!color) continue;
    const position = decodeCell(address);
    fillMap.set(`${position.r}:${position.c}`, { color, column: position.c, row: position.r });
  }
  for (const fill of extendedFills) {
    const key = `${fill.row}:${fill.column}`;
    if (fill.color.toUpperCase() === "#FFFFFF") fillMap.delete(key);
    else fillMap.set(key, fill);
  }

  return {
    columns: (sheet["!cols"] ?? []).map(columnWidth),
    fills: Array.from(fillMap.values()),
    name,
    rows: (sheet["!rows"] ?? []).map(rowHeight),
  };
}

/**
 * @js-preview/excel converts BIFF/XLS through an embedded SheetJS build without
 * requesting style metadata. Parse and convert the legacy workbook once here
 * so column widths and row heights survive, and retain the small subset of
 * fills that SheetJS Community Edition exposes for us to restore afterwards.
 */
export async function prepareLegacyWorkbook(input: ArrayBuffer): Promise<PreparedLegacyWorkbook> {
  const { read, utils, write } = await import("xlsx");
  const source = read(input, {
    cellFormula: true,
    cellNF: true,
    cellStyles: true,
    bookFiles: true,
    type: "array",
  });
  const workbookWithBinaryFiles = source as WorkbookWithBinaryFiles;
  const extendedFills = extractExtendedCellFills(workbookWithBinaryFiles, source.SheetNames.length);
  const layout = source.SheetNames.map((name, index) =>
    extractSheetLayout(name, source.Sheets[name], utils.decode_cell, extendedFills[index] ?? [])
  );
  const converted = write(source, {
    bookType: "xlsx",
    cellStyles: true,
    compression: true,
    type: "array",
  });

  return {
    layout,
    workbook: converted as ArrayBuffer,
  };
}
