# QuickPeek

QuickPeek is a lightweight, read-only file viewer for Windows. Select a file in File Explorer and press **Space** to view it without opening its usual application. Files stay on your computer; no account or upload is needed.

The Windows x64 installer is about **2.2 MB**. QuickPeek uses the shared Microsoft Edge WebView2 runtime rather than including a separate browser. It is designed to keep memory use low: viewers load when needed, large files have preview limits, and closing a preview releases the current file and puts the viewer to sleep. Actual memory use varies with the file and installed preview components.

## Install

Download `QuickPeek_*_x64-setup.exe` from [Releases](https://github.com/su27/quickpeek/releases/latest), run the installer, and launch QuickPeek. It stays in the system tray until you quit it.

QuickPeek is for Windows 10 and 11, x64. Microsoft Edge WebView2 is required; if it is missing, setup may need an internet connection to install it. File previews work offline once setup is complete.

## Use

- Select a file or folder in File Explorer or on the desktop and press **Space** to preview it.
- Press **Space** again or **Esc** to close the preview. QuickPeek stays in the tray for the next file.
- While File Explorer has focus, use the arrow keys or mouse to select another file. The preview follows the selection.
- Drop a file onto an open preview window, or choose **Open with → QuickPeek** in Windows.
- Use the app button in the title bar to open the file with its default application.
- Press **Ctrl+F** to search supported documents, spreadsheets, presentations, text, archive names, or the current EPUB chapter. Search is not available in every viewer.
- Use the mouse wheel or touchpad to zoom images, and drag to move around a zoomed image. Multi-page TIFF files have page buttons.
- To exit completely, choose **Quit QuickPeek** from its tray menu.

Space does not open a preview while you are typing in File Explorer's search box, address bar, or file-renaming field. QuickPeek does not edit or save changes to your files.

## Supported files

### Documents and books

| Type | Extensions | What to expect |
| --- | --- | --- |
| PDF | `.pdf` | Page preview with scrolling. |
| Word documents and templates | `.docx`, `.docm`, `.dotx`, `.dotm` | Text, tables, images, and page layout. Macros are not run. |
| Rich Text Format | `.rtf` | Formatted text with reading margins; Word is not required. |
| Older Word documents | `.doc` | Requires a compatible Windows preview handler, usually installed with an office application. |
| Spreadsheets | `.xlsx`, `.xls`, `.xlsm`, `.xlsb`, `.xltx`, `.xltm`, `.ods`, `.csv`, `.tsv` | Worksheets, cell contents, and supported formatting. |
| PowerPoint presentations and templates | `.pptx`, `.pptm`, `.ppsx`, `.ppsm`, `.potx`, `.potm` | Slide preview. Macros are not run. |
| Older PowerPoint files | `.ppt`, `.pps`, `.pot` | Requires a compatible Windows preview handler. |
| EPUB ebooks | `.epub` | EPUB 2 and 3, chapter navigation, table of contents, images, and basic formatting. DRM-protected books are not supported. |
| Markdown | `.md`, `.markdown` | Formatted reading view for headings, lists, tables, and code blocks. |

Complex Office layouts may differ from Microsoft Office. DOCX files with missing or very small margins receive minimum reading margins; files without a page width use an A4 reading width. EPUB previews favor readable text over reproducing every publisher layout; embedded audio, video, scripts, and remote resources are not loaded.

### Images, audio, video, and fonts

| Type | Extensions | Notes |
| --- | --- | --- |
| Images | `.apng`, `.avif`, `.bmp`, `.gif`, `.ico`, `.jfif`, `.jpeg`, `.jpg`, `.png`, `.svg`, `.webp` | Zoom and pan. |
| HEIC / HEIF | `.heic`, `.heif` | Requires the relevant Windows image codecs. |
| TIFF | `.tif`, `.tiff` | Single-page and multi-page images. |
| Audio | `.aac`, `.flac`, `.m4a`, `.mp3`, `.ogg`, `.opus`, `.wav` | Playback controls; MP3 metadata when present. |
| Video | `.m4v`, `.mov`, `.mp4`, `.ogv`, `.webm` | Playback controls. |
| Fonts | `.ttf`, `.otf`, `.woff`, `.woff2` | Sample text at several sizes, without installing the font. |

Audio and video start playing when opened. Playback depends on the codecs available on your system; an extension alone does not guarantee that every file will play.

### Archives

QuickPeek shows a collapsible list of folders and files, with sizes and dates where available. It does not extract or run archive contents.

- ZIP-based files: `.zip`, `.jar`, `.war`, `.apk`, `.vsix`, `.nupkg`.
- Other archives: `.tar`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tbz2`, `.tar.xz`, `.txz`, `.tar.zst`, `.7z`, `.rar`. Support for these depends on the archive reader included with Windows. Encrypted or unsupported archives may show file information instead.

### Text, source code, and configuration

QuickPeek displays the following as text, with syntax highlighting for recognized languages in smaller files. HTML and script files are shown as source, not executed.

```text
adoc, ahk, asm, asciidoc, ass, astro, awk, bash, bat, bib, c, cc, cfg,
cjs, clj, cljs, cmake, cmd, coffee, conf, cpp, cs, css, dart, diff,
dockerfile, dockerignore, editorconfig, elm, eml, env, erl, ex, exs,
fish, fs, fsx, gemfile, gitattributes, gitignore, gitmodules, go, gql,
gradle, graphql, groovy, h, handlebars, hbs, hpp, hrl, hs, htm, html,
http, ics, ini, java, jl, js, json, jsonc, jsonl, jsx, kt, kts, less,
lhs, license, lock, log, lrc, lua, m, makefile, manifest, markdown,
md, mdx, mjs, mm, nim, njk, npmrc, nu, pas, patch, pem, php, pl, pp,
procfile, properties, prop, proto, ps1, py, pyw, r, rakefile, rb,
readme, reg, rs, rst, s, scala, scss, sh, sol, sql, srt, ssa, svelte,
swift, tex, tf, tfvars, toml, ts, tsx, txt, vb, vbs, vcf, vtt, vue,
xml, yaml, yml, zig, zsh
```

Common extensionless files such as `README`, `LICENSE`, `Dockerfile`, and `Makefile`, along with dotfiles such as `.gitignore` and `.env`, are also recognized. UTF-8, UTF-16, and common Chinese Windows text encodings are supported.

### Folders and other files

Folders and files without a dedicated viewer show basic information such as name, type, location, modification time, and file size. Folder previews do not scan the entire directory tree. If a supported file cannot be rendered, QuickPeek tries to show its file information instead.

## Preview limits

To keep previews responsive and memory use modest, text is limited to the first 20 MB, with syntax highlighting up to 2 MB. RTF and fonts are limited to 20 MB, and EPUB books to 64 MB with additional chapter and image limits. Large archive listings are truncated and marked as partial. Large images may be reduced for preview.

Use the title-bar app button when you need the full document, a different codec, or editing tools.
