// Punto de entrada del artifact: corre el servidor de la PoC dentro de la página
// (mismo código, SQLite en JavaScript) y conecta la PWA a él sin red real.
import initSqlJs from 'sql.js/dist/sql-asm-memory-growth.js';
import { configureSqlite } from './shims/sqlite.js';

const SERVER_DB = 'pos-poc-servidor';
const banner = document.getElementById('demo-banner');

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SERVER_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('db');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('db', mode);
      const r = fn(tx.objectStore('db'));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const loadBytes = () => idb('readonly', s => s.get('sqlite')).catch(() => null);
const saveBytes = bytes => idb('readwrite', s => s.put(bytes, 'sqlite')).catch(() => {});

async function resetDemo() {
  const del = name => new Promise(r => { const q = indexedDB.deleteDatabase(name); q.onsuccess = q.onerror = q.onblocked = () => r(); });
  await Promise.all([del(SERVER_DB), del('pos-poc')]);
  try { sessionStorage.clear(); } catch { /* sin storage */ }
  location.reload();
}

async function boot() {
  const SQL = await initSqlJs();
  configureSqlite(SQL, await loadBytes());
  const { createApp } = await import('../server/app.js');
  const { seed } = await import('../server/seed.js');
  const { startFiscalWorker } = await import('../server/modules/fiscal.js');
  const app = createApp({ dbFile: ':memory:' });
  const db = app.ctx.db;
  if (!db.prepare('SELECT 1 FROM tenants LIMIT 1').get()) {
    banner.querySelector('[data-status]').textContent = 'Preparando 14 días de ventas de demo…';
    await new Promise(r => setTimeout(r, 30));
    seed(app.ctx);
  }

  // Persistencia del "servidor" en este navegador, con un guardado diferido.
  let timer = null;
  const persist = () => { clearTimeout(timer); timer = setTimeout(() => saveBytes(db.export()), 800); };
  persist();
  startFiscalWorker(app.ctx);
  setInterval(persist, 10000);

  // Transporte: el cliente cree que habla HTTP; acá se despacha en memoria.
  const { transport } = await import('../public/js/api.js');
  transport.fetch = async (path, init = {}) => {
    await new Promise(r => setTimeout(r, 40 + Math.random() * 60)); // latencia de red simulada
    const token = (init.headers?.authorization || '').replace(/^Bearer /, '');
    const body = init.body ? JSON.parse(init.body) : {};
    const { status, data } = await app.dispatch({ method: init.method || 'GET', url: path, token, body });
    if (init.method && init.method !== 'GET') persist();
    return { ok: status < 400, status, json: async () => data };
  };

  banner.querySelector('[data-status]').textContent = 'Demo en el navegador: el servidor corre dentro de esta página y los datos quedan solo en este navegador.';
  banner.querySelector('#reset-demo').hidden = false;
  await import('../public/js/app.js');
}

banner.querySelector('#reset-demo').addEventListener('click', e => {
  const b = e.currentTarget;
  if (b.dataset.armed) return resetDemo();
  b.dataset.armed = '1';
  b.textContent = 'Tocá de nuevo para borrar todo';
  setTimeout(() => { delete b.dataset.armed; b.textContent = 'Reiniciar demo'; }, 4000);
});

boot().catch(err => {
  console.error(err);
  banner.querySelector('[data-status]').textContent = `No se pudo iniciar la demo: ${err.message}. Probá en una ventana normal (no privada) del navegador.`;
  banner.classList.add('error');
  document.getElementById('app').innerHTML = '';
});
