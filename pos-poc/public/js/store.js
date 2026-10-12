// Base local (IndexedDB): catálogo, clientes, ventas de esta caja y la cola de operaciones.
const DB_NAME = 'pos-poc';
const STORES = ['kv', 'products', 'customers', 'sales', 'outbox', 'failed'];
let dbp;

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, s === 'kv' ? undefined : { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let out;
    Promise.resolve(fn(tx.objectStore(store))).then(r => { out = r; });
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const get = (store, key) => run(store, 'readonly', s => req(s.get(key)));
export const all = (store) => run(store, 'readonly', s => req(s.getAll()));
export const put = (store, value, key) => run(store, 'readwrite', s => req(key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => run(store, 'readwrite', s => req(s.delete(key)));
export const count = (store) => run(store, 'readonly', s => req(s.count()));
export const replaceAll = (store, values) => run(store, 'readwrite', s => { s.clear(); for (const v of values) s.put(v); });
export const clearAll = () => Promise.all(STORES.map(s => run(s, 'readwrite', st => st.clear())));
