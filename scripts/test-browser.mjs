import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const suites = [
  "epub-browser-smoke.mjs",
  "format-browser-smoke.mjs",
  "pdf-browser-smoke.mjs",
  "preview-shell-smoke.mjs",
  "preview-lifecycle-browser-smoke.mjs",
];
for (const suite of suites) {
  const path = fileURLToPath(new URL(suite, import.meta.url));
  const result = spawnSync(process.execPath, [path], {
    stdio: "inherit",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error) console.error(result.error);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
