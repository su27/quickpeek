import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_HIGHLIGHT_BYTES = 2 * 1024 * 1024;

const languageByExtension: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cfg: "ini",
  cjs: "javascript",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  md: "markdown",
  mjs: "javascript",
  ps1: "powershell",
  py: "python",
  pyw: "python",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

[
  ["bash", bash],
  ["c", c],
  ["cpp", cpp],
  ["csharp", csharp],
  ["css", css],
  ["go", go],
  ["ini", ini],
  ["java", java],
  ["javascript", javascript],
  ["json", json],
  ["markdown", markdown],
  ["powershell", powershell],
  ["python", python],
  ["rust", rust],
  ["sql", sql],
  ["typescript", typescript],
  ["xml", xml],
  ["yaml", yaml],
].forEach(([name, grammar]) => hljs.registerLanguage(name as string, grammar as typeof bash));

export type TextViewerResult = {
  readonly encoding: string;
  readonly highlighted: boolean;
  readonly lineCount: number;
  readonly truncated: boolean;
};

function extensionOf(name: string): string {
  return name.toLocaleLowerCase().split(".").pop() ?? "";
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

export async function renderTextViewer(
  input: ArrayBuffer,
  name: string,
  host: HTMLElement,
  sourceSize = input.byteLength,
): Promise<TextViewerResult> {
  const truncated = sourceSize > MAX_TEXT_BYTES;
  const bytes = new Uint8Array(input, 0, Math.min(input.byteLength, MAX_TEXT_BYTES));
  const { encoding, text } = decodeText(bytes);
  const language = languageByExtension[extensionOf(name)];
  const highlighted = Boolean(language) && sourceSize <= MAX_HIGHLIGHT_BYTES;

  const viewer = document.createElement("section");
  viewer.className = "text-viewer";

  if (truncated) {
    const notice = document.createElement("div");
    notice.className = "text-viewer-notice";
    notice.textContent = "文件较大，仅显示前 20 MB";
    viewer.append(notice);
  } else if (language && !highlighted) {
    const notice = document.createElement("div");
    notice.className = "text-viewer-notice";
    notice.textContent = "文件超过 2 MB，已关闭语法高亮";
    viewer.append(notice);
  }

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
  host.classList.add("is-text");
  host.append(viewer);

  return {
    encoding,
    highlighted,
    lineCount: countLines(text),
    truncated,
  };
}
