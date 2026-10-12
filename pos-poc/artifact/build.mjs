// Arma un único HTML autocontenido para publicar como artifact:
//   npm i --no-save esbuild@0.24.0 sql.js@1.10.3 && node artifact/build.mjs
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const shim = name => here(`./shims/${name}`);

const result = await build({
  entryPoints: [here('./entry.js')],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false,
  nodePaths: [process.env.NODE_PATH_EXTRA].filter(Boolean),
  alias: {
    'node:sqlite': shim('sqlite.js'), 'node:events': shim('events.js'), 'node:crypto': shim('crypto.js'),
    fs: shim('empty.js'), path: shim('empty.js'), crypto: shim('empty.js'),
    'node:fs': shim('node-misc.js'), 'node:fs/promises': shim('node-misc.js'), 'node:path': shim('node-misc.js'), 'node:url': shim('node-misc.js'),
  },
  inject: [shim('globals.js')],
  define: { 'globalThis.__POS_EMBEDDED__': 'true' },
  logLevel: 'warning',
});

const js = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const css = readFileSync(here('../public/styles.css'), 'utf8');
const html = `<title>POS PoC</title>
<meta name="description" content="Prueba de concepto de POS SaaS offline-first para comercio minorista argentino">
<style>
${css}
.demo-banner { display: flex; flex-wrap: wrap; gap: .4rem 1rem; align-items: center; justify-content: space-between; padding: 8px 16px; background: var(--accent-soft); color: var(--ink); font-size: .85rem; border-bottom: 1px solid var(--line); }
.demo-banner.error { background: var(--bad); color: var(--bg); }
.demo-banner button { min-height: 32px; padding: .2em .8em; font-size: .85rem; }
</style>
<div id="demo-banner" class="demo-banner"><span data-status>Cargando la demo…</span><button id="reset-demo" class="ghost" hidden>Reiniciar demo</button></div>
<div id="app"><p class="loading">Cargando…</p></div>
<div id="modals"></div>
<div id="toasts" aria-live="polite"></div>
<script type="module">
${js}
</script>
`;
mkdirSync(here('../dist'), { recursive: true });
writeFileSync(here('../dist/pos-poc.html'), html);
console.log(`dist/pos-poc.html: ${(html.length / 1024).toFixed(0)} KB`);
