import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { setup, op, saleOp } from './helpers.js';
import { pushOps } from '../server/modules/sync.js';
import { stockOf } from '../server/modules/catalog.js';
import { shiftSummary } from '../server/modules/cash.js';
import { balanceOf } from '../server/modules/customers.js';
import { uuidv7 } from '../public/lib/uuidv7.js';

describe('sync offline-first', () => {
  let t, s, reg, shiftId;
  before(() => {
    t = setup();
    s = t.session('dueno@demo.ar');
    reg = t.register(s.tenantId);
    shiftId = uuidv7();
    const r = pushOps(t.ctx, s, { registerId: reg, ops: [op('shift.open', { shiftId, openingCents: 500000 })] });
    assert.equal(r.results[0].status, 'applied');
  });

  test('reenviar el mismo lote no duplica ventas ni stock (idempotencia)', () => {
    const coca = t.product(s.tenantId, 'Coca-Cola');
    const before = stockOf(t.db, s.tenantId, coca.id);
    const batch = [saleOp({ shiftId, lines: [[coca, 2]] }), saleOp({ shiftId, lines: [[coca, 1]] })];
    const first = pushOps(t.ctx, s, { registerId: reg, ops: batch });
    assert.deepEqual(first.results.map(r => r.status), ['applied', 'applied']);
    const again = pushOps(t.ctx, s, { registerId: reg, ops: batch });
    assert.deepEqual(again.results.map(r => r.status), ['duplicate', 'duplicate']);
    assert.equal(stockOf(t.db, s.tenantId, coca.id), before - 3);
    // Misma venta reenviada dentro de otra operación (p. ej. la caja perdió el acuse): tampoco duplica.
    const resent = { ...batch[0], id: uuidv7() };
    assert.equal(pushOps(t.ctx, s, { registerId: reg, ops: [resent] }).results[0].status, 'applied');
    assert.equal(stockOf(t.db, s.tenantId, coca.id), before - 3);
  });

  test('una venta cobrada sin stock se acepta: stock negativo con aviso', () => {
    const paraguas = t.product(s.tenantId, 'Paraguas');
    const stock = stockOf(t.db, s.tenantId, paraguas.id);
    const r = pushOps(t.ctx, s, { registerId: reg, ops: [saleOp({ shiftId, lines: [[paraguas, stock + 2]] })] });
    assert.equal(r.results[0].status, 'applied');
    assert.equal(stockOf(t.db, s.tenantId, paraguas.id), -2);
    const n = t.db.prepare(`SELECT message FROM notifications WHERE tenant_id = ? AND kind = 'stock'`).all(s.tenantId);
    assert.ok(n.some(x => x.message.includes('Paraguas') && x.message.includes('negativo')));
  });

  test('producto por peso descuenta fracciones y el total se calcula en el servidor', () => {
    const queso = t.product(s.tenantId, 'Queso');
    const before = stockOf(t.db, s.tenantId, queso.id);
    const o = saleOp({ shiftId, lines: [[queso, 0.375]] });
    pushOps(t.ctx, s, { registerId: reg, ops: [o] });
    assert.ok(Math.abs(stockOf(t.db, s.tenantId, queso.id) - (before - 0.375)) < 1e-9);
    const sale = t.db.prepare('SELECT total_cents FROM sales WHERE id = ?').get(o.payload.id);
    assert.equal(sale.total_cents, Math.round(queso.price_cents * 0.375));
  });

  test('fiado: carga en cuenta corriente y cobro en efectivo entra a la caja', () => {
    const rosa = t.customer(s.tenantId, 'Rosa');
    const alfajor = t.product(s.tenantId, 'Alfajor');
    const bal0 = balanceOf(t.db, s.tenantId, rosa.id);
    const exp0 = shiftSummary(t.db, s.tenantId, shiftId).expectedCents;
    pushOps(t.ctx, s, { registerId: reg, ops: [saleOp({ shiftId, lines: [[alfajor, 3]], method: 'account', customerId: rosa.id })] });
    assert.equal(balanceOf(t.db, s.tenantId, rosa.id), bal0 + alfajor.price_cents * 3);
    assert.equal(shiftSummary(t.db, s.tenantId, shiftId).expectedCents, exp0, 'el fiado no suma efectivo');
    pushOps(t.ctx, s, { registerId: reg, ops: [op('account.payment', { id: uuidv7(), customerId: rosa.id, amountCents: 100000, method: 'cash', shiftId })] });
    assert.equal(balanceOf(t.db, s.tenantId, rosa.id), bal0 + alfajor.price_cents * 3 - 100000);
    assert.equal(shiftSummary(t.db, s.tenantId, shiftId).expectedCents, exp0 + 100000);
  });

  test('venta a cuenta corriente sin cliente se rechaza', () => {
    const coca = t.product(s.tenantId, 'Coca-Cola');
    const r = pushOps(t.ctx, s, { registerId: reg, ops: [saleOp({ shiftId, lines: [[coca, 1]], method: 'account' })] });
    assert.equal(r.results[0].status, 'error');
  });

  test('cierre de caja: esperado vs contado, diferencia con aviso, turno inmutable', () => {
    const coca = t.product(s.tenantId, 'Coca-Cola');
    pushOps(t.ctx, s, { registerId: reg, ops: [
      saleOp({ shiftId, lines: [[coca, 1]], payments: [{ id: uuidv7(), method: 'cash', amountCents: 10000 }, { id: uuidv7(), method: 'mp', amountCents: coca.price_cents - 10000 }] }),
      op('cash.move', { id: uuidv7(), shiftId, type: 'out', amountCents: 20000, reason: 'Pago proveedor de hielo' }),
    ] });
    const sum = shiftSummary(t.db, s.tenantId, shiftId);
    const r = pushOps(t.ctx, s, { registerId: reg, ops: [op('shift.close', { shiftId, countedCents: sum.expectedCents - 1500 })] });
    assert.equal(r.results[0].status, 'applied');
    const closed = shiftSummary(t.db, s.tenantId, shiftId);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.differenceCents, -1500);
    assert.ok(t.db.prepare(`SELECT 1 FROM notifications WHERE tenant_id = ? AND kind = 'caja'`).get(s.tenantId));
    const late = pushOps(t.ctx, s, { registerId: reg, ops: [op('cash.move', { id: uuidv7(), shiftId, type: 'in', amountCents: 1, reason: 'x' })] });
    assert.equal(late.results[0].status, 'error');
  });

  test('anulación devuelve stock y revierte la cuenta corriente; el cajero no puede anular', () => {
    const shift2 = uuidv7();
    pushOps(t.ctx, s, { registerId: reg, ops: [op('shift.open', { shiftId: shift2, openingCents: 0 })] });
    const carlos = t.customer(s.tenantId, 'Carlos');
    const yerba = t.product(s.tenantId, 'Yerba');
    const stock0 = stockOf(t.db, s.tenantId, yerba.id);
    const bal0 = balanceOf(t.db, s.tenantId, carlos.id);
    const sale = saleOp({ shiftId: shift2, lines: [[yerba, 2]], method: 'account', customerId: carlos.id });
    pushOps(t.ctx, s, { registerId: reg, ops: [sale] });
    const cajero = t.session('cajero@demo.ar');
    const denied = pushOps(t.ctx, cajero, { registerId: reg, ops: [op('sale.void', { saleId: sale.payload.id, shiftId: shift2 })] });
    assert.equal(denied.results[0].status, 'error');
    pushOps(t.ctx, s, { registerId: reg, ops: [op('sale.void', { saleId: sale.payload.id, shiftId: shift2, reason: 'error de carga' })] });
    assert.equal(stockOf(t.db, s.tenantId, yerba.id), stock0);
    assert.equal(balanceOf(t.db, s.tenantId, carlos.id), bal0);
  });
});
