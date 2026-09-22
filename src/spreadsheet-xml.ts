import { SaxesParser } from "saxes";

const spreadsheetNamespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relationshipNamespace = "http://schemas.openxmlformats.org/package/2006/relationships";
const escapedText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapedAttribute = (value: string) => escapedText(value).replaceAll('"', "&quot;")
  .replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("\t", "&#9;");

function repairSpreadsheetQuirks(xml: string, partName: string): string {
  const normalizedPart = partName.replaceAll("\\", "/");
  let repaired = xml;
  if (normalizedPart === "xl/sharedStrings.xml") {
    // Excel can emit an empty plain-text run before a rich-text run. The
    // preview parser treats that empty run as a string and then tries to add
    // richText metadata to it, so remove only the empty run itself.
    repaired = repaired.replace(/<t(?:\s[^>]*)?>\s*<\/t>(?=\s*<r\b)/g, "");
  } else if (normalizedPart === "xl/styles.xml") {
    // Empty color elements carry no formatting information and are rejected
    // by some SpreadsheetML parsers. Keep the surrounding fill intact.
    repaired = repaired.replace(/<(?:fgColor|bgColor)>\s*<\/(?:fgColor|bgColor)>/g, "");
  }
  return repaired;
}

/** ExcelJS expects unprefixed SpreadsheetML element names. Canonicalize only
 * those elements, preserving namespace identity, attributes and cell content. */
export function normalizeSpreadsheetXml(xml: string, partName = ""): string {
  const relationships = partName.endsWith(".rels");
  const repaired = repairSpreadsheetQuirks(xml, partName);
  if (!(relationships && /\bTarget\s*=\s*["']\//.test(xml)) &&
    !/xmlns:[\w.-]+\s*=\s*["']http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main["']/.test(xml)) return repaired;
  const parser = new SaxesParser({ xmlns: true });
  const output: string[] = [];
  const stack: Array<{ name: string; defaultNamespace: string; empty: boolean }> = [];
  parser.on("opentag", tag => {
    const name = tag.uri === spreadsheetNamespace ? tag.local : tag.name;
    const attributes = new Map(Object.values(tag.attributes).map(attr => [attr.name, attr.value]));
    // ExcelJS resolves table/drawing parts relative to their owning worksheet,
    // but some producers use equally valid package-absolute OPC targets.
    const target = attributes.get("Target");
    if (relationships && tag.uri === relationshipNamespace && tag.local === "Relationship" &&
      attributes.get("TargetMode") !== "External" && target?.startsWith("/") && !target.startsWith("//")) {
      const base = partName.replace(/(^|\/)_rels\/[^/]*\.rels$/, "$1").split("/").filter(Boolean);
      const destination = target.slice(1).split("/");
      while (base.length && destination.length && base[0] === destination[0]) { base.shift(); destination.shift(); }
      attributes.set("Target", "../".repeat(base.length) + destination.join("/"));
    }
    let defaultNamespace = attributes.get("xmlns") ?? stack.at(-1)?.defaultNamespace ?? "";
    if (!name.includes(":") && tag.uri !== defaultNamespace) {
      attributes.set("xmlns", tag.uri);
      defaultNamespace = tag.uri;
    }
    output.push(`<${name}`);
    for (const [key, value] of attributes) output.push(` ${key}="${escapedAttribute(value)}"`);
    output.push(tag.isSelfClosing ? "/>" : ">");
    stack.push({ name, defaultNamespace, empty: tag.isSelfClosing });
  });
  parser.on("closetag", () => {
    const tag = stack.pop()!;
    if (!tag.empty) output.push(`</${tag.name}>`);
  });
  parser.on("text", text => output.push(escapedText(text)));
  parser.on("cdata", text => output.push(`<![CDATA[${text}]]>`));
  parser.on("comment", text => output.push(`<!--${text}-->`));
  parser.on("processinginstruction", ({ target, body }) => output.push(`<?${target} ${body}?>`));
  parser.on("doctype", () => { throw new Error("Office XML must not contain a document type declaration"); });
  parser.write(repaired).close();
  return output.join("");
}
