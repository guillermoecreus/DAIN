// M16 Avisos dentro de la app (stock bajo, diferencias de caja, fiscal, cuenta corriente).
import { api } from '../api.js';
import { html, fmtDate } from '../util.js';

const KIND = { stock: 'Stock', caja: 'Caja', fiscal: 'Facturación', cuenta: 'Cuenta corriente', venta: 'Venta' };

export default async function noticesView(el) {
  const list = await api('/api/notifications');
  el.innerHTML = html`<section class="card"><div class="toolbar"><h2>Avisos</h2><button id="read">Marcar todo como leído</button></div>
    <ul class="list">${list.length ? list.map(n => html`<li class="${n.read ? 'muted' : ''}"><span><span class="chip">${KIND[n.kind] || n.kind}</span> ${n.message}</span><span class="small muted">${fmtDate(n.createdAt)}</span></li>`) : html`<li class="muted">Sin avisos</li>`}</ul></section>`.s;
  el.querySelector('#read').onclick = async () => { await api('/api/notifications/read', { method: 'POST' }); noticesView(el); };
}
