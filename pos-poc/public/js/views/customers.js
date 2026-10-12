// M7 Clientes y cuentas corrientes. Alta y cobro funcionan sin conexión (van por la cola).
import * as store from '../store.js';
import { api, isOnline } from '../api.js';
import { html, $, toast, modal, fmtDate, formData } from '../util.js';
import { ars, toCents } from '../../lib/money.js';
import { uuidv7 } from '../../lib/uuidv7.js';

export default async function customersView(el, app) {
  const debtors = app.customers.filter(c => c.balanceCents > 0).sort((a, b) => (b.oldestDebtDays ?? 0) - (a.oldestDebtDays ?? 0) || b.balanceCents - a.balanceCents);
  const total = debtors.reduce((a, c) => a + c.balanceCents, 0);
  el.innerHTML = html`
    <section class="card">
      <div class="toolbar"><h2>Clientes</h2><span class="muted">Fiado total en la calle: <strong>${ars(total)}</strong></span>
        ${app.can('customers') ? html`<button id="new" class="primary">Nuevo cliente</button>` : ''}</div>
      <div class="table-wrap"><table><thead><tr><th>Cliente</th><th>Condición</th><th class="num">Saldo</th><th class="num">Deuda más vieja</th><th class="num">Límite</th><th></th></tr></thead>
      <tbody>${[...debtors, ...app.customers.filter(c => !(c.balanceCents > 0))].map(c => html`<tr>
        <td><strong>${c.name}</strong><br><span class="muted small">${c.docNumber || ''} ${c.phone || ''}</span></td>
        <td>${c.ivaCondition === 'RI' ? 'Resp. Inscripto' : 'Consumidor final'}</td>
        <td class="num ${c.balanceCents > 0 ? 'error-text' : ''}">${ars(c.balanceCents)}</td>
        <td class="num">${c.oldestDebtDays == null ? '—' : `${c.oldestDebtDays} días`}</td>
        <td class="num">${c.creditLimitCents ? ars(c.creditLimitCents) : 'sin límite'}</td>
        <td class="nowrap"><button class="ghost" data-detail="${c.id}">Cuenta</button>${c.balanceCents > 0 ? html`<button class="ghost" data-pay="${c.id}">Cobrar</button>` : ''}
          ${c.balanceCents > 0 && c.phone ? html`<a class="button ghost" target="_blank" rel="noopener" href="${waLink(app, c)}">WhatsApp</a>` : ''}</td></tr>`)}</tbody></table></div>
    </section>`.s;
  $('#new')?.addEventListener('click', () => create(app));
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.pay) pay(app, app.customer(b.dataset.pay));
    if (b.dataset.detail) detail(app, app.customer(b.dataset.detail));
  });
}

const waLink = (app, c) => `https://wa.me/${c.phone.replace(/\D/g, '')}?text=${encodeURIComponent(`Hola ${c.name.split(' ')[0]}, te escribimos de ${app.tenant.name}: tenés un saldo pendiente de ${ars(c.balanceCents)}. ¡Gracias!`)}`;

function create(app) {
  const m = modal(html`<form><h2>Nuevo cliente</h2>
    <label>Nombre <input name="name" required autofocus></label>
    <div class="row"><label>Teléfono (con código de país) <input name="phone" inputmode="tel" placeholder="5491155550000"></label>
    <label>DNI o CUIT <input name="docNumber" inputmode="numeric"></label></div>
    <div class="row"><label>Condición IVA <select name="ivaCondition"><option value="CF">Consumidor final</option><option value="RI">Responsable Inscripto</option></select></label>
    <label>Límite de fiado ($, 0 = sin límite) <input name="limit" inputmode="decimal" value="0"></label></div>
    <p class="muted small">Datos mínimos (Ley 25.326). Se puede cargar sin conexión.</p>
    <div class="actions"><button type="button" data-close>Cancelar</button><button class="primary">Guardar</button></div></form>`.s);
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const f = formData(e.target);
    if (f.ivaCondition === 'RI' && !/^\d{11}$/.test(f.docNumber)) return toast('Un Responsable Inscripto necesita CUIT de 11 dígitos', 'error');
    const c = { id: uuidv7(), name: f.name.trim(), phone: f.phone || null, docNumber: f.docNumber || null, ivaCondition: f.ivaCondition, creditLimitCents: toCents(f.limit || 0) };
    await store.put('customers', { ...c, balanceCents: 0, oldestDebtDays: null });
    await app.enqueue('customer.create', c);
    await app.reloadLocal();
    m.close(); toast('Cliente creado'); app.render();
  };
}

function pay(app, c) {
  const m = modal(html`<form><h2>Cobrar a ${c.name}</h2><p>Saldo: <strong>${ars(c.balanceCents)}</strong></p>
    <div class="row"><label>Importe <input name="amount" inputmode="decimal" value="${(c.balanceCents / 100).toFixed(2)}" required autofocus></label>
    <label>Medio <select name="method"><option value="cash">Efectivo</option><option value="transfer">Transferencia</option><option value="mp">Mercado Pago</option><option value="card">Tarjeta</option></select></label></div>
    <p class="muted small">El pago se aplica a las deudas más viejas primero.</p>
    <div class="actions"><button type="button" data-close>Cancelar</button><button class="primary">Registrar pago</button></div></form>`.s);
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const amountCents = toCents(e.target.amount.value);
    const method = e.target.method.value;
    if (!(amountCents > 0)) return toast('Importe inválido', 'error');
    if (method === 'cash' && !app.shift) return toast('Para cobrar en efectivo abrí la caja', 'error');
    const p = { id: uuidv7(), customerId: c.id, amountCents, method, shiftId: app.shift?.id, ts: new Date().toISOString() };
    c.balanceCents -= amountCents;
    await store.put('customers', c);
    if (method === 'cash') { app.shift.moves.push({ id: p.id, type: 'in', amountCents, reason: `Cobro cuenta corriente: ${c.name}`, ts: p.ts }); await store.put('kv', app.shift, 'shift'); }
    await app.enqueue('account.payment', p);
    m.close(); toast('Pago registrado'); app.render();
  };
}

async function detail(app, c) {
  if (!isOnline()) return toast(`Saldo actual: ${ars(c.balanceCents)} (el detalle se ve con conexión)`);
  try {
    const st = await api(`/api/customers/${c.id}`);
    const label = { charge: 'Compra a cuenta', payment: 'Pago', reversal: 'Anulación' };
    modal(html`<h2>${c.name}</h2><p>Saldo <strong>${ars(st.balanceCents)}</strong>${st.oldestDebtDays != null ? ` · deuda más vieja: ${st.oldestDebtDays} días` : ''}</p>
      <ul class="list">${st.entries.slice().reverse().map(e => html`<li><span>${fmtDate(e.ts)} · ${label[e.type]}</span><strong class="${e.type === 'charge' ? 'error-text' : ''}">${e.type === 'charge' ? '' : '− '}${ars(e.amountCents)}</strong></li>`)}</ul>
      <div class="actions"><button data-close>Cerrar</button></div>`.s);
  } catch (e) { toast(e.message, 'error'); }
}
