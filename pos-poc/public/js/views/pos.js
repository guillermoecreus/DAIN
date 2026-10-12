// M3 Punto de venta. Todo el camino crítico es local: buscar, agregar y confirmar
// no hacen ninguna llamada al servidor.
import * as store from '../store.js';
import { isOnline, api } from '../api.js';
import { html, $, toast, modal, fmtQty, fmtDate } from '../util.js';
import { ars, toCents, lineTotal } from '../../lib/money.js';
import { uuidv7 } from '../../lib/uuidv7.js';

const METHODS = { cash: 'Efectivo', mp: 'Mercado Pago', card: 'Tarjeta', transfer: 'Transferencia', account: 'Cuenta corriente' };
const cartTotal = cart => cart.lines.reduce((a, l) => a + lineTotal(l.unitPriceCents, l.qty), 0);

export default async function posView(el, app) {
  if (!app.shift) {
    el.innerHTML = html`<div class="card notice"><h2>No hay turno abierto</h2><p>Para vender, abrí la caja con el fondo inicial.</p><a class="button primary big" href="#caja">Abrir caja</a></div>`.s;
    return;
  }
  el.innerHTML = html`
    <div class="pos">
      <section class="pos-left card">
        <div class="search-row">
          <input id="q" placeholder="Escaneá o buscá un producto (Enter agrega)" autocomplete="off" autofocus>
          ${'BarcodeDetector' in window ? html`<button id="cam" class="ghost" title="Escanear con la cámara">Cámara</button>` : ''}
          <button id="quick" class="ghost" title="Agregar un importe sin producto">Monto rápido</button>
        </div>
        <ul id="results" class="results"></ul>
        <p class="muted small">Para probar sin lector: escribí el código <code id="ean-demo"></code> y Enter, o la etiqueta de balanza <code id="scale-demo"></code> (queso, 0,755 kg).</p>
      </section>
      <section class="pos-right card">
        <div class="cart-head">
          <h2>Venta</h2>
          <select id="customer" aria-label="Cliente"><option value="">Consumidor final</option>${app.customers.map(c => html`<option value="${c.id}" ${app.cart.customerId === c.id ? 'selected' : ''}>${c.name}</option>`)}</select>
        </div>
        <ul id="cart" class="cart"></ul>
        <div class="total-row"><span>Total</span><strong id="total"></strong></div>
        <button id="charge" class="primary huge">Cobrar</button>
        <button id="clear" class="ghost">Vaciar</button>
      </section>
    </div>`.s;

  const { encodeScaleBarcode } = await import('../../lib/scale.js');
  $('#scale-demo').textContent = encodeScaleBarcode('00123', 0.755, app.tenant?.scale);
  $('#ean-demo').textContent = app.products.find(p => p.barcodes.some(b => b.kind === 'ean'))?.barcodes[0].code ?? '—';

  const q = $('#q');
  const paintResults = () => {
    const term = q.value.trim().toLowerCase();
    const list = term ? app.products.filter(p => p.name.toLowerCase().includes(term) || p.barcodes.some(b => b.code.startsWith(term))).slice(0, 8)
      : app.products.filter(p => p.type !== 'open').slice(0, 8);
    $('#results').innerHTML = list.map(p => html`<li><button data-add="${p.id}"><span>${p.name}</span><span class="muted">${ars(p.priceCents)}${p.type === 'weight' ? '/kg' : ''} · stock ${fmtQty(p.stock)}</span></button></li>`.s).join('');
  };
  const paintCart = () => {
    $('#cart').innerHTML = app.cart.lines.length ? app.cart.lines.map((l, i) => html`
      <li>
        <div class="grow"><strong>${l.description}</strong><br><span class="muted">${ars(l.unitPriceCents)}${l.type === 'weight' ? ' /kg' : ''}</span></div>
        ${l.type === 'unit' ? html`<div class="qty"><button data-dec="${i}" aria-label="Restar">−</button><span>${l.qty}</span><button data-inc="${i}" aria-label="Sumar">+</button></div>` : html`<span class="qty">${fmtQty(l.qty)} ${l.type === 'weight' ? 'kg' : ''}</span>`}
        <strong class="amount">${ars(lineTotal(l.unitPriceCents, l.qty))}</strong>
        <button class="ghost" data-del="${i}" aria-label="Quitar">✕</button>
      </li>`.s).join('') : '<li class="muted empty">Escaneá un producto para empezar</li>';
    $('#total').textContent = ars(cartTotal(app.cart));
  };

  const add = (p, qty) => {
    if (p.type === 'weight' && qty == null) return askNumber(`Peso de ${p.name} (kg)`, '0,250', v => add(p, v));
    const existing = p.type === 'unit' && app.cart.lines.find(l => l.productId === p.id);
    if (existing) existing.qty += qty ?? 1;
    else app.cart.lines.push({ id: uuidv7(), productId: p.id, description: p.name, type: p.type, qty: qty ?? 1, unitPriceCents: p.priceCents, unitCostCents: p.costCents });
    q.value = ''; paintResults(); paintCart(); q.focus();
  };

  q.addEventListener('input', paintResults);
  q.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const v = q.value.trim();
    if (!v) return;
    const hit = app.resolveCode(v);
    if (hit) return add(hit.product, hit.qty);
    const first = $('#results [data-add]');
    if (first) return add(app.product(first.dataset.add));
    toast(`No se encontró "${v}"`, 'error');
  });
  $('#results').addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b) add(app.product(b.dataset.add)); });
  $('#cart').addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t) return;
    const { inc, dec, del } = t.dataset;
    if (inc != null) app.cart.lines[inc].qty++;
    if (dec != null && --app.cart.lines[dec].qty <= 0) app.cart.lines.splice(dec, 1);
    if (del != null) app.cart.lines.splice(del, 1);
    paintCart();
  });
  $('#customer').onchange = e => { app.cart.customerId = e.target.value || null; };
  $('#clear').onclick = () => { app.cart = { lines: [], customerId: null }; app.render(); };
  $('#quick').onclick = () => {
    const open = app.products.find(p => p.type === 'open');
    askNumber('Monto rápido ($)', '1500', v => {
      app.cart.lines.push({ id: uuidv7(), productId: open?.id ?? null, description: 'Varios', type: 'open', qty: 1, unitPriceCents: toCents(v), unitCostCents: 0 });
      paintCart();
    });
  };
  $('#cam')?.addEventListener('click', () => scanWithCamera(code => { const hit = app.resolveCode(code); hit ? add(hit.product, hit.qty) : toast(`Código ${code} no encontrado`, 'error'); }));
  $('#charge').onclick = () => app.cart.lines.length ? checkout(app) : toast('El carrito está vacío', 'error');

  paintResults(); paintCart();
}

function askNumber(title, placeholder, done) {
  const m = modal(html`<form><h2>${title}</h2><input name="v" inputmode="decimal" placeholder="${placeholder}" required autofocus>
    <div class="actions"><button type="button" data-close>Cancelar</button><button class="primary">Aceptar</button></div></form>`.s);
  m.el.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const v = Number(e.target.v.value.replace(',', '.'));
    if (!(v > 0)) return toast('Ingresá un número mayor a cero', 'error');
    m.close(); done(v);
  };
}

function checkout(app) {
  const total = cartTotal(app.cart);
  const pays = [];
  const m = modal(html`
    <h2>Cobrar <span class="big-amount">${ars(total)}</span></h2>
    <div class="methods">${Object.entries(METHODS).map(([k, v]) => html`<button data-method="${k}">${v}</button>`)}</div>
    <ul id="pays" class="list"></ul>
    <div id="cash-box" hidden><label>Recibido en efectivo <input id="received" inputmode="decimal"></label><p>Vuelto: <strong id="change">$ 0</strong></p></div>
    <p id="remaining" class="muted"></p>
    <div class="actions"><button data-close>Cancelar</button><button id="confirm" class="primary big">Confirmar venta</button></div>`.s, { wide: true });
  const $m = s => m.el.querySelector(s);
  const remaining = () => total - pays.reduce((a, p) => a + p.amountCents, 0);
  const paint = () => {
    $m('#pays').innerHTML = pays.map((p, i) => html`<li><span>${METHODS[p.method]}</span><input data-amount="${i}" inputmode="decimal" value="${(p.amountCents / 100).toFixed(2)}"><button class="ghost" data-rm="${i}">✕</button></li>`.s).join('');
    const r = remaining();
    $m('#remaining').textContent = r > 0 ? `Falta asignar ${ars(r)}` : r < 0 ? `Sobran ${ars(-r)}: ajustá los importes` : 'Importes completos';
    const cash = pays.find(p => p.method === 'cash');
    $m('#cash-box').hidden = !cash;
    paintChange();
  };
  const paintChange = () => {
    const cash = pays.find(p => p.method === 'cash');
    const rec = toCents($m('#received').value || 0);
    $m('#change').textContent = cash && rec > cash.amountCents ? ars(rec - cash.amountCents) : ars(0);
  };
  m.el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.method) {
      if (b.dataset.method === 'account' && !app.cart.customerId) return toast('Elegí el cliente antes de fiar', 'error');
      const r = remaining();
      if (r <= 0) return toast('El total ya está cubierto', 'error');
      const same = pays.find(p => p.method === b.dataset.method);
      same ? (same.amountCents += r) : pays.push({ id: uuidv7(), method: b.dataset.method, amountCents: r });
      paint();
    }
    if (b.dataset.rm != null) { pays.splice(b.dataset.rm, 1); paint(); }
  });
  m.el.addEventListener('change', e => { const i = e.target.dataset.amount; if (i != null) { pays[i].amountCents = toCents(e.target.value || 0); paint(); } });
  $m('#received').addEventListener('input', paintChange);
  // Atajo: un solo toque en Efectivo cubre todo
  $m('#confirm').onclick = async () => {
    if (!pays.length) pays.push({ id: uuidv7(), method: 'cash', amountCents: total });
    if (remaining() !== 0) return toast('Los pagos no suman el total', 'error');
    const account = pays.filter(p => p.method === 'account').reduce((a, p) => a + p.amountCents, 0);
    if (account) {
      const c = app.customer(app.cart.customerId);
      if (c.creditLimitCents > 0 && c.balanceCents + account > c.creditLimitCents)
        return toast(`Supera el límite de crédito de ${c.name} (${ars(c.creditLimitCents)}; debe ${ars(c.balanceCents)})`, 'error');
    }
    m.close();
    await confirmSale(app, pays, toCents($m('#received').value || 0));
  };
  paint();
}

async function confirmSale(app, payments, receivedCents) {
  const sale = {
    id: uuidv7(), shiftId: app.shift.id, customerId: app.cart.customerId, createdAt: new Date().toISOString(),
    lines: app.cart.lines.map(({ id, productId, description, qty, unitPriceCents, unitCostCents }) => ({ id, productId, description, qty, unitPriceCents, unitCostCents })),
    payments, offline: !isOnline(),
  };
  const totalCents = cartTotal(app.cart);
  // 1) se guarda local, 2) se actualiza stock y saldo optimistas, 3) se encola. La venta ya está hecha.
  await store.put('sales', { ...sale, totalCents, status: 'confirmed', synced: false });
  for (const l of sale.lines) {
    const p = app.product(l.productId);
    if (p && p.type !== 'open') { p.stock -= l.qty; await store.put('products', p); }
  }
  const account = payments.filter(p => p.method === 'account').reduce((a, p) => a + p.amountCents, 0);
  if (account) { const c = app.customer(sale.customerId); c.balanceCents += account; await store.put('customers', c); }
  await app.enqueue('sale', sale);
  const cash = payments.find(p => p.method === 'cash');
  showTicket(app, { ...sale, totalCents }, cash && receivedCents > cash.amountCents ? receivedCents - cash.amountCents : 0);
  app.cart = { lines: [], customerId: null };
  app.render();
}

export function showTicket(app, sale, changeCents = 0) {
  const c = sale.customerId && app.customer(sale.customerId);
  const m = modal(html`
    <div class="ticket" id="ticket">
      <strong>${app.tenant.name}</strong><br>CUIT ${app.tenant.cuit} · ${app.tenant.ivaCondition === 'RI' ? 'IVA Responsable Inscripto' : 'Monotributo'}<br>
      ${fmtDate(sale.createdAt)} · ${app.session.registerName}<br>${c ? `Cliente: ${c.name}` : 'Consumidor final'}
      <hr>${sale.lines.map(l => html`<div class="tl"><span>${fmtQty(l.qty)} × ${l.description}</span><span>${ars(lineTotal(l.unitPriceCents, l.qty))}</span></div>`)}
      <hr><div class="tl"><strong>TOTAL</strong><strong>${ars(sale.totalCents)}</strong></div>
      ${sale.payments.map(p => html`<div class="tl"><span>${METHODS[p.method]}</span><span>${ars(p.amountCents)}</span></div>`)}
      ${changeCents ? html`<div class="tl"><span>Vuelto</span><span>${ars(changeCents)}</span></div>` : ''}
      <hr><div id="fiscal-line" class="small">${app.tenant.fiscalEnabled ? 'Comprobante no fiscal. La factura electrónica se emite en segundo plano.' : 'Comprobante no válido como factura.'}</div>
      <div class="small muted">Venta ${sale.id.slice(-8)}${sale.offline ? ' · registrada sin conexión' : ''}</div>
    </div>
    <div class="actions no-print">
      ${app.tenant.fiscalEnabled ? html`<button id="fiscal-check">Ver factura</button>` : ''}
      <button id="print">Imprimir</button><button class="primary" data-close autofocus>Nueva venta</button>
    </div>`.s);
  m.el.querySelector('#print').onclick = () => window.print();
  m.el.querySelector('#fiscal-check')?.addEventListener('click', async () => {
    try {
      const docs = await api(`/api/sales/${sale.id}/fiscal`);
      const d = docs.find(x => ['FA', 'FB', 'FC'].includes(x.kind));
      m.el.querySelector('#fiscal-line').innerHTML = !d ? 'Todavía no llegó al servidor (se sincroniza sola).'
        : d.status === 'authorized' ? html`Factura ${d.kind.slice(1)} ${String(d.posNumber).padStart(4, '0')}-${String(d.number).padStart(8, '0')}<br>CAE ${d.cae} · Vto. ${d.caeDue}<br><a href="${d.qrUrl}" target="_blank" rel="noopener">QR fiscal (ARCA)</a>`.s
        : html`Factura ${d.status === 'pending' ? 'pendiente' : 'rechazada'}${d.error ? `: ${d.error}` : ''}`.s;
    } catch (e) { toast(isOnline() ? e.message : 'Sin conexión: la factura se consulta cuando vuelva la red', 'error'); }
  });
}

async function scanWithCamera(onCode) {
  const m = modal(html`<h2>Escanear</h2><video id="cam-video" playsinline muted></video><div class="actions"><button data-close>Cerrar</button></div>`.s, { onClose: () => stream?.getTracks().forEach(t => t.stop()) });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = m.el.querySelector('video');
    video.srcObject = stream; await video.play();
    const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'code_128'] });
    const tick = async () => {
      if (!m.el.isConnected) return;
      const [hit] = await detector.detect(video).catch(() => []);
      if (hit) { m.close(); onCode(hit.rawValue); } else requestAnimationFrame(tick);
    };
    tick();
  } catch { m.close(); toast('No se pudo usar la cámara', 'error'); }
}
