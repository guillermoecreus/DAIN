import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { setup, op, saleOp } from './helpers.js';
import { pushOps } from '../server/modules/sync.js';
import { listProducts, createProduct } from '../server/modules/catalog.js';
import { statement, listCustomers } from '../server/modules/customers.js';
import { createUser } from '../server/modules/platform.js';
import { uuidv7 } from '../public/lib/uuidv7.js';

describe('aislamiento multi-tenant y permisos', () => {
  let t, kiosco, almacen;
  before(() => { t = setup(); kiosco = t.session('dueno@demo.ar'); almacen = t.session('almacen@demo.ar'); });

  test('cada comercio ve solo su catálogo y sus clientes', () => {
    const names = listProducts(t.db, almacen.tenantId).map(p => p.name);
    assert.deepEqual(names, ['Fideos 500 g']);
    assert.equal(listCustomers(t.db, almacen).length, 0);
    const rosa = t.customer(kiosco.tenantId, 'Rosa');
    assert.throws(() => statement(t.db, almacen, rosa.id), { status: 404 });
  });

  test('no se puede vender un producto de otro comercio ni usar su caja', () => {
    const reg2 = t.register(almacen.tenantId);
    const shiftId = uuidv7();
    pushOps(t.ctx, almacen, { registerId: reg2, ops: [op('shift.open', { shiftId, openingCents: 0 })] });
    const coca = t.product(kiosco.tenantId, 'Coca-Cola');
    const r = pushOps(t.ctx, almacen, { registerId: reg2, ops: [saleOp({ shiftId, lines: [[coca, 1]] })] });
    assert.equal(r.results[0].status, 'error');
    assert.match(r.results[0].error, /Producto inexistente/);
    assert.throws(() => pushOps(t.ctx, almacen, { registerId: t.register(kiosco.tenantId), ops: [] }), { status: 400 });
  });

  test('reusar el id de operación de otro comercio no revela nada ni aplica', () => {
    const reg1 = t.register(kiosco.tenantId);
    const shiftId = uuidv7();
    const o = op('shift.open', { shiftId, openingCents: 0 });
    pushOps(t.ctx, kiosco, { registerId: reg1, ops: [o] });
    const r = pushOps(t.ctx, almacen, { registerId: t.register(almacen.tenantId), ops: [{ ...o, payload: { shiftId: uuidv7(), openingCents: 0 } }] });
    assert.equal(r.results[0].status, 'error');
  });

  test('roles: el cajero no da de alta productos', () => {
    const cajero = t.session('cajero@demo.ar');
    assert.throws(() => createProduct(t.db, cajero, { name: 'Test', type: 'unit', priceCents: 100 }), { status: 403 });
  });

  test('límites del plan: Esencial permite 2 usuarios', () => {
    createUser(t.db, almacen, { email: 'ayudante@demo.ar', name: 'Ayudante', role: 'cashier', password: 'clave-segura' });
    assert.throws(() => createUser(t.db, almacen, { email: 'otro@demo.ar', name: 'Otro', role: 'cashier', password: 'clave-segura' }), { status: 402 });
  });
});
