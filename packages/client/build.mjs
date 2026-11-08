// Bundles the client with esbuild into dist/ (index.html + app.js + app.css).
//   node build.mjs            → dist/
//   node build.mjs --single   → dist-single/index.html with JS and CSS inlined (offline, no server)
//   node build.mjs --watch    → rebuild dist/ on change
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let esbuild;
try { esbuild = await import('esbuild'); }
catch { esbuild = await import(process.env.ESBUILD_PATH ?? 'esbuild'); }

const single = process.argv.includes('--single');
const watch = process.argv.includes('--watch');
const outdir = join(here, single ? 'dist-single' : 'dist');
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const options = {
  entryPoints: [join(here, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: !watch,
  sourcemap: single || watch ? false : 'linked',
  write: !single,
  outfile: join(outdir, 'app.js'),
  loader: { '.json': 'json' },
  logLevel: 'warning',
  define: { __OFFLINE_BUILD__: single ? 'true' : 'false' },
};

const html = readFileSync(join(here, 'index.html'), 'utf8');
if (single) {
  const res = await esbuild.build(options);
  const js = res.outputFiles.find((f) => f.path.endsWith('.js')).text;
  const css = res.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  const out = html
    .replace('<link rel="stylesheet" href="app.css">', () => `<style>${css}</style>`)
    .replace('<script src="app.js" defer></script>', () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`);
  writeFileSync(join(outdir, 'index.html'), out);
  console.log(`dist-single/index.html  ${(out.length / 1024).toFixed(0)} KB`);
} else if (watch) {
  writeFileSync(join(outdir, 'index.html'), html);
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching…');
} else {
  await esbuild.build(options);
  writeFileSync(join(outdir, 'index.html'), html);
  console.log('dist/ built');
}
