// Cola de operaciones + sincronización. La venta se confirma local; esto la sube
// cuando hay red (idempotente por id) y después baja catálogo, clientes y turno.
import * as store from './store.js';
import { api, isOnline, NetworkError } from './api.js';
import { uuidv7 } from '../lib/uuidv7.js';

let seq = Date.now();
let running = false;
const listeners = new Set();
export const status = { pending: 0, failed: 0, lastSync: null, syncing: false, lastError: null };

export const onStatus = fn => { listeners.add(fn); fn(status); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(fn => fn(status));

export async function refreshCounts() {
  status.pending = await store.count('outbox');
  status.failed = await store.count('failed');
  emit();
}

export async function enqueue(type, payload) {
  const op = { id: uuidv7(), type, payload, seq: seq++, createdAt: new Date().toISOString() };
  await store.put('outbox', op);
  await refreshCounts();
  syncNow();
  return op;
}

// onPulled(data) lo usa la app para refrescar catálogo, clientes y turno en memoria.
export async function syncNow({ onPulled } = syncNow.opts) {
  if (running || !isOnline()) return emit();
  const session = await store.get('kv', 'session');
  if (!session) return;
  running = true; status.syncing = true; emit();
  try {
    let ops = (await store.all('outbox')).sort((a, b) => a.seq - b.seq);
    while (ops.length) {
      const batch = ops.slice(0, 100);
      const { results } = await api('/api/sync/push', { method: 'POST', body: { registerId: session.registerId, ops: batch.map(({ id, type, payload }) => ({ id, type, payload })) } });
      for (const r of results) {
        const op = batch.find(o => o.id === r.id);
        if (r.status === 'error') await store.put('failed', { ...op, error: r.error, failedAt: new Date().toISOString() });
        else if (op.type === 'sale') { const s = await store.get('sales', op.payload.id); if (s) await store.put('sales', { ...s, synced: true }); }
        await store.del('outbox', r.id);
      }
      ops = ops.slice(100);
    }
    // Solo se baja el estado del servidor con la cola vacía, para no pisar lo optimista.
    if (!(await store.count('outbox'))) {
      const data = await api(`/api/sync/pull?registerId=${encodeURIComponent(session.registerId)}`);
      await store.replaceAll('products', data.products);
      await store.replaceAll('customers', data.customers);
      await store.put('kv', data.tenant, 'tenant');
      await onPulled?.(data);
    }
    status.lastSync = new Date().toISOString();
    status.lastError = null;
  } catch (e) {
    status.lastError = e instanceof NetworkError ? null : e.message;
  } finally {
    running = false; status.syncing = false;
    await refreshCounts();
  }
}
syncNow.opts = {};

export function startAutoSync(onPulled) {
  syncNow.opts = { onPulled };
  if (!startAutoSync.started) {
    startAutoSync.started = true;
    window.addEventListener('online', () => syncNow());
    setInterval(() => syncNow(), 15000);
  }
  return syncNow();
}

export async function discardFailed(id) { await store.del('failed', id); await refreshCounts(); }
