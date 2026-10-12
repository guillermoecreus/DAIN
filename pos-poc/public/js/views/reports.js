// M8 Reportes: dashboard del período vs. el anterior (requiere conexión).
import { api, EMBEDDED } from '../api.js';
import { html, $, modal, toast } from '../util.js';
import { ars } from '../../lib/money.js';

const METHODS = { cash: 'Efectivo', mp: 'Mercado Pago', card: 'Tarjeta', transfer: 'Transferencia', account: 'Cuenta corriente' };
const RANGES = [['hoy', 'Hoy'], ['7', '7 días'], ['30', '30 días']];

export default async function reportsView(el, app, range = sessionStorage.getItem('reportRange') || 'hoy') {
  const from = range === 'hoy' ? new Date(new Date().setHours(0, 0, 0, 0)) : new Date(Date.now() - Number(range) * 864e5);
  const qs = `from=${from.toISOString()}&to=${new Date().toISOString()}`;
  const r = await api(`/api/reports/summary?${qs}`);
  const delta = (a, b) => (b ? `${a >= b ? '▲' : '▼'} ${Math.abs(Math.round((a / b - 1) * 100))}% vs. período anterior` : 'sin período anterior');
  const maxHour = Math.max(1, ...r.byHour);
  const kpi = (label, v, prev, fmt = ars) => html`<div class="kpi"><span class="muted">${label}</span><strong>${fmt(v)}</strong><span class="small ${v >= prev ? 'ok-text' : 'error-text'}">${delta(v, prev)}</span></div>`;
  el.innerHTML = html`
    <div class="toolbar"><div class="seg">${RANGES.map(([k, v]) => html`<button data-range="${k}" class="${k === range ? 'on' : ''}">${v}</button>`)}</div>
      <button id="csv">Exportar ventas (CSV)</button></div>
    <div class="kpis">
      ${kpi('Ventas', r.current.totalCents, r.previous.totalCents)}
      ${kpi('Operaciones', r.current.salesCount, r.previous.salesCount, String)}
      ${kpi('Ticket promedio', r.current.avgTicketCents, r.previous.avgTicketCents)}
      ${kpi('Margen estimado', r.current.marginCents, r.previous.marginCents)}
    </div>
    <div class="grid2">
      <section class="card"><h2>Ventas por hora</h2>
        <div class="bars">${r.byHour.map((v, h) => (h >= 7 && h <= 23 ? html`<div class="bar" title="${h}:00 · ${ars(v)}"><span style="height:${Math.round((v / maxHour) * 100)}%"></span><small>${h}</small></div>` : ''))}</div></section>
      <section class="card"><h2>Por medio de pago</h2>
        <ul class="list">${r.byMethod.map(m => html`<li><span>${METHODS[m.method]}</span><strong>${ars(m.totalCents)}</strong></li>`)}</ul></section>
      <section class="card"><h2>Más vendidos</h2>
        <ul class="list">${r.topProducts.map(p => html`<li><span>${p.name} <span class="muted">× ${p.qty}</span></span><strong>${ars(p.totalCents)}</strong></li>`)}</ul></section>
      <section class="card"><h2>Menos vendidos</h2>
        <ul class="list">${r.bottomProducts.length ? r.bottomProducts.map(p => html`<li><span>${p.name} <span class="muted">× ${p.qty}</span></span><strong>${ars(p.totalCents)}</strong></li>`) : html`<li class="muted">Pocos productos vendidos en el período</li>`}</ul></section>
      <section class="card"><h2>Sin rotación (30 días)</h2><p class="muted small">Stock inmovilizado valorizado al costo. Regla determinística: no necesita IA.</p>
        <ul class="list">${r.noRotation.length ? r.noRotation.map(p => html`<li><span>${p.name} <span class="muted">stock ${p.stock}</span></span><strong>${ars(p.valueAtCostCents)}</strong></li>`) : html`<li class="muted">Todo rota</li>`}</ul></section>
    </div>`.s;
  el.querySelector('.seg').onclick = e => { const k = e.target.dataset.range; if (k) { sessionStorage.setItem('reportRange', k); reportsView(el, app, k); } };
  $('#csv').onclick = async () => {
    const { csv } = await api(`/api/reports/sales.csv?${qs}`);
    if (EMBEDDED) return showCsv(csv); // el visor del artifact no permite descargas
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: `ventas-${range}.csv` });
    a.click(); URL.revokeObjectURL(a.href);
  };
}

function showCsv(csv) {
  const m = modal(html`<h2>Ventas (CSV)</h2><p class="muted small">Copiá el contenido y pegalo en Excel o en un archivo .csv.</p>
    <textarea id="csv-text" rows="12" readonly>${csv}</textarea>
    <div class="actions"><button data-close>Cerrar</button><button class="primary" id="copy-csv">Copiar</button></div>`.s, { wide: true });
  m.el.querySelector('#copy-csv').onclick = async () => {
    const ta = m.el.querySelector('#csv-text');
    try { await navigator.clipboard.writeText(csv); toast('Copiado'); } catch { ta.select(); toast('Seleccionado: copialo con Ctrl+C'); }
  };
}
