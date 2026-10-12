// M2 + M5: catálogo, ajustes de stock y compras (requiere conexión).
import { api } from '../api.js';
import { html, raw, $, toast, modal, fmtQty, formData } from '../util.js';
import { ars, toCents } from '../../lib/money.js';

const TYPES = { unit: 'Por unidad', weight: 'Por peso (kg)', open: 'Monto libre' };

export default async function productsView(el, app) {
  const [products, sub] = await Promise.all([api('/api/products'), api('/api/subscription')]);
  let filter = '';
  el.innerHTML = html`
    <section class="card">
      <div class="toolbar">
        <h2>Productos</h2>
        <span class="muted">${sub.usage.products} de ${sub.usage.maxProducts} del plan ${sub.plan}</span>
        <input id="filter" placeholder="Filtrar por nombre, categoría o código">
        <button id="new" class="primary">Nuevo producto</button>
        <button id="purchase">Registrar compra</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Producto</th><th>Tipo</th><th>Categoría</th><th class="num">Costo</th><th class="num">Precio</th><th class="num">Margen</th><th class="num">Stock</th><th>Códigos</th><th></th></tr></thead>
      <tbody id="rows"></tbody></table></div>
    </section>`.s;
  const paint = () => {
    const f = filter.toLowerCase();
    $('#rows').innerHTML = products.filter(p => !f || p.name.toLowerCase().includes(f) || (p.category || '').toLowerCase().includes(f) || p.barcodes.some(b => b.code.includes(f)))
      .map(p => html`<tr class="${p.active ? '' : 'muted'}">
        <td><strong>${p.name}</strong>${p.active ? '' : ' (inactivo)'}</td><td>${TYPES[p.type]}</td><td>${p.category}</td>
        <td class="num">${ars(p.costCents)}</td><td class="num">${ars(p.priceCents)}</td>
        <td class="num">${p.priceCents ? Math.round((1 - p.costCents / p.priceCents) * 100) + '%' : '—'}</td>
        <td class="num ${p.type !== 'open' && p.stock <= p.minStock ? 'error-text' : ''}">${p.type === 'open' ? '—' : fmtQty(Math.round(p.stock * 1000) / 1000)}</td>
        <td class="small">${p.barcodes.map(b => b.code).join(', ')}</td>
        <td class="nowrap"><button class="ghost" data-edit="${p.id}">Editar</button>${p.type !== 'open' ? html`<button class="ghost" data-count="${p.id}">Recuento</button>` : ''}</td></tr>`.s).join('');
  };
  $('#filter').oninput = e => { filter = e.target.value; paint(); };
  $('#new').onclick = () => edit(app, null);
  $('#purchase').onclick = () => purchase(app, products);
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.edit) edit(app, products.find(p => p.id === b.dataset.edit));
    if (b.dataset.count) count(app, products.find(p => p.id === b.dataset.count));
  });
  paint();
}

function edit(app, p) {
  const m = modal(html`<form><h2>${p ? 'Editar' : 'Nuevo'} producto</h2>
    <label>Nombre <input name="name" value="${p?.name}" required autofocus></label>
    <div class="row"><label>Tipo <select name="type">${Object.entries(TYPES).map(([k, v]) => html`<option value="${k}" ${p?.type === k ? 'selected' : ''}>${v}</option>`)}</select></label>
    <label>Categoría <input name="category" value="${p?.category}"></label></div>
    <div class="row"><label>Costo ($) <input name="cost" inputmode="decimal" value="${p ? p.costCents / 100 : ''}"></label>
    <label>Precio con IVA ($) <input name="price" inputmode="decimal" value="${p ? p.priceCents / 100 : ''}" required></label></div>
    <div class="row"><label>Stock mínimo <input name="minStock" inputmode="decimal" value="${p?.minStock ?? 0}"></label>
    ${p ? '' : html`<label>Stock inicial <input name="initialStock" inputmode="decimal" value="0"></label>`}</div>
    <label>Códigos de barra (separados por coma; PLU de balanza como "plu:00125") <input name="codes" value="${p?.barcodes.map(b => (b.kind === 'plu' ? 'plu:' : '') + b.code).join(', ')}"></label>
    ${p ? html`<label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Activo</label>` : ''}
    <div class="actions"><button type="button" data-close>Cancelar</button><button class="primary">Guardar</button></div></form>`.s);
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const f = formData(e.target);
    const body = {
      name: f.name, type: f.type, category: f.category || null, costCents: toCents(f.cost || 0), priceCents: toCents(f.price || 0),
      minStock: Number(f.minStock || 0),
      barcodes: f.codes.split(',').map(s => s.trim()).filter(Boolean).map(s => (s.startsWith('plu:') ? { code: s.slice(4), kind: 'plu' } : { code: s, kind: 'ean' })),
    };
    if (p) body.active = !!f.active; else body.initialStock = Number(f.initialStock || 0);
    try {
      await api(p ? `/api/products/${p.id}` : '/api/products', { method: p ? 'PUT' : 'POST', body });
      m.close(); toast('Producto guardado; las cajas lo reciben en la próxima sincronización');
      app.render();
    } catch (err) { toast(err.message, 'error'); }
  };
}

function count(app, p) {
  const m = modal(html`<form><h2>Recuento: ${p.name}</h2><p class="muted">Stock según sistema: ${fmtQty(Math.round(p.stock * 1000) / 1000)}</p>
    <label>Cantidad contada <input name="counted" inputmode="decimal" required autofocus></label>
    <div class="actions"><button type="button" data-close>Cancelar</button><button class="primary">Ajustar</button></div></form>`.s);
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/api/inventory/adjust', { method: 'POST', body: { productId: p.id, countedQty: Number(e.target.counted.value.replace(',', '.')), reason: 'recuento' } });
      m.close(); toast('Stock ajustado'); app.render();
    } catch (err) { toast(err.message, 'error'); }
  };
}

function purchase(app, products) {
  const opts = products.filter(p => p.active && p.type !== 'open');
  const lineHtml = () => html`<div class="row line"><select name="productId">${opts.map(p => html`<option value="${p.id}">${p.name}</option>`)}</select>
    <input name="qty" inputmode="decimal" placeholder="Cantidad" required><input name="cost" inputmode="decimal" placeholder="Costo unitario $"></div>`.s;
  const m = modal(html`<form><h2>Compra a proveedor</h2>
    <label>Proveedor <input name="supplier" required autofocus></label>
    <div id="lines">${raw(lineHtml())}</div><button type="button" id="add-line" class="ghost">+ Agregar línea</button>
    <label class="check"><input type="checkbox" name="updatePrices"> Actualizar precio de venta con margen de <input name="margin" value="40" size="3" inputmode="numeric">%</label>
    <p class="muted small">En el plan IA esta misma pantalla se completa desde la foto de la factura (F3).</p>
    <div class="actions"><button type="button" data-close>Cancelar</button><button class="primary">Registrar</button></div></form>`.s, { wide: true });
  m.el.querySelector('#add-line').onclick = () => m.el.querySelector('#lines').insertAdjacentHTML('beforeend', lineHtml());
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const lines = [...m.el.querySelectorAll('.line')].map(l => ({ productId: l.querySelector('[name=productId]').value, qty: Number(l.querySelector('[name=qty]').value.replace(',', '.')),
      unitCostCents: l.querySelector('[name=cost]').value ? toCents(l.querySelector('[name=cost]').value) : undefined }));
    try {
      await api('/api/inventory/purchases', { method: 'POST', body: { supplier: f.supplier.value, lines, updatePrices: f.updatePrices.checked, targetMarginPct: Number(f.margin.value) } });
      m.close(); toast('Compra registrada: stock y costos actualizados'); app.render();
    } catch (err) { toast(err.message, 'error'); }
  };
}

