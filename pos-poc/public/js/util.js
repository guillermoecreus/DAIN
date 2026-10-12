// Plantillas HTML con escape automático: todo valor interpolado se escapa salvo raw().
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Raw(s);
const fmt = v => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v === false || v == null ? '' : esc(v));
export const html = (strings, ...vals) => raw(strings.reduce((o, s, i) => o + s + (i < vals.length ? fmt(vals[i]) : ''), ''));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}

// Modal simple; devuelve el elemento y una función para cerrarlo.
export function modal(content, { wide = false, onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${content}</div>`;
  const close = () => { wrap.remove(); onClose?.(); };
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  $('#modals').append(wrap);
  setTimeout(() => (wrap.querySelector('[autofocus]') || wrap.querySelector('input,button'))?.focus(), 0);
  return { el: wrap, close };
}

export const fmtDate = iso => new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
export const fmtQty = q => (Number.isInteger(q) ? String(q) : q.toLocaleString('es-AR', { maximumFractionDigits: 3 }));
export const formData = form => Object.fromEntries(new FormData(form).entries());

// Confirmación dentro de la página (window.confirm no está disponible en todos los contenedores).
export function confirmDialog(message, { ok = 'Confirmar', danger = false } = {}) {
  return new Promise(resolve => {
    let answered = false;
    const m = modal(html`<h2>¿Confirmás?</h2><p class="pre">${message}</p>
      <div class="actions"><button data-close>Cancelar</button><button class="${danger ? 'primary danger-bg' : 'primary'}" data-ok autofocus>${ok}</button></div>`.s,
    { onClose: () => { if (!answered) resolve(false); } });
    m.el.querySelector('[data-ok]').onclick = () => { answered = true; m.close(); resolve(true); };
  });
}
