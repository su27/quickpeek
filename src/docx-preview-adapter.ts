import {
  parseAsync,
  renderDocument,
  type Options,
  type WordDocument,
} from "docx-preview";

type DocumentNode = {
  type?: string;
  cssStyle?: Record<string, string>;
  children?: DocumentNode[];
};

function normalizeTableCellTextDirections(node: DocumentNode | undefined): number {
  if (!node) return 0;

  let correctedCells = 0;
  const style = node.cssStyle;

  // ECMA-376 ST_TextDirection `lrTb` is normal horizontal text. docx-preview
  // 0.4.0 uniquely represents that parsed value as vertical-lr + no transform.
  // Normalize the parsed document model before any DOM nodes are generated.
  if (
    node.type === "cell" &&
    style?.["writing-mode"] === "vertical-lr" &&
    style.transform === "none"
  ) {
    style["writing-mode"] = "horizontal-tb";
    delete style.transform;
    correctedCells += 1;
  }

  for (const child of node.children ?? []) {
    correctedCells += normalizeTableCellTextDirections(child);
  }

  return correctedCells;
}

export async function renderDocx(
  data: Blob | ArrayBuffer | Uint8Array,
  bodyContainer: HTMLElement,
  styleContainer: HTMLElement = bodyContainer,
  options?: Partial<Options>,
): Promise<WordDocument> {
  const document = await parseAsync(data, options);
  const correctedCells = normalizeTableCellTextDirections(document.documentPart?.body);
  const nodes = await renderDocument(document, options);

  bodyContainer.replaceChildren();
  if (styleContainer !== bodyContainer) styleContainer.replaceChildren();

  for (const node of nodes) {
    const container = node.nodeName === "STYLE" ? styleContainer : bodyContainer;
    container.appendChild(node);
  }

  if (correctedCells > 0) {
    console.info(`Normalized horizontal text direction in ${correctedCells} table cells.`);
  }

  return document;
}
