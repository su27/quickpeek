import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep fonts/decoders local. No CDN is needed to preview private documents.
export function pdfAssets() {
  const files = new Map();
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    for (const name of readdirSync(resolve('node_modules/pdfjs-dist', directory))) {
      files.set(`pdfjs/${directory}/${name}`, resolve('node_modules/pdfjs-dist', directory, name));
    }
  }
  files.set('pdfjs/LICENSE', resolve('node_modules/pdfjs-dist/LICENSE'));
  return {
    name: 'quickpeek-pdf-assets',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0].replaceAll('\\', '/').endsWith('/pdfjs-dist/build/pdf.mjs')) return;
      // PDF.js 6.3.289 normally schedules display rendering with animation frames.
      // Hidden WebViews don't deliver them. RenderTask.onContinue below yields
      // through browser tasks instead; it does not change display/print semantics.
      const original = 'useRequestAnimationFrame: !intentPrint,';
      if (code.split(original).length !== 2) throw Error('Review PDF.js hidden-window scheduling after upgrading');
      return { code: code.replace(original, 'useRequestAnimationFrame: false,'), map: null };
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = files.get(req.url?.split('?')[0].replace(/^\//, ''));
        if (!path) return next();
        res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.end(readFileSync(path));
      });
    },
    generateBundle() {
      for (const [fileName, path] of files) this.emitFile({ type: 'asset', fileName, source: readFileSync(path) });
    },
  };
}
