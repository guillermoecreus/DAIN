// M3 + M4: aplicación de la cola de operaciones que arma la caja (offline-first).
//
// Reglas del diseño que esta pieza valida:
//  - Cada operación trae un UUID v7 generado en el cliente; si ya se aplicó, se
//    devuelve "duplicate" sin efectos (reintentos y doble envío son seguros).
//  - Las operaciones de una caja se aplican en orden y cada una en su transacción.
//  - Una venta ya cobrada no se rechaza por stock: el stock puede quedar negativo
//    y se avisa. Sí se rechaza lo que viola el aislamiento (ids de otro comercio).
//  - Lo demás (factura, avisos, reportes) reacciona a eventos después del commit.
import { HttpError, audit, notify, can } from '../core.js';
import { nowIso, tx } from '../db.js';
import { isUuid } from '../../public/lib/uuidv7.js';
import { lineTotal } from '../../public/lib/money.js';
import { addMovement } from './catalog.js';
import { expectedCash } from './cash.js';
import { createCustomer, balanceOf } from './customers.js';

const METHODS = new Set(['cash', 'card', 'mp', 'transfer', 'account']);

export function pushOps(ctx, session, { registerId, ops }) {
  const { db, bus } = ctx;
  if (!Array.isArray(ops)) throw new HttpError(400, 'ops debe ser una lista');
  if (ops.length > 500) throw new HttpError(413, 'Lote demasiado grande (máx. 500)');
  const reg = db.prepare('SELECT id FROM registers WHERE id = ? AND tenant_id = ?').get(registerId, session.tenantId);
  if (!reg) throw new HttpError(400, 'Caja inexistente para este comercio');

  const results = [];
  for (const op of ops) {
    if (!isUuid(op?.id)) { results.push({ id: op?.id, status: 'error', error: 'id de operación inválido' }); continue; }
    const prev = db.prepare('SELECT tenant_id, status, error FROM processed_ops WHERE id = ?').get(op.id);
    if (prev) {
      // Un id ya usado por otro comercio no revela nada: se informa como error genérico.
      results.push(prev.tenant_id === session.tenantId ? { id: op.id, status: 'duplicate', prevStatus: prev.status } : { id: op.id, status: 'error', error: 'id de operación inválido' });
      continue;
    }
    const events = [];
    try {
      tx(db, () => {
        apply(db, session, registerId, op, events);
        db.prepare('INSERT INTO processed_ops (id, tenant_id, register_id, type, status, received_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(op.id, session.tenantId, registerId, op.type, 'applied', nowIso());
      });
      results.push({ id: op.id, status: 'applied' });
      for (const [name, payload] of events) bus.emit(name, payload);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('sync op', op.type, e);
      const msg = e instanceof HttpError ? e.message : 'Error interno al aplicar la operación';
      // Se registra el rechazo para que un reintento no lo vuelva a evaluar distinto.
      db.prepare('INSERT INTO processed_ops (id, tenant_id, register_id, type, status, error, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(op.id, session.tenantId, registerId, String(op.type), 'error', msg, nowIso());
      results.push({ id: op.id, status: 'error', error: msg });
    }
  }
  db.prepare('UPDATE registers SET last_sync_at = ? WHERE id = ? AND tenant_id = ?').run(nowIso(), registerId, session.tenantId);
  return { results, serverTime: nowIso() };
}

function apply(db, session, registerId, op, events) {
  const p = op.payload || {};
  switch (op.type) {
    case 'shift.open': return openShift(db, session, registerId, p);
    case 'cash.move': return cashMove(db, session, p);
    case 'customer.create': if (!isUuid(p.id)) throw new HttpError(400, 'id de cliente inválido'); return createCustomer(db, session, p);
    case 'sale': return applySale(db, session, registerId, p, events);
    case 'sale.void': return voidSale(db, session, p, events);
    case 'account.payment': return accountPayment(db, session, p);
    case 'shift.close': return closeShift(db, session, p, events);
    default: throw new HttpError(400, `Tipo de operación desconocido: ${op.type}`);
  }
}

const own = (db, table, id, tenantId) => db.prepare(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?`).get(id, tenantId);
const cents = (v, what) => { if (!Number.isInteger(v) || v < 0) throw new HttpError(400, `${what} inválido`); return v; };
const ts = v => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : nowIso());

function requireOpenShift(db, tenantId, shiftId) {
  const s = own(db, 'shifts', shiftId, tenantId);
  if (!s) throw new HttpError(400, 'Turno inexistente');
  return s;
}

function openShift(db, session, registerId, p) {
  if (!isUuid(p.shiftId)) throw new HttpError(400, 'id de turno inválido');
  const open = db.prepare(`SELECT id FROM shifts WHERE tenant_id = ? AND register_id = ? AND user_id = ? AND status = 'open'`).get(session.tenantId, registerId, session.userId);
  if (open) throw new HttpError(409, 'Ya tenés un turno abierto en esta caja');
  db.prepare(`INSERT INTO shifts (id, tenant_id, register_id, user_id, opened_at, opening_cents, status) VALUES (?, ?, ?, ?, ?, ?, 'open')`)
    .run(p.shiftId, session.tenantId, registerId, session.userId, ts(p.openedAt), cents(p.openingCents, 'Fondo inicial'));
  audit(db, session, 'shift.open', 'shift', p.shiftId, { openingCents: p.openingCents });
}

function cashMove(db, session, p) {
  const s = requireOpenShift(db, session.tenantId, p.shiftId);
  if (s.status === 'closed') throw new HttpError(409, 'El turno ya está cerrado');
  if (!['in', 'out'].includes(p.type)) throw new HttpError(400, 'Tipo de movimiento inválido');
  if (!p.reason) throw new HttpError(400, 'El motivo es obligatorio');
  db.prepare('INSERT INTO cash_movements (id, tenant_id, shift_id, type, amount_cents, reason, user_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, session.tenantId, p.shiftId, p.type, cents(p.amountCents, 'Importe'), p.reason, session.userId, ts(p.ts));
  audit(db, session, 'cash.move', 'shift', p.shiftId, { type: p.type, amountCents: p.amountCents, reason: p.reason });
}

function applySale(db, session, registerId, s, events) {
  if (!can(session.role, 'sell')) throw new HttpError(403, 'Tu rol no permite vender');
  if (!isUuid(s.id)) throw new HttpError(400, 'id de venta inválido');
  const existing = db.prepare('SELECT tenant_id FROM sales WHERE id = ?').get(s.id);
  if (existing?.tenant_id === session.tenantId) return; // misma venta reenviada con otra operación
  if (existing) throw new HttpError(400, 'id de venta inválido');
  if (!Array.isArray(s.lines) || !s.lines.length) throw new HttpError(400, 'Venta sin líneas');
  if (!Array.isArray(s.payments) || !s.payments.length) throw new HttpError(400, 'Venta sin pagos');
  requireOpenShift(db, session.tenantId, s.shiftId); // un turno ya cerrado igual acepta la venta cobrada
  if (s.customerId && !own(db, 'customers', s.customerId, session.tenantId)) throw new HttpError(400, 'Cliente inexistente');

  const lines = s.lines.map(l => {
    const prod = l.productId ? own(db, 'products', l.productId, session.tenantId) : null;
    if (l.productId && !prod) throw new HttpError(400, 'Producto inexistente para este comercio');
    const qty = Number(l.qty);
    if (!(qty > 0)) throw new HttpError(400, 'Cantidad inválida');
    const unit = cents(l.unitPriceCents, 'Precio');
    // Costo histórico: el que conocía la caja al vender (para margen); si no vino, el actual.
    const cost = Number.isInteger(l.unitCostCents) ? l.unitCostCents : (prod?.cost_cents ?? 0);
    return { id: isUuid(l.id) ? l.id : null, prod, qty, unit, cost, total: lineTotal(unit, qty), description: String(l.description || prod?.name || 'Varios').slice(0, 120) };
  });
  if (lines.some(l => !l.id)) throw new HttpError(400, 'id de línea inválido');
  const total = lines.reduce((a, l) => a + l.total, 0);

  const pays = s.payments.map(x => {
    if (!METHODS.has(x.method)) throw new HttpError(400, `Medio de pago inválido: ${x.method}`);
    if (!isUuid(x.id)) throw new HttpError(400, 'id de pago inválido');
    return { id: x.id, method: x.method, amount: cents(x.amountCents, 'Pago'), reference: x.reference ?? null };
  });
  const paid = pays.reduce((a, x) => a + x.amount, 0);
  const account = pays.filter(x => x.method === 'account').reduce((a, x) => a + x.amount, 0);
  if (account && !s.customerId) throw new HttpError(400, 'La venta a cuenta corriente necesita cliente');

  const createdAt = ts(s.createdAt);
  db.prepare(`INSERT INTO sales (id, tenant_id, register_id, shift_id, user_id, customer_id, total_cents, status, created_at, synced_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`)
    .run(s.id, session.tenantId, registerId, s.shiftId, session.userId, s.customerId || null, total, createdAt, nowIso());
  const insLine = db.prepare(`INSERT INTO sale_lines (id, tenant_id, sale_id, product_id, description, qty, unit_price_cents, unit_cost_cents, total_cents)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const l of lines) {
    insLine.run(l.id, session.tenantId, s.id, l.prod?.id ?? null, l.description, l.qty, l.unit, l.cost, l.total);
    if (l.prod && l.prod.type !== 'open') addMovement(db, session, l.prod.id, 'sale', -l.qty, `venta:${s.id}`, l.id, createdAt);
  }
  const insPay = db.prepare('INSERT INTO payments (id, tenant_id, sale_id, method, amount_cents, reference) VALUES (?, ?, ?, ?, ?, ?)');
  for (const x of pays) insPay.run(x.id, session.tenantId, s.id, x.method, x.amount, x.reference);

  if (account) {
    const before = balanceOf(db, session.tenantId, s.customerId);
    db.prepare(`INSERT INTO account_entries (id, tenant_id, customer_id, type, amount_cents, sale_id, ts) VALUES (?, ?, ?, 'charge', ?, ?, ?)`)
      .run(s.id, session.tenantId, s.customerId, account, s.id, createdAt);
    const c = own(db, 'customers', s.customerId, session.tenantId);
    if (c.credit_limit_cents > 0 && before + account > c.credit_limit_cents)
      notify(db, session.tenantId, 'cuenta', `${c.name} superó su límite de crédito (venta sincronizada desde una caja sin conexión)`);
  }
  if (paid !== total) notify(db, session.tenantId, 'venta', `Venta ${s.id.slice(-6)}: pagos (${paid}) ≠ total (${total}) en centavos; revisar`);

  audit(db, session, 'sale.create', 'sale', s.id, { totalCents: total, lines: lines.length, offline: s.offline === true }, registerId);
  events.push(['sale.confirmed', { tenantId: session.tenantId, saleId: s.id, productIds: lines.filter(l => l.prod).map(l => l.prod.id) }]);
}

function voidSale(db, session, p, events) {
  if (!can(session.role, 'void')) throw new HttpError(403, 'Tu rol no permite anular ventas');
  const sale = own(db, 'sales', p.saleId, session.tenantId);
  if (!sale) throw new HttpError(404, 'Venta inexistente');
  if (sale.status === 'voided') return; // idempotente a nivel de negocio también
  const when = ts(p.ts);
  db.prepare(`UPDATE sales SET status = 'voided' WHERE id = ? AND tenant_id = ?`).run(sale.id, session.tenantId);
  const lines = db.prepare('SELECT * FROM sale_lines WHERE sale_id = ? AND tenant_id = ?').all(sale.id, session.tenantId);
  for (const l of lines) if (l.product_id) {
    const prod = own(db, 'products', l.product_id, session.tenantId);
    if (prod && prod.type !== 'open') addMovement(db, session, l.product_id, 'void', l.qty, `anulacion:${sale.id}`, `${l.id.slice(0, -4)}void`, when);
  }
  const account = db.prepare(`SELECT SUM(amount_cents) AS v FROM payments WHERE sale_id = ? AND tenant_id = ? AND method = 'account'`).get(sale.id, session.tenantId).v;
  if (account) db.prepare(`INSERT INTO account_entries (id, tenant_id, customer_id, type, amount_cents, sale_id, ts) VALUES (?, ?, ?, 'reversal', ?, ?, ?)`)
    .run(`${sale.id.slice(0, -4)}rvsl`, session.tenantId, sale.customer_id, account, sale.id, when);
  // Si el turno original ya cerró, la devolución de efectivo sale del turno actual.
  const orig = own(db, 'shifts', sale.shift_id, session.tenantId);
  const cash = db.prepare(`SELECT SUM(amount_cents) AS v FROM payments WHERE sale_id = ? AND tenant_id = ? AND method = 'cash'`).get(sale.id, session.tenantId).v;
  if (cash && orig?.status === 'closed') {
    const cur = requireOpenShift(db, session.tenantId, p.shiftId);
    db.prepare(`INSERT INTO cash_movements (id, tenant_id, shift_id, type, amount_cents, reason, user_id, ts) VALUES (?, ?, ?, 'out', ?, ?, ?, ?)`)
      .run(`${sale.id.slice(0, -4)}rfnd`, session.tenantId, cur.id, cash, `Devolución venta ${sale.id.slice(-6)}`, session.userId, when);
  }
  audit(db, session, 'sale.void', 'sale', sale.id, { reason: p.reason });
  events.push(['sale.voided', { tenantId: session.tenantId, saleId: sale.id, productIds: lines.map(l => l.product_id).filter(Boolean) }]);
}

function accountPayment(db, session, p) {
  const c = own(db, 'customers', p.customerId, session.tenantId);
  if (!c) throw new HttpError(400, 'Cliente inexistente');
  if (!METHODS.has(p.method) || p.method === 'account') throw new HttpError(400, 'Medio de pago inválido');
  const amount = cents(p.amountCents, 'Importe');
  if (!amount) throw new HttpError(400, 'El importe debe ser mayor a cero');
  db.prepare(`INSERT INTO account_entries (id, tenant_id, customer_id, type, amount_cents, ts) VALUES (?, ?, ?, 'payment', ?, ?)`)
    .run(p.id, session.tenantId, c.id, amount, ts(p.ts));
  if (p.method === 'cash') {
    const s = requireOpenShift(db, session.tenantId, p.shiftId);
    if (s.status === 'closed') throw new HttpError(409, 'El turno ya está cerrado');
    db.prepare(`INSERT INTO cash_movements (id, tenant_id, shift_id, type, amount_cents, reason, user_id, ts) VALUES (?, ?, ?, 'in', ?, ?, ?, ?)`)
      .run(p.id, session.tenantId, s.id, amount, `Cobro cuenta corriente: ${c.name}`, session.userId, ts(p.ts));
  }
  audit(db, session, 'account.payment', 'customer', c.id, { amountCents: amount, method: p.method });
}

function closeShift(db, session, p, events) {
  const s = requireOpenShift(db, session.tenantId, p.shiftId);
  if (s.status === 'closed') throw new HttpError(409, 'El turno ya está cerrado');
  const expected = expectedCash(db, session.tenantId, s.id);
  const counted = cents(p.countedCents, 'Contado');
  db.prepare(`UPDATE shifts SET status = 'closed', closed_at = ?, expected_cents = ?, counted_cents = ?, difference_cents = ? WHERE id = ? AND tenant_id = ?`)
    .run(ts(p.closedAt), expected, counted, counted - expected, s.id, session.tenantId);
  audit(db, session, 'shift.close', 'shift', s.id, { expected, counted, denominations: p.denominations || null });
  events.push(['shift.closed', { tenantId: session.tenantId, shiftId: s.id, differenceCents: counted - expected, userName: session.name }]);
}
