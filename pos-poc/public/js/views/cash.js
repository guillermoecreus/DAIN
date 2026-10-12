// M6 Caja y turnos — funciona sin conexión. El esperado que se muestra es el
// estimado de esta caja; el definitivo lo recalcula el servidor al sincronizar.
import * as store from '../store.js';
import { api, isOnline } from '../api.js';
import { html, $, toast, modal, fmtDate, confirmDialog } from '../util.js';
import { ars, toCents } from '../../lib/money.js';
import { uuidv7 } from '../../lib/uuidv7.js';
import { showTicket } from './pos.js';

const DENOMINATIONS = [20000, 10000, 2000, 1000, 500, 200, 100, 50, 20, 10];
const METHODS = { cash: 'Efectivo', mp: 'Mercado Pago', card: 'Tarjeta', transfer: 'Transferencia', account: 'Cuenta corriente' };

export async function localShiftSummary(app) {
  const s = app.shift;
  const sales = (await store.all('sales')).filter(x => x.shiftId === s.id);
  const byMethod = {};
  for (const sale of sales.filter(x => x.status === 'confirmed')) for (const p of sale.payments) byMethod[p.method] = (byMethod[p.method] || 0) + p.amountCents;
  const ins = s.moves.filter(m => m.type === 'in').reduce((a, m) => a + m.amountCents, 0);
  const outs = s.moves.filter(m => m.type === 'out').reduce((a, m) => a + m.amountCents, 0);
  return { sales, byMethod, ins, outs, expectedCents: s.openingCents + (s.baseCents || 0) + (byMethod.cash || 0) + ins - outs };
}

export default async function cashView(el, app) {
  if (!app.shift) return openForm(el, app);
  const sum = await localShiftSummary(app);
  el.innerHTML = html`
    <div class="grid2">
      <section class="card">
        <h2>Turno abierto</h2>
        <p class="muted">Desde ${fmtDate(app.shift.openedAt)} · fondo ${ars(app.shift.openingCents)}</p>
        <dl class="kv">
          ${Object.entries(sum.byMethod).map(([k, v]) => html`<dt>${METHODS[k]}</dt><dd>${ars(v)}</dd>`)}
          <dt>Ingresos de caja</dt><dd>${ars(sum.ins)}</dd>
          <dt>Retiros</dt><dd>− ${ars(sum.outs)}</dd>
          ${app.shift.baseCents ? html`<dt>Movimientos previos (servidor)</dt><dd>${ars(app.shift.baseCents)}</dd>` : ''}
          <dt><strong>Efectivo esperado</strong></dt><dd><strong>${ars(sum.expectedCents)}</strong></dd>
        </dl>
        <form id="move" class="inline">
          <select name="type"><option value="out">Retiro / gasto</option><option value="in">Ingreso</option></select>
          <input name="amount" inputmode="decimal" placeholder="Importe" required>
          <input name="reason" placeholder="Motivo" required>
          <button>Registrar</button>
        </form>
        <h3>Cerrar turno</h3>
        <form id="close">
          <details><summary>Contar por billetes y monedas</summary>
            <div class="denoms">${DENOMINATIONS.map(d => html`<label>${ars(d * 100)} <input data-denom="${d}" type="number" min="0" inputmode="numeric"></label>`)}</div>
          </details>
          <label>Efectivo contado <input name="counted" inputmode="decimal" required></label>
          <button class="primary big">Cerrar turno</button>
        </form>
      </section>
      <section class="card">
        <h2>Ventas del turno</h2>
        <ul class="list">${sum.sales.length ? [...sum.sales].reverse().map(s => html`
          <li class="${s.status === 'voided' ? 'voided' : ''}">
            <div class="grow">${fmtDate(s.createdAt)} · <strong>${ars(s.totalCents)}</strong><br>
              <span class="muted small">${s.payments.map(p => METHODS[p.method]).join(' + ')} · ${s.status === 'voided' ? 'anulada' : s.synced ? 'sincronizada' : 'pendiente de sync'}</span></div>
            <button class="ghost" data-ticket="${s.id}">Ticket</button>
            ${s.status === 'confirmed' && app.can('void') ? html`<button class="ghost danger" data-void="${s.id}">Anular</button>` : ''}
          </li>`) : html`<li class="muted">Todavía no hay ventas en este turno</li>`}
        </ul>
      </section>
    </div>
    <section class="card" id="history"></section>`.s;

  $('#move').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const mv = { id: uuidv7(), shiftId: app.shift.id, type: f.type.value, amountCents: toCents(f.amount.value), reason: f.reason.value.trim(), ts: new Date().toISOString() };
    if (!(mv.amountCents > 0)) return toast('Importe inválido', 'error');
    app.shift.moves.push(mv);
    await store.put('kv', app.shift, 'shift');
    await app.enqueue('cash.move', mv);
    toast('Movimiento registrado');
    app.render();
  };
  el.querySelector('.denoms').addEventListener('input', () => {
    const total = [...el.querySelectorAll('[data-denom]')].reduce((a, i) => a + Number(i.dataset.denom) * (Number(i.value) || 0), 0);
    $('#close').counted.value = total.toFixed(2);
  });
  $('#close').onsubmit = async e => {
    e.preventDefault();
    const countedCents = toCents(e.target.counted.value);
    if (!(countedCents >= 0)) return toast('Importe inválido', 'error');
    const diff = countedCents - sum.expectedCents;
    if (!(await confirmDialog(`Esperado ${ars(sum.expectedCents)} · contado ${ars(countedCents)} · diferencia ${ars(diff)}.\nEl turno cerrado no se puede reabrir.`, { ok: 'Cerrar turno' }))) return;
    const denominations = Object.fromEntries([...el.querySelectorAll('[data-denom]')].filter(i => i.value).map(i => [i.dataset.denom, Number(i.value)]));
    await app.enqueue('shift.close', { shiftId: app.shift.id, countedCents, closedAt: new Date().toISOString(), denominations });
    await store.del('kv', 'shift');
    await app.reloadLocal();
    toast(diff === 0 ? 'Turno cerrado sin diferencias' : `Turno cerrado con diferencia de ${ars(diff)}`, diff === 0 ? 'info' : 'error');
    app.render();
  };
  el.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const sale = sum.sales.find(s => s.id === (b.dataset.ticket || b.dataset.void));
    if (b.dataset.ticket) showTicket(app, sale);
    if (b.dataset.void) voidSale(app, sale);
  });
  history($('#history'));
}

function openForm(el, app) {
  el.innerHTML = html`
    <section class="card narrow">
      <h2>Abrir turno</h2>
      <p class="muted">Todas las ventas quedan atadas a este turno y a tu usuario.</p>
      <form id="open"><label>Fondo inicial en efectivo <input name="opening" inputmode="decimal" value="10000" required autofocus></label>
      <button class="primary big">Abrir caja</button></form>
    </section>
    <section class="card" id="history"></section>`.s;
  $('#open').onsubmit = async e => {
    e.preventDefault();
    const openingCents = toCents(e.target.opening.value);
    if (!(openingCents >= 0)) return toast('Importe inválido', 'error');
    const shift = { id: uuidv7(), openedAt: new Date().toISOString(), openingCents, baseCents: 0, moves: [] };
    await store.put('kv', shift, 'shift');
    await app.enqueue('shift.open', { shiftId: shift.id, openingCents, openedAt: shift.openedAt });
    await app.reloadLocal();
    location.hash = '#venta';
    app.render();
  };
  history($('#history'));
}

async function voidSale(app, sale) {
  if (!(await confirmDialog(`Anular la venta de ${ars(sale.totalCents)}: se devuelve el stock${app.tenant.fiscalEnabled ? ' y se emite nota de crédito' : ''}.`, { ok: 'Anular venta', danger: true }))) return;
  await store.put('sales', { ...sale, status: 'voided' });
  for (const l of sale.lines) { const p = app.product(l.productId); if (p && p.type !== 'open') { p.stock += l.qty; await store.put('products', p); } }
  const account = sale.payments.filter(p => p.method === 'account').reduce((a, p) => a + p.amountCents, 0);
  if (account) { const c = app.customer(sale.customerId); if (c) { c.balanceCents -= account; await store.put('customers', c); } }
  await app.enqueue('sale.void', { saleId: sale.id, shiftId: app.shift.id, reason: 'anulada desde caja', ts: new Date().toISOString() });
  toast('Venta anulada');
  app.render();
}

async function history(el) {
  if (!isOnline()) { el.innerHTML = '<p class="muted">El historial de turnos se ve con conexión.</p>'; return; }
  try {
    const shifts = await api('/api/shifts');
    el.innerHTML = html`<h2>Últimos turnos (servidor)</h2>
      <div class="table-wrap"><table><thead><tr><th>Apertura</th><th>Usuario</th><th>Estado</th><th class="num">Esperado</th><th class="num">Contado</th><th class="num">Diferencia</th></tr></thead>
      <tbody>${shifts.map(s => html`<tr><td>${fmtDate(s.openedAt)}</td><td>${s.user}</td><td>${s.status === 'open' ? 'abierto' : 'cerrado'}</td>
        <td class="num">${ars(s.expectedCents)}</td><td class="num">${s.countedCents == null ? '—' : ars(s.countedCents)}</td>
        <td class="num ${s.differenceCents ? 'error-text' : ''}">${s.differenceCents == null ? '—' : ars(s.differenceCents)}</td></tr>`)}</tbody></table></div>`.s;
  } catch { el.innerHTML = '<p class="muted">No se pudo cargar el historial.</p>'; }
}
