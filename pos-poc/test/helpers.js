import { createApp } from '../server/app.js';
import { seed } from '../server/seed.js';
import { MockIntegratorAdapter } from '../server/modules/fiscal.js';
import { uuidv7 } from '../public/lib/uuidv7.js';

export function setup(adapterOpts = {}) {
  const fiscalAdapter = new MockIntegratorAdapter({ latencyMs: 0, ...adapterOpts });
  const app = createApp({ dbFile: ':memory:', fiscalAdapter });
  seed(app.ctx);
  const { db } = app.ctx;
  const session = email => {
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    return { tenantId: u.tenant_id, userId: u.id, role: u.role, name: u.name };
  };
  const register = tenantId => db.prepare('SELECT id FROM registers WHERE tenant_id = ?').get(tenantId).id;
  const product = (tenantId, name) => db.prepare('SELECT * FROM products WHERE tenant_id = ? AND name LIKE ?').get(tenantId, `${name}%`);
  const customer = (tenantId, name) => db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND name LIKE ?').get(tenantId, `${name}%`);
  return { app, db, ctx: app.ctx, fiscalAdapter, session, register, product, customer };
}

export const op = (type, payload) => ({ id: uuidv7(), type, payload });

export function saleOp({ shiftId, lines, method = 'cash', customerId = null, payments }) {
  const ls = lines.map(([p, qty, price]) => ({ id: uuidv7(), productId: p.id, description: p.name, qty, unitPriceCents: price ?? p.price_cents, unitCostCents: p.cost_cents }));
  const total = ls.reduce((a, l) => a + Math.round(l.unitPriceCents * l.qty), 0);
  return op('sale', { id: uuidv7(), shiftId, customerId, createdAt: new Date().toISOString(), lines: ls,
    payments: payments || [{ id: uuidv7(), method, amountCents: total }] });
}
