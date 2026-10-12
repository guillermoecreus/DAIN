import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup, op, saleOp } from './helpers.js';
import { pushOps } from '../server/modules/sync.js';
import { processFiscalQueue, listFiscalDocs } from '../server/modules/fiscal.js';
import { uuidv7 } from '../public/lib/uuidv7.js';

function ready(adapterOpts) {
  const t = setup(adapterOpts);
  const s = t.session('dueno@demo.ar');
  const reg = t.register(s.tenantId);
  const shiftId = uuidv7();
  pushOps(t.ctx, s, { registerId: reg, ops: [op('shift.open', { shiftId, openingCents: 0 })] });
  const sell = (lines, extra = {}) => { const o = saleOp({ shiftId, lines, ...extra }); pushOps(t.ctx, s, { registerId: reg, ops: [o] }); return o.payload.id; };
  const docs = saleId => t.db.prepare('SELECT * FROM fiscal_documents WHERE sale_id = ? ORDER BY created_at').all(saleId);
  const due = () => t.db.prepare(`UPDATE fiscal_documents SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE status = 'pending'`).run();
  return { ...t, s, reg, shiftId, sell, docs, due };
}

describe('facturación electrónica asíncrona', () => {
  test('la venta no espera a ARCA: queda pendiente y el worker obtiene CAE', async () => {
    const t = ready();
    const coca = t.product(t.s.tenantId, 'Coca-Cola');
    const saleId = t.sell([[coca, 1]]);
    assert.equal(t.docs(saleId)[0].status, 'pending');
    assert.equal(t.docs(saleId)[0].kind, 'FB');
    await processFiscalQueue(t.ctx);
    const [doc] = t.docs(saleId);
    assert.equal(doc.status, 'authorized');
    assert.match(doc.cae, /^\d{14}$/);
    const payload = JSON.parse(doc.payload);
    assert.equal(payload.impNeto + payload.impIVA, payload.impTotal);
    assert.ok(listFiscalDocs(t.db, t.s).documents.find(d => d.saleId === saleId).qrUrl.startsWith('https://www.afip.gob.ar/fe/qr/?p='));
  });

  test('cliente RI con CUIT recibe Factura A; numeración correlativa por tipo', async () => {
    const t = ready();
    const ri = t.customer(t.s.tenantId, 'Distribuidora');
    const yerba = t.product(t.s.tenantId, 'Yerba');
    const a1 = t.sell([[yerba, 10]], { customerId: ri.id, method: 'card' });
    const a2 = t.sell([[yerba, 5]], { customerId: ri.id, method: 'card' });
    await processFiscalQueue(t.ctx);
    assert.deepEqual([t.docs(a1)[0], t.docs(a2)[0]].map(d => [d.kind, d.number]), [['FA', 1], ['FA', 2]]);
  });

  test('caída del integrador: reintento con backoff hasta autorizar', async () => {
    const t = ready({ failRate: 1 });
    const saleId = t.sell([[t.product(t.s.tenantId, 'Alfajor'), 1]]);
    await processFiscalQueue(t.ctx);
    let [doc] = t.docs(saleId);
    assert.equal(doc.status, 'pending');
    assert.equal(doc.attempts, 1);
    assert.ok(doc.next_attempt_at > new Date().toISOString(), 'reprograma a futuro');
    t.fiscalAdapter.failRate = 0;
    t.due();
    await processFiscalQueue(t.ctx);
    [doc] = t.docs(saleId);
    assert.equal(doc.status, 'authorized');
    const q = t.db.prepare('SELECT used FROM invoice_quota WHERE tenant_id = ?').get(t.s.tenantId);
    assert.equal(q.used, 1, 'el cupo se consume una sola vez aunque haya reintentos');
  });

  test('rechazo de validación queda visible con aviso al dueño', async () => {
    const t = ready({ identifyThresholdCents: 100 });
    const saleId = t.sell([[t.product(t.s.tenantId, 'Coca-Cola'), 1]]);
    await processFiscalQueue(t.ctx);
    const [doc] = t.docs(saleId);
    assert.equal(doc.status, 'rejected');
    assert.match(doc.error, /identificar al receptor/);
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE tenant_id = ? AND kind = 'fiscal'`).get(t.s.tenantId));
  });

  test('sin cupo: los comprobantes esperan sin consumir de más', async () => {
    const t = ready();
    const period = new Date().toISOString().slice(0, 7);
    t.db.prepare('INSERT OR REPLACE INTO invoice_quota (tenant_id, period, quota, used) VALUES (?, ?, 1, 0)').run(t.s.tenantId, period);
    const coca = t.product(t.s.tenantId, 'Coca-Cola');
    const s1 = t.sell([[coca, 1]]), s2 = t.sell([[coca, 1]]);
    await processFiscalQueue(t.ctx);
    assert.equal(t.docs(s1)[0].status, 'authorized');
    assert.equal(t.docs(s2)[0].status, 'pending');
    assert.equal(t.docs(s2)[0].error, 'Sin cupo de comprobantes');
    assert.equal(t.db.prepare('SELECT used FROM invoice_quota WHERE tenant_id = ?').get(t.s.tenantId).used, 1);
  });

  test('anular una venta facturada emite nota de crédito asociada', async () => {
    const t = ready();
    const saleId = t.sell([[t.product(t.s.tenantId, 'Cerveza'), 2]]);
    await processFiscalQueue(t.ctx);
    pushOps(t.ctx, t.s, { registerId: t.reg, ops: [op('sale.void', { saleId, shiftId: t.shiftId })] });
    await processFiscalQueue(t.ctx);
    const [inv, nc] = t.docs(saleId);
    assert.equal(inv.status, 'authorized');
    assert.equal(nc.kind, 'NCB');
    assert.equal(nc.status, 'authorized');
    assert.deepEqual(JSON.parse(nc.payload).cbtesAsoc, [{ tipo: 6, ptoVta: inv.pos_number, nro: inv.number }]);
  });

  test('emisor monotributista emite Factura C', async () => {
    const t = setup();
    const s = t.session('almacen@demo.ar');
    const reg = t.register(s.tenantId);
    const shiftId = uuidv7();
    const o = saleOp({ shiftId, lines: [[t.product(s.tenantId, 'Fideos'), 1]] });
    pushOps(t.ctx, s, { registerId: reg, ops: [op('shift.open', { shiftId, openingCents: 0 }), o] });
    await processFiscalQueue(t.ctx);
    const doc = t.db.prepare('SELECT * FROM fiscal_documents WHERE sale_id = ?').get(o.payload.id);
    assert.equal(doc.kind, 'FC');
    assert.equal(JSON.parse(doc.payload).impIVA, 0);
  });
});
