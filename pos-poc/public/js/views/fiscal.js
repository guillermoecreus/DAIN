// M9 Bandeja de comprobantes: autorizados, pendientes (reintentando) y rechazados.
import { api } from '../api.js';
import { html, toast, fmtDate } from '../util.js';
import { ars } from '../../lib/money.js';

const STATUS = { pending: 'Pendiente', authorized: 'Autorizado', rejected: 'Rechazado' };
const num = d => (d.number ? `${String(d.posNumber).padStart(4, '0')}-${String(d.number).padStart(8, '0')}` : '—');

export default async function fiscalView(el, app) {
  const { quota, documents } = await api('/api/fiscal');
  const pending = documents.filter(d => d.status === 'pending').length;
  el.innerHTML = html`
    <section class="card">
      <div class="toolbar"><h2>Facturación electrónica</h2>
        <span class="muted">Cupo ${quota.period}: ${quota.used} de ${quota.quota} comprobantes</span>
        <progress max="${quota.quota}" value="${quota.used}"></progress>
        <button id="refresh">Actualizar</button></div>
      <p class="muted small">Las ventas nunca esperan a ARCA: el comprobante se pide en segundo plano, con reintentos ante caídas. ${pending ? `${pending} pendiente(s) ahora.` : ''}</p>
      <div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Número</th><th>Receptor</th><th class="num">Total</th><th>Estado</th><th>CAE / detalle</th><th></th></tr></thead>
      <tbody>${documents.map(d => html`<tr>
        <td>${fmtDate(d.createdAt)}</td><td>${d.kind}</td><td>${num(d)}</td><td>${d.receptor}</td><td class="num">${d.totalCents != null ? ars(d.totalCents) : '—'}</td>
        <td><span class="status ${d.status}">${STATUS[d.status]}</span>${d.attempts > 1 ? html` <span class="muted small">(${d.attempts} intentos)</span>` : ''}</td>
        <td class="small">${d.cae ? html`${d.cae} · vto ${d.caeDue} · <a href="${d.qrUrl}" target="_blank" rel="noopener">QR</a>` : html`<span class="error-text">${d.error || ''}</span>`}</td>
        <td>${d.status === 'rejected' ? html`<button class="ghost" data-retry="${d.id}">Reintentar</button>` : ''}</td></tr>`)}</tbody></table></div>
    </section>`.s;
  el.querySelector('#refresh').onclick = () => fiscalView(el, app);
  el.addEventListener('click', async e => {
    const id = e.target.dataset.retry;
    if (!id) return;
    try { await api(`/api/fiscal/${id}/retry`, { method: 'POST' }); toast('Reencolado'); fiscalView(el, app); } catch (err) { toast(err.message, 'error'); }
  });
}
