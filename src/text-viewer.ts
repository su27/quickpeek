import hljs from "highlight.js/lib/core";
import autohotkey from "highlight.js/lib/languages/autohotkey";
import awk from "highlight.js/lib/languages/awk";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import clojure from "highlight.js/lib/languages/clojure";
import cmake from "highlight.js/lib/languages/cmake";
import coffeescript from "highlight.js/lib/languages/coffeescript";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import delphi from "highlight.js/lib/languages/delphi";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import erlang from "highlight.js/lib/languages/erlang";
import elm from "highlight.js/lib/languages/elm";
import fsharp from "highlight.js/lib/languages/fsharp";
import go from "highlight.js/lib/languages/go";
import gradle from "highlight.js/lib/languages/gradle";
import graphql from "highlight.js/lib/languages/graphql";
import groovy from "highlight.js/lib/languages/groovy";
import haskell from "highlight.js/lib/languages/haskell";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import julia from "highlight.js/lib/languages/julia";
import kotlin from "highlight.js/lib/languages/kotlin";
import latex from "highlight.js/lib/languages/latex";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nim from "highlight.js/lib/languages/nim";
import objectivec from "highlight.js/lib/languages/objectivec";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import properties from "highlight.js/lib/languages/properties";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import vbnet from "highlight.js/lib/languages/vbnet";
import x86asm from "highlight.js/lib/languages/x86asm";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_HIGHLIGHT_BYTES = 2 * 1024 * 1024;

const languageByExtension: Record<string, string> = {
  ahk: "autohotkey",
  asm: "x86asm",
  astro: "xml",
  awk: "awk",
  bash: "bash",
  bib: "latex",
  c: "c",
  cc: "cpp",
  cfg: "ini",
  cjs: "javascript",
  clj: "clojure",
  cljs: "clojure",
  cmake: "cmake",
  coffee: "coffeescript",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dart: "dart",
  diff: "diff",
  dockerfile: "dockerfile",
  dockerignore: "properties",
  editorconfig: "ini",
  elm: "elm",
  erl: "erlang",
  ex: "elixir",
  exs: "elixir",
  fish: "bash",
  fs: "fsharp",
  fsx: "fsharp",
  gitattributes: "properties",
  gitignore: "properties",
  gitmodules: "ini",
  go: "go",
  gql: "graphql",
  gradle: "gradle",
  graphql: "graphql",
  groovy: "groovy",
  h: "c",
  handlebars: "xml",
  hbs: "xml",
  hpp: "cpp",
  hs: "haskell",
  htm: "xml",
  html: "xml",
  ini: "ini",
  java: "java",
  jl: "julia",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsonl: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lhs: "haskell",
  lua: "lua",
  m: "objectivec",
  makefile: "makefile",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mm: "objectivec",
  nim: "nim",
  njk: "xml",
  npmrc: "properties",
  pas: "delphi",
  patch: "diff",
  php: "php",
  pl: "perl",
  pp: "delphi",
  ps1: "powershell",
  properties: "properties",
  prop: "properties",
  proto: "protobuf",
  py: "python",
  pyw: "python",
  r: "r",
  rb: "ruby",
  reg: "ini",
  rs: "rust",
  s: "x86asm",
  scala: "scala",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svelte: "xml",
  swift: "swift",
  tex: "latex",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  vb: "vbnet",
  vbs: "vbnet",
  vue: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

[
  ["autohotkey", autohotkey],
  ["awk", awk],
  ["bash", bash],
  ["c", c],
  ["clojure", clojure],
  ["cmake", cmake],
  ["coffeescript", coffeescript],
  ["cpp", cpp],
  ["csharp", csharp],
  ["css", css],
  ["dart", dart],
  ["delphi", delphi],
  ["diff", diff],
  ["dockerfile", dockerfile],
  ["elixir", elixir],
  ["elm", elm],
  ["erlang", erlang],
  ["fsharp", fsharp],
  ["go", go],
  ["gradle", gradle],
  ["graphql", graphql],
  ["groovy", groovy],
  ["haskell", haskell],
  ["ini", ini],
  ["java", java],
  ["javascript", javascript],
  ["json", json],
  ["julia", julia],
  ["kotlin", kotlin],
  ["latex", latex],
  ["less", less],
  ["lua", lua],
  ["makefile", makefile],
  ["markdown", markdown],
  ["nim", nim],
  ["objectivec", objectivec],
  ["perl", perl],
  ["php", php],
  ["powershell", powershell],
  ["properties", properties],
  ["protobuf", protobuf],
  ["python", python],
  ["r", r],
  ["ruby", ruby],
  ["rust", rust],
  ["scala", scala],
  ["scss", scss],
  ["sql", sql],
  ["swift", swift],
  ["typescript", typescript],
  ["vbnet", vbnet],
  ["x86asm", x86asm],
  ["xml", xml],
  ["yaml", yaml],
].forEach(([name, grammar]) => hljs.registerLanguage(name as string, grammar as typeof bash));

export type TextViewerResult = {
  readonly encoding: string;
  readonly highlighted: boolean;
  readonly lineCount: number;
  readonly truncated: boolean;
};

type TableAlignment = "center" | "left" | "right" | null;

type InlineMatch = {
  content: string;
  index: number;
  kind: "code" | "delete" | "emphasis" | "link" | "strong";
  length: number;
  target?: string;
};

function extensionOf(name: string): string {
  return name.toLocaleLowerCase().split(".").pop() ?? "";
}

function languageForFile(name: string, extension: string): string | undefined {
  const lowerName = name.toLocaleLowerCase();
  if (lowerName === "cmakelists.txt") return "cmake";
  if (lowerName.startsWith(".env")) return "properties";
  if (lowerName === "cargo.lock") return "ini";
  if (lowerName === "makefile" || lowerName === "gemfile" || lowerName === "rakefile") {
    return lowerName === "makefile" ? "makefile" : "ruby";
  }
  if (lowerName === "dockerfile" || lowerName.startsWith("dockerfile.")) return "dockerfile";
  return languageByExtension[extension];
}

const SUBTITLE_EXTENSIONS = new Set(["ass", "lrc", "srt", "ssa", "vtt"]);

function appendSubtitleToken(parent: HTMLElement, value: string, className: string): void {
  const token = document.createElement("span");
  token.className = className;
  token.textContent = value;
  parent.append(token);
}

function appendSubtitleLine(parent: HTMLElement, line: string, extension: string): void {
  if (/^\s*\d+\s*$/.test(line) && (extension === "srt" || extension === "vtt")) {
    appendSubtitleToken(parent, line, "subtitle-index");
    return;
  }
  if (/^WEBVTT(?:\s|$)/i.test(line) || /^\[[^\]]+\]\s*$/.test(line)) {
    appendSubtitleToken(parent, line, "subtitle-section");
    return;
  }

  const tokenPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{2,3}|\d{1,2}:\d{2}[.:]\d{2,3}|-->|\{\\[^}]+\}|\[[^\]\r\n]+\]|^(?:Dialogue|Comment|Style|Format|Title|ScriptType):)/gi;
  let cursor = 0;
  for (const match of line.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parent.append(document.createTextNode(line.slice(cursor, index)));
    const value = match[0];
    const className = value === "-->"
      ? "subtitle-arrow"
      : /^\d/.test(value) || /^\[\d/.test(value)
        ? "subtitle-time"
        : value.startsWith("{\\")
          ? "subtitle-tag"
          : "subtitle-label";
    appendSubtitleToken(parent, value, className);
    cursor = index + value.length;
  }
  if (cursor < line.length) parent.append(document.createTextNode(line.slice(cursor)));
}

function renderSubtitle(text: string, extension: string): HTMLPreElement {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = `subtitle-code language-${extension}`;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((line, index) => {
    appendSubtitleLine(code, line, extension);
    if (index < lines.length - 1) code.append(document.createTextNode("\n"));
  });
  pre.append(code);
  return pre;
}

function looksLikeUtf16(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  const length = Math.min(bytes.length, 4096);
  if (length < 4) return null;

  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index % 2 === 0) evenZeros += 1;
    else oddZeros += 1;
  }

  const pairs = Math.floor(length / 2);
  if (oddZeros > pairs * 0.3 && evenZeros < pairs * 0.05) return "utf-16le";
  if (evenZeros > pairs * 0.3 && oddZeros < pairs * 0.05) return "utf-16be";
  return null;
}

function decodeText(bytes: Uint8Array): { encoding: string; text: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: "UTF-16 LE", text: new TextDecoder("utf-16le").decode(bytes) };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: "UTF-16 BE", text: new TextDecoder("utf-16be").decode(bytes) };
  }

  const utf16 = looksLikeUtf16(bytes);
  if (utf16) {
    return {
      encoding: utf16 === "utf-16le" ? "UTF-16 LE" : "UTF-16 BE",
      text: new TextDecoder(utf16).decode(bytes),
    };
  }

  try {
    return {
      encoding: "UTF-8",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return {
      encoding: "GB18030",
      text: new TextDecoder("gb18030").decode(bytes),
    };
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function safeLinkTarget(target: string): string | null {
  if (target.startsWith("#")) return target;
  try {
    const parsed = new URL(target);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? target : null;
  } catch {
    return null;
  }
}

function nextInlineMatch(text: string): InlineMatch | null {
  const candidates: InlineMatch[] = [];
  const definitions: Array<{
    kind: InlineMatch["kind"];
    pattern: RegExp;
    read(match: RegExpExecArray): Pick<InlineMatch, "content" | "target">;
  }> = [
    {
      kind: "code",
      pattern: /`([^`\n]+)`/,
      read: (match) => ({ content: match[1] }),
    },
    {
      kind: "link",
      pattern: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/,
      read: (match) => ({ content: match[1], target: match[2] }),
    },
    {
      kind: "strong",
      pattern: /\*\*([^*\n]+)\*\*|__([^_\n]+)__/,
      read: (match) => ({ content: match[1] ?? match[2] }),
    },
    {
      kind: "delete",
      pattern: /~~([^~\n]+)~~/,
      read: (match) => ({ content: match[1] }),
    },
    {
      kind: "emphasis",
      pattern: /\*([^*\n]+)\*/,
      read: (match) => ({ content: match[1] }),
    },
  ];

  for (const definition of definitions) {
    const match = definition.pattern.exec(text);
    if (!match) continue;
    const value = definition.read(match);
    candidates.push({
      content: value.content,
      index: match.index,
      kind: definition.kind,
      length: match[0].length,
      target: value.target,
    });
  }

  return candidates.reduce<InlineMatch | null>((best, candidate) => {
    if (!best || candidate.index < best.index) return candidate;
    return best;
  }, null);
}

function appendInline(parent: HTMLElement, text: string): void {
  let remaining = text;
  while (remaining) {
    const match = nextInlineMatch(remaining);
    if (!match) {
      parent.append(document.createTextNode(remaining));
      return;
    }
    if (match.index > 0) parent.append(document.createTextNode(remaining.slice(0, match.index)));

    let element: HTMLElement;
    if (match.kind === "code") {
      element = document.createElement("code");
      element.textContent = match.content;
    } else if (match.kind === "link") {
      const target = safeLinkTarget(match.target ?? "");
      if (!target) {
        parent.append(document.createTextNode(match.content));
        remaining = remaining.slice(match.index + match.length);
        continue;
      }
      const link = document.createElement("a");
      link.href = target;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      appendInline(link, match.content);
      element = link;
    } else {
      element = document.createElement(
        match.kind === "strong" ? "strong" : match.kind === "delete" ? "del" : "em",
      );
      appendInline(element, match.content);
    }
    parent.append(element);
    remaining = remaining.slice(match.index + match.length);
  }
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of trimmed) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableAlignments(line: string): TableAlignment[] | null {
  const cells = splitTableRow(line);
  if (cells.length === 0 || cells.some((cell) => !/^:?-{3,}:?$/.test(cell))) return null;
  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

function appendTableCell(
  row: HTMLTableRowElement,
  tag: "td" | "th",
  content: string,
  alignment: TableAlignment,
): void {
  const cell = document.createElement(tag);
  if (alignment) cell.style.textAlign = alignment;
  appendInline(cell, content);
  row.append(cell);
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (!line.trim()) return true;
  if (/^ {0,3}(#{1,6})\s+/.test(line)) return true;
  if (/^ {0,3}(```+|~~~+)/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}(?:[-+*]\s+|\d+[.)]\s+)/.test(line)) return true;
  if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
  return index + 1 < lines.length && tableAlignments(lines[index + 1]) !== null;
}

function appendMarkdownBlocks(markdownText: string, root: HTMLElement): void {
  const lines = markdownText.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^ {0,3}(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const marker = fence[1];
      const language = fence[2].toLocaleLowerCase();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      const value = codeLines.join("\n");
      if (language && hljs.getLanguage(language)) {
        code.className = `hljs language-${language}`;
        code.innerHTML = hljs.highlight(value, { language, ignoreIllegals: true }).value;
      } else {
        code.textContent = value;
      }
      pre.append(code);
      root.append(pre);
      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendInline(element, heading[2]);
      root.append(element);
      index += 1;
      continue;
    }

    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      root.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^ {0,3}> ?/, ""));
        index += 1;
      }
      const blockquote = document.createElement("blockquote");
      appendMarkdownBlocks(quoted.join("\n"), blockquote);
      root.append(blockquote);
      continue;
    }

    const listMatch = /^ {0,3}([-+*]|\d+[.)])\s+(.+)/.exec(line);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const itemMatch = /^ {0,3}([-+*]|\d+[.)])\s+(.+)/.exec(lines[index]);
        if (!itemMatch || /^\d/.test(itemMatch[1]) !== ordered) break;
        const item = document.createElement("li");
        const task = /^\[([ xX])\]\s+(.*)/.exec(itemMatch[2]);
        if (task) {
          item.classList.add("is-task");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = task[1].toLocaleLowerCase() === "x";
          checkbox.disabled = true;
          item.append(checkbox);
          appendInline(item, task[2]);
        } else {
          appendInline(item, itemMatch[2]);
        }
        list.append(item);
        index += 1;
      }
      root.append(list);
      continue;
    }

    const alignments = index + 1 < lines.length ? tableAlignments(lines[index + 1]) : null;
    if (alignments) {
      const headers = splitTableRow(line);
      const tableScroll = document.createElement("div");
      tableScroll.className = "markdown-table-scroll";
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      headers.forEach((header, cellIndex) => {
        appendTableCell(headRow, "th", header, alignments[cellIndex] ?? null);
      });
      head.append(headRow);
      table.append(head);
      index += 2;
      const body = document.createElement("tbody");
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        const cells = splitTableRow(lines[index]);
        const row = document.createElement("tr");
        for (let cellIndex = 0; cellIndex < headers.length; cellIndex += 1) {
          appendTableCell(row, "td", cells[cellIndex] ?? "", alignments[cellIndex] ?? null);
        }
        body.append(row);
        index += 1;
      }
      table.append(body);
      tableScroll.append(table);
      root.append(tableScroll);
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInline(paragraph, paragraphLines.join(" "));
    root.append(paragraph);
  }
}

function renderMarkdown(text: string): HTMLElement {
  const article = document.createElement("article");
  article.className = "markdown-body";
  appendMarkdownBlocks(text, article);
  return article;
}

export async function renderTextViewer(
  input: ArrayBuffer,
  name: string,
  host: HTMLElement,
  sourceSize = input.byteLength,
): Promise<TextViewerResult> {
  const truncated = sourceSize > MAX_TEXT_BYTES;
  const bytes = new Uint8Array(input, 0, Math.min(input.byteLength, MAX_TEXT_BYTES));
  const { encoding, text } = decodeText(bytes);
  const extension = extensionOf(name);
  const isMarkdown = extension === "md" || extension === "markdown";
  const isSubtitle = SUBTITLE_EXTENSIONS.has(extension);
  const language = languageForFile(name, extension);
  const highlighted = !isMarkdown && (isSubtitle || Boolean(language)) && sourceSize <= MAX_HIGHLIGHT_BYTES;
  const renderFormattedMarkdown = isMarkdown && sourceSize <= MAX_HIGHLIGHT_BYTES;

  const viewer = document.createElement("section");
  viewer.className = `text-viewer ${renderFormattedMarkdown ? "is-markdown" : isSubtitle ? "is-code is-subtitle" : language && !isMarkdown ? "is-code" : "is-plain"}`;

  if (truncated) {
    const notice = document.createElement("div");
    notice.className = "text-viewer-notice";
    notice.textContent = "Large file: showing the first 20 MB";
    viewer.append(notice);
  } else if ((language || isMarkdown || isSubtitle) && !highlighted && !renderFormattedMarkdown) {
    const notice = document.createElement("div");
    notice.className = "text-viewer-notice";
    notice.textContent = isMarkdown
      ? "File exceeds 2 MB; showing plain text"
      : "File exceeds 2 MB; syntax highlighting is disabled";
    viewer.append(notice);
  }

  if (renderFormattedMarkdown) {
    viewer.append(renderMarkdown(text));
  } else if (isSubtitle && highlighted) {
    viewer.append(renderSubtitle(text, extension));
  } else {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    if (highlighted && language) {
      code.className = `hljs language-${language}`;
      code.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } else {
      code.textContent = text;
    }
    pre.append(code);
    viewer.append(pre);
  }
  host.classList.add("is-text");
  host.append(viewer);

  return {
    encoding,
    highlighted,
    lineCount: countLines(text),
    truncated,
  };
}
