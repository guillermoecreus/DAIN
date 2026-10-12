// Shell de la PWA: login, carga de la base local, navegación y estado de sync.
import * as store from './store.js';
import { api, net, isOnline, NetworkError, EMBEDDED } from './api.js';
import * as syncer from './syncer.js';
import { html, $, toast, modal, fmtDate } from './util.js';
import { decodeScaleBarcode, DEFAULT_SCALE } from '../lib/scale.js';
import posView from './views/pos.js';
import cashView from './views/cash.js';
import productsView from './views/products.js';
import customersView from './views/customers.js';
import reportsView from './views/reports.js';
import fiscalView from './views/fiscal.js';
import noticesView from './views/notices.js';

const VIEWS = [
  { id: 'venta', label: 'Vender', perm: 'sell', view: posView },
  { id: 'caja', label: 'Caja', perm: 'cash', view: cashView },
  { id: 'productos', label: 'Productos', perm: 'products', view: productsView, online: true },
  { id: 'clientes', label: 'Clientes', perm: 'customers.view', view: customersView },
  { id: 'reportes', label: 'Reportes', perm: 'reports', view: reportsView, online: true },
  { id: 'facturacion', label: 'Facturación', perm: 'fiscal', view: fiscalView, online: true, fiscal: true },
  { id: 'avisos', label: 'Avisos', perm: null, view: noticesView, online: true },
];

// Estado en memoria compartido por las vistas.
export const app = {
  session: null, tenant: null, products: [], customers: [], shift: null,
  cart: { lines: [], customerId: null },
  can(perm) { const p = this.session?.user.permissions || []; return !perm || p.includes('*') || p.includes(perm); },
  product(id) { return this.products.find(p => p.id === id); },
  customer(id) { return this.customers.find(c => c.id === id); },
  // Resuelve un código escaneado: código propio, o etiqueta de balanza (PLU + peso/importe).
  resolveCode(code) {
    const c = code.trim();
    const direct = this.products.find(p => p.barcodes.some(b => b.code === c));
    if (direct) return { product: direct };
    const scale = decodeScaleBarcode(c, this.tenant?.scale || DEFAULT_SCALE);
    if (scale) {
      const p = this.products.find(x => x.barcodes.some(b => b.kind === 'plu' && b.code === scale.plu));
      if (p) return { product: p, qty: scale.weightKg ?? Math.round((scale.priceCents / p.priceCents) * 1000) / 1000 };
    }
    return null;
  },
  async reloadLocal() {
    this.products = (await store.all('products')).filter(p => p.active !== false).sort((a, b) => a.name.localeCompare(b.name));
    this.customers = (await store.all('customers')).sort((a, b) => a.name.localeCompare(b.name));
    this.tenant = (await store.get('kv', 'tenant')) || this.tenant;
    this.shift = (await store.get('kv', 'shift')) || null;
  },
  render: () => route(),
  enqueue: (type, payload) => syncer.enqueue(type, payload),
};

// Reconciliación del turno con el servidor después de cada pull.
async function onPulled(data) {
  const local = await store.get('kv', 'shift');
  const s = data.openShift;
  if (s && (!local || local.id !== s.id)) {
    await store.put('kv', { id: s.id, openedAt: s.openedAt, openingCents: s.openingCents, baseCents: s.expectedCents - s.openingCents, moves: [] }, 'shift');
  } else if (!s && local) {
    await store.del('kv', 'shift'); // se cerró (en el servidor) y ya no quedan operaciones pendientes
  }
  await app.reloadLocal();
  if (!$('.modal-backdrop')) route();
}

function loginView() {
  $('#app').innerHTML = html`
    <main class="login">
      <form id="login" class="card">
        <h1>POS PoC</h1>
        <p class="muted">Prueba de concepto · POS SaaS multi-comercio offline-first</p>
        <label>Email <input name="email" type="email" autocomplete="username" required autofocus></label>
        <label>Contraseña <input name="password" type="password" autocomplete="current-password" required></label>
        <button class="primary big">Ingresar</button>
        <div class="demo-users">
          <span class="muted">Usuarios de demo (contraseña demo1234):</span>
          ${['dueno@demo.ar', 'cajero@demo.ar', 'almacen@demo.ar'].map(e => html`<button type="button" class="chip" data-email="${e}">${e}</button>`)}
        </div>
      </form>
    </main>`.s;
  $('.demo-users').addEventListener('click', e => {
    const b = e.target.closest('[data-email]');
    if (b) { $('[name=email]').value = b.dataset.email; $('[name=password]').value = 'demo1234'; }
  });
  $('#login').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const { token } = await api('/api/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      await store.put('kv', { token }, 'session');
      const me = await api('/api/me');
      const prev = await store.get('kv', 'owner');
      // Otro comercio en el mismo dispositivo: se limpia la base local (si no hay pendientes).
      if (prev && prev !== me.tenant.id) {
        if (await store.count('outbox')) { toast('Hay operaciones de otro comercio sin sincronizar en este dispositivo', 'error'); return; }
        await store.clearAll();
      }
      await store.put('kv', { token, user: me.user, registerId: me.registers[0].id, registerName: me.registers[0].name }, 'session');
      await store.put('kv', me.tenant, 'tenant');
      await store.put('kv', me.tenant.id, 'owner');
      await boot();
    } catch (err) { toast(err instanceof NetworkError ? 'Para el primer ingreso hace falta conexión' : err.message, 'error'); }
  });
}

async function logout() {
  if (await store.count('outbox')) return toast('Hay ventas sin sincronizar: conectate antes de cerrar sesión', 'error');
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* sin red: se descarta igual la sesión local */ }
  await store.del('kv', 'session');
  location.hash = '';
  loginView();
}

function shell() {
  const s = app.session;
  $('#app').innerHTML = html`
    <header class="top">
      <div class="brand"><strong>${app.tenant?.name}</strong><span class="muted">${s.user.name} · ${s.registerName}</span></div>
      <div class="top-actions">
        <button id="sync-pill" class="pill" title="Sincronizar ahora"></button>
        <label class="switch" title="Corta todas las llamadas al servidor, como un corte de internet"><input type="checkbox" id="force-offline" ${net.forcedOffline ? 'checked' : ''}> Simular sin conexión</label>
        <button id="logout" class="ghost">Salir</button>
      </div>
    </header>
    <nav class="tabs">${VIEWS.filter(v => app.can(v.perm) && (!v.fiscal || app.tenant?.fiscalEnabled)).map(v => html`<a href="#${v.id}" data-view="${v.id}">${v.label}</a>`)}</nav>
    <main id="view"></main>`.s;
  $('#logout').onclick = logout;
  $('#force-offline').onchange = e => { net.forcedOffline = e.target.checked; try { sessionStorage.setItem('forcedOffline', e.target.checked ? '1' : ''); } catch { /* sin storage */ } paintSync(syncer.status); if (!e.target.checked) syncer.syncNow(); route(); };
  $('#sync-pill').onclick = () => (syncer.status.failed ? showFailed() : syncer.syncNow());
  syncer.onStatus(paintSync);
}

function paintSync(st) {
  const el = $('#sync-pill');
  if (!el) return;
  const online = isOnline();
  el.className = `pill ${st.failed ? 'bad' : online ? 'ok' : 'off'}`;
  el.textContent = `${online ? (st.syncing ? 'Sincronizando…' : 'En línea') : 'Sin conexión'} · ${st.pending} pendiente${st.pending === 1 ? '' : 's'}${st.failed ? ` · ${st.failed} con error` : ''}`;
  el.title = st.lastSync ? `Última sincronización: ${fmtDate(st.lastSync)}` : 'Sin sincronizar todavía';
}

async function showFailed() {
  const failed = await store.all('failed');
  const m = modal(html`<h2>Operaciones rechazadas por el servidor</h2>
    <p class="muted">Quedan registradas para revisar; no se reintentan solas.</p>
    <ul class="list">${failed.map(f => html`<li><div><strong>${f.type}</strong> · ${fmtDate(f.createdAt)}<br><span class="error-text">${f.error}</span></div><button class="ghost" data-discard="${f.id}">Descartar</button></li>`)}</ul>
    <div class="actions"><button data-close>Cerrar</button></div>`.s);
  m.el.addEventListener('click', async e => { const id = e.target.dataset.discard; if (id) { await syncer.discardFailed(id); e.target.closest('li').remove(); } });
}

async function route() {
  if (!app.session) return;
  const id = location.hash.slice(1) || 'venta';
  const v = VIEWS.find(x => x.id === id && app.can(x.perm)) || VIEWS.find(x => app.can(x.perm));
  document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('active', a.dataset.view === v.id));
  const el = $('#view');
  if (v.online && !isOnline()) {
    el.innerHTML = html`<div class="card notice"><h2>${v.label} necesita conexión</h2><p>Sin red se puede vender, cobrar, fiar y operar la caja. Esta sección lee datos del servidor.</p></div>`.s;
    return;
  }
  try { await v.view(el, app); } catch (e) { el.innerHTML = html`<div class="card notice"><p class="error-text">${e.message}</p></div>`.s; }
}

async function boot() {
  app.session = await store.get('kv', 'session');
  if (!app.session?.user) return loginView();
  try { net.forcedOffline = sessionStorage.getItem('forcedOffline') === '1'; } catch { /* sin storage */ }
  await app.reloadLocal();
  shell();
  await syncer.refreshCounts();
  route();
  syncer.startAutoSync(onPulled);
}

window.addEventListener('hashchange', route);
window.addEventListener('session-expired', () => { toast('La sesión venció: ingresá de nuevo (las ventas pendientes se conservan)', 'error'); store.del('kv', 'session').then(loginView); });
if ('serviceWorker' in navigator && !EMBEDDED) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
