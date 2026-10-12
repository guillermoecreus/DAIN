// M7 Clientes y cuentas corrientes ("fiado"). Saldo = suma de asientos;
// los pagos se aplican FIFO a los cargos más viejos para calcular antigüedad.
import { uuidv7 } from '../../public/lib/uuidv7.js';
import { HttpError, audit, requirePerm } from '../core.js';
import { nowIso } from '../db.js';

export function agingOf(entries, now = Date.now()) {
  const charges = [];
  const bySale = new Map();
  let paid = 0;
  for (const e of [...entries].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if (e.type === 'charge') { const c = { ts: e.ts, saleId: e.sale_id, open: e.amount_cents }; charges.push(c); if (e.sale_id) bySale.set(e.sale_id, c); }
    else if (e.type === 'reversal') { const c = e.sale_id && bySale.get(e.sale_id); if (c) c.open -= e.amount_cents; else paid += e.amount_cents; }
    else paid += e.amount_cents;
  }
  for (const c of charges) { const take = Math.min(c.open, paid); c.open -= take; paid -= take; }
  const open = charges.filter(c => c.open > 0);
  const balance = open.reduce((s, c) => s + c.open, 0) - paid; // paid sobrante = saldo a favor
  const oldest = open[0] ? Math.floor((now - Date.parse(open[0].ts)) / 864e5) : null;
  return { balanceCents: balance, oldestDebtDays: oldest, openCharges: open };
}

const entriesOf = (db, tenantId, customerId) =>
  db.prepare('SELECT * FROM account_entries WHERE tenant_id = ? AND customer_id = ? ORDER BY ts').all(tenantId, customerId);

export function listCustomers(db, session) {
  requirePerm(session, 'customers.view');
  const rows = db.prepare('SELECT * FROM customers WHERE tenant_id = ? ORDER BY name').all(session.tenantId);
  return rows.map(c => ({ ...shape(c), ...pick(agingOf(entriesOf(db, session.tenantId, c.id))) }));
}

const pick = a => ({ balanceCents: a.balanceCents, oldestDebtDays: a.oldestDebtDays });
const shape = c => ({
  id: c.id, name: c.name, phone: c.phone, docType: c.doc_type, docNumber: c.doc_number,
  ivaCondition: c.iva_condition, creditLimitCents: c.credit_limit_cents, updatedAt: c.updated_at,
});

export function createCustomer(db, session, c) {
  requirePerm(session, 'customers');
  if (!c.name || c.name.trim().length < 2) throw new HttpError(400, 'El nombre es obligatorio');
  if (c.ivaCondition === 'RI' && !/^\d{11}$/.test(c.docNumber || '')) throw new HttpError(400, 'Un Responsable Inscripto necesita CUIT de 11 dígitos');
  const id = c.id || uuidv7();
  db.prepare(`INSERT INTO customers (id, tenant_id, name, phone, doc_type, doc_number, iva_condition, credit_limit_cents, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, session.tenantId, c.name.trim(), c.phone || null, c.docNumber ? (c.docNumber.length === 11 ? 'CUIT' : 'DNI') : null,
      c.docNumber || null, c.ivaCondition || 'CF', c.creditLimitCents || 0, nowIso());
  audit(db, session, 'customer.create', 'customer', id, { name: c.name });
  return { id };
}

export function statement(db, session, customerId) {
  requirePerm(session, 'customers.view');
  const c = db.prepare('SELECT * FROM customers WHERE id = ? AND tenant_id = ?').get(customerId, session.tenantId);
  if (!c) throw new HttpError(404, 'Cliente inexistente');
  const entries = entriesOf(db, session.tenantId, customerId);
  return { customer: shape(c), ...agingOf(entries), entries: entries.map(e => ({ id: e.id, type: e.type, amountCents: e.amount_cents, saleId: e.sale_id, ts: e.ts })) };
}

export function balanceOf(db, tenantId, customerId) {
  return agingOf(entriesOf(db, tenantId, customerId)).balanceCents;
}
