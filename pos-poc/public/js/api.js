// Cliente HTTP. "Simular sin conexión" corta todas las llamadas, igual que un corte real.
import * as store from './store.js';

export class NetworkError extends Error {}
export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export const net = { forcedOffline: false };
export const isOnline = () => navigator.onLine && !net.forcedOffline;

export async function api(path, { method = 'GET', body } = {}) {
  if (!isOnline()) throw new NetworkError('Sin conexión');
  const session = await store.get('kv', 'session');
  let r;
  try {
    r = await fetch(path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(session?.token ? { authorization: `Bearer ${session.token}` } : {}) },
    });
  } catch { throw new NetworkError('No se pudo conectar con el servidor'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new CustomEvent('session-expired'));
    throw new ApiError(r.status, data.error || `Error ${r.status}`);
  }
  return data;
}
