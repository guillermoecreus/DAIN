// M9 Facturación electrónica ARCA — asíncrona, nunca en el camino de la venta.
//
//  venta confirmada ──evento──▶ comprobante "pending" ──worker──▶ cupo atómico ──▶ puerto fiscal
//                                         ▲                                         │
//                                         └──── reintento con backoff ◀── caída ────┤
//                               rechazo de validación ──▶ "rejected" + aviso ◀──────┘
//
// El dominio solo conoce el puerto `authorize(payload)`. En la PoC el adaptador es
// un integrador simulado; en producción sería TusFacturasApp (u otro homologado) o
// WSAA + WSFEv1 directo, sin tocar este módulo.
import { uuidv7 } from '../../public/lib/uuidv7.js';
import { HttpError, audit, notify, requirePerm } from '../core.js';
import { nowIso, tx } from '../db.js';

// Códigos de comprobante de ARCA (WSFEv1).
export const CBTE = { FA: 1, NCA: 3, FB: 6, NCB: 8, FC: 11, NCC: 13 };
const NC_OF = { FA: 'NCA', FB: 'NCB', FC: 'NCC' };
const BASE_BACKOFF_MS = Number(process.env.FISCAL_BACKOFF_MS || 5000);
const MAX_BACKOFF_MS = 15 * 60e3;
export const DEFAULT_MONTHLY_QUOTA = 500;

// A si el receptor es RI con CUIT, B consumidor final; C si el emisor es monotributista.
export function invoiceKind(issuerIva, customer) {
  if (issuerIva === 'MONOTRIBUTO') return 'FC';
  if (customer?.iva_condition === 'RI' && /^\d{11}$/.test(customer.doc_number || '')) return 'FA';
  return 'FB';
}

export function buildPayload(db, tenant, saleId, kind, related = null) {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ? AND tenant_id = ?').get(saleId, tenant.id);
  const customer = sale.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ? AND tenant_id = ?').get(sale.customer_id, tenant.id) : null;
  const lines = db.prepare(`SELECT l.total_cents, COALESCE(p.iva_rate, 21) AS iva FROM sale_lines l LEFT JOIN products p ON p.id = l.product_id
                            WHERE l.sale_id = ? AND l.tenant_id = ?`).all(saleId, tenant.id);
  // Precios con IVA incluido: se discrimina neto e IVA por alícuota (C no discrimina).
  let neto = 0, iva = 0;
  for (const l of lines) { const n = kind.endsWith('C') ? l.total_cents : Math.round(l.total_cents / (1 + l.iva / 100)); neto += n; iva += l.total_cents - n; }
  const docTipo = customer?.doc_type === 'CUIT' ? 80 : customer?.doc_type === 'DNI' ? 96 : 99;
  return {
    cuit: tenant.cuit, ptoVta: tenant.pos_number, cbteTipo: CBTE[kind], concepto: 1,
    docTipo, docNro: docTipo === 99 ? 0 : Number(customer.doc_number), receptor: customer?.name || 'Consumidor final',
    fecha: sale.created_at.slice(0, 10), impTotal: sale.total_cents, impNeto: neto, impIVA: iva, moneda: 'PES', cotizacion: 1,
    cbtesAsoc: related ? [{ tipo: CBTE[related.kind], ptoVta: related.pos_number, nro: related.number }] : undefined,
  };
}

function tenantRow(db, tenantId) { return db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId); }

function enqueue(db, tenant, saleId, kind, related) {
  const id = uuidv7();
  db.prepare(`INSERT INTO fiscal_documents (id, tenant_id, sale_id, kind, pos_number, status, next_attempt_at, related_doc_id, payload, created_at)
              VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(id, tenant.id, saleId, kind, tenant.pos_number, nowIso(), related?.id ?? null, JSON.stringify(buildPayload(db, tenant, saleId, kind, related)), nowIso());
  return id;
}

export function registerFiscalListeners(ctx) {
  const { db, bus } = ctx;
  bus.on('sale.confirmed', ({ tenantId, saleId }) => {
    const t = tenantRow(db, tenantId);
    if (!t.fiscal_enabled) return;
    const sale = db.prepare('SELECT customer_id FROM sales WHERE id = ?').get(saleId);
    const customer = sale.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(sale.customer_id) : null;
    enqueue(db, t, saleId, invoiceKind(t.iva_condition, customer));
  });
  // Anular una venta facturada emite nota de crédito; el comprobante nunca se borra.
  bus.on('sale.voided', ({ tenantId, saleId }) => {
    const t = tenantRow(db, tenantId);
    const inv = db.prepare(`SELECT * FROM fiscal_documents WHERE tenant_id = ? AND sale_id = ? AND kind IN ('FA','FB','FC') AND status != 'rejected'`).get(tenantId, saleId);
    if (!inv) return;
    const ncId = uuidv7();
    db.prepare(`INSERT INTO fiscal_documents (id, tenant_id, sale_id, kind, pos_number, status, next_attempt_at, related_doc_id, payload, created_at)
                VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, '{}', ?)`)
      .run(ncId, tenantId, saleId, NC_OF[inv.kind], t.pos_number, nowIso(), inv.id, nowIso());
  });
}

// Consumo atómico del cupo mensual (add-on por paquete de comprobantes).
export function consumeQuota(db, tenantId, period = nowIso().slice(0, 7)) {
  db.prepare('INSERT OR IGNORE INTO invoice_quota (tenant_id, period, quota) VALUES (?, ?, ?)').run(tenantId, period, DEFAULT_MONTHLY_QUOTA);
  return db.prepare('UPDATE invoice_quota SET used = used + 1 WHERE tenant_id = ? AND period = ? AND used < quota').run(tenantId, period).changes === 1;
}

const lastNumberFn = db => (tenantId, pos, kind) =>
  db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM fiscal_documents WHERE tenant_id = ? AND pos_number = ? AND kind = ?').get(tenantId, pos, kind).n;

// Procesa los comprobantes vencidos para reintento. Devuelve cuántos tocó.
export async function processFiscalQueue(ctx, { limit = 20 } = {}) {
  const { db } = ctx;
  const adapter = ctx.fiscalAdapter;
  const due = db.prepare(`SELECT * FROM fiscal_documents WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT ?`).all(nowIso(), limit);
  for (const doc of due) {
    const t = tenantRow(db, doc.tenant_id);
    let payload = JSON.parse(doc.payload);
    if (doc.related_doc_id) {
      const rel = db.prepare('SELECT * FROM fiscal_documents WHERE id = ?').get(doc.related_doc_id);
      if (rel.status === 'rejected') { finish(db, doc, { status: 'rejected', error: 'El comprobante original no fue autorizado' }); continue; }
      if (rel.status !== 'authorized') { postpone(db, doc, 'Esperando autorización del comprobante original', false); continue; }
      payload = buildPayload(db, t, doc.sale_id, doc.kind, rel);
    }
    if (!doc.quota_consumed) {
      if (!consumeQuota(db, doc.tenant_id)) {
        if (doc.error !== 'Sin cupo de comprobantes') notify(db, doc.tenant_id, 'fiscal', 'Se agotó el cupo mensual de comprobantes: las facturas quedan pendientes hasta ampliar el paquete');
        postpone(db, doc, 'Sin cupo de comprobantes', false);
        continue;
      }
      db.prepare('UPDATE fiscal_documents SET quota_consumed = 1 WHERE id = ?').run(doc.id);
    }
    try {
      const r = await adapter.authorize(payload, { tenantId: doc.tenant_id, kind: doc.kind, lastNumber: lastNumberFn(db) });
      if (r.ok) {
        finish(db, doc, { status: 'authorized', number: r.number, cae: r.cae, caeDue: r.caeDue, payload });
      } else {
        finish(db, doc, { status: 'rejected', error: r.message, payload });
        notify(db, doc.tenant_id, 'fiscal', `Comprobante ${doc.kind} de la venta ${doc.sale_id.slice(-6)} rechazado: ${r.message}`);
      }
    } catch (e) {
      // Caída del servicio: queda pendiente, el dueño la ve en la bandeja.
      postpone(db, doc, `Servicio fiscal no disponible: ${e.message}`, true);
      if (doc.attempts + 1 === 3) notify(db, doc.tenant_id, 'fiscal', `Hay comprobantes pendientes por falla del servicio fiscal (reintentando)`);
    }
  }
  return due.length;
}

function postpone(db, doc, error, countAttempt) {
  const attempts = doc.attempts + (countAttempt ? 1 : 0);
  const wait = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
  db.prepare('UPDATE fiscal_documents SET attempts = ?, error = ?, next_attempt_at = ? WHERE id = ?')
    .run(attempts, error, new Date(Date.now() + wait).toISOString(), doc.id);
}

function finish(db, doc, r) {
  db.prepare(`UPDATE fiscal_documents SET status = ?, number = ?, cae = ?, cae_due = ?, error = ?, attempts = attempts + 1,
              authorized_at = ?, payload = COALESCE(?, payload) WHERE id = ?`)
    .run(r.status, r.number ?? null, r.cae ?? null, r.caeDue ?? null, r.error ?? null, r.status === 'authorized' ? nowIso() : null,
      r.payload ? JSON.stringify(r.payload) : null, doc.id);
}

export function startFiscalWorker(ctx, everyMs = 2000) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await processFiscalQueue(ctx); } catch (e) { console.error('fiscal worker', e); } finally { running = false; }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// QR fiscal según especificación de ARCA (RG 4892): URL con JSON en base64.
export function fiscalQrUrl(doc, payload) {
  const data = {
    ver: 1, fecha: payload.fecha, cuit: Number(payload.cuit), ptoVta: payload.ptoVta, tipoCmp: payload.cbteTipo, nroCmp: doc.number,
    importe: payload.impTotal / 100, moneda: 'PES', ctz: 1, tipoDocRec: payload.docTipo, nroDocRec: payload.docNro, tipoCodAut: 'E', codAut: Number(doc.cae),
  };
  return `https://www.afip.gob.ar/fe/qr/?p=${Buffer.from(JSON.stringify(data)).toString('base64')}`;
}

const shapeDoc = d => {
  const payload = JSON.parse(d.payload);
  return {
    id: d.id, saleId: d.sale_id, kind: d.kind, posNumber: d.pos_number, number: d.number, cae: d.cae, caeDue: d.cae_due,
    status: d.status, attempts: d.attempts, error: d.error, createdAt: d.created_at, authorizedAt: d.authorized_at,
    totalCents: payload.impTotal, receptor: payload.receptor, qrUrl: d.status === 'authorized' && payload.cuit ? fiscalQrUrl(d, payload) : null,
  };
};

export function listFiscalDocs(db, session, { status } = {}) {
  requirePerm(session, 'fiscal');
  const rows = db.prepare(`SELECT * FROM fiscal_documents WHERE tenant_id = ? ${status ? 'AND status = ?' : ''} ORDER BY created_at DESC LIMIT 200`)
    .all(...[session.tenantId, status].filter(Boolean));
  const period = nowIso().slice(0, 7);
  const q = db.prepare('SELECT quota, used FROM invoice_quota WHERE tenant_id = ? AND period = ?').get(session.tenantId, period) || { quota: DEFAULT_MONTHLY_QUOTA, used: 0 };
  return { quota: { period, ...q }, documents: rows.map(shapeDoc) };
}

// Documentos de una venta (lo usa la caja para reimprimir el ticket con CAE).
export function docsForSale(db, session, saleId) {
  return db.prepare('SELECT * FROM fiscal_documents WHERE tenant_id = ? AND sale_id = ? ORDER BY created_at').all(session.tenantId, saleId).map(shapeDoc);
}

// Reintento manual de un rechazado (p. ej. después de corregir los datos del cliente).
export function retryDoc(db, session, id) {
  requirePerm(session, 'fiscal');
  const doc = db.prepare('SELECT * FROM fiscal_documents WHERE id = ? AND tenant_id = ?').get(id, session.tenantId);
  if (!doc) throw new HttpError(404, 'Comprobante inexistente');
  if (doc.status === 'authorized') throw new HttpError(409, 'El comprobante ya está autorizado');
  const t = tenantRow(db, session.tenantId);
  tx(db, () => {
    const sale = db.prepare('SELECT customer_id FROM sales WHERE id = ?').get(doc.sale_id);
    const customer = sale.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(sale.customer_id) : null;
    const kind = doc.related_doc_id ? doc.kind : invoiceKind(t.iva_condition, customer);
    db.prepare(`UPDATE fiscal_documents SET status = 'pending', kind = ?, error = NULL, next_attempt_at = ?, payload = ? WHERE id = ?`)
      .run(kind, nowIso(), doc.related_doc_id ? doc.payload : JSON.stringify(buildPayload(db, t, doc.sale_id, kind)), id);
    audit(db, session, 'fiscal.retry', 'fiscal_document', id);
  });
  return { id };
}

// ---------------------------------------------------------------------------
// Adaptador simulado del integrador homologado. Reglas de la simulación:
//  - FISCAL_FAIL_RATE (0..1): probabilidad de caída transitoria (para ver reintentos).
//  - Factura B a consumidor final no identificado por encima de un umbral → rechazo
//    de validación (ilustrativo; el umbral real lo fija ARCA y cambia por normativa).
export class MockIntegratorAdapter {
  constructor({ failRate = Number(process.env.FISCAL_FAIL_RATE || 0), identifyThresholdCents = 100 * Number(process.env.FISCAL_IDENTIFY_THRESHOLD_ARS || 500000), latencyMs = 150 } = {}) {
    Object.assign(this, { failRate, identifyThresholdCents, latencyMs });
  }
  async authorize(payload, { tenantId, kind, lastNumber }) {
    await new Promise(r => setTimeout(r, this.latencyMs));
    if (Math.random() < this.failRate) throw new Error('timeout del integrador');
    if (kind === 'FB' && payload.docTipo === 99 && payload.impTotal >= this.identifyThresholdCents)
      return { ok: false, message: 'Monto que requiere identificar al receptor (DNI/CUIT)' };
    if (kind === 'FA' && payload.docTipo !== 80) return { ok: false, message: 'Factura A requiere CUIT del receptor' };
    const number = lastNumber(tenantId, payload.ptoVta, kind) + 1;
    const cae = String(Math.floor(1e13 + Math.random() * 9e13));
    const caeDue = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    return { ok: true, number, cae, caeDue };
  }
}
