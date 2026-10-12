// M6 Caja y turnos: el efectivo esperado se recalcula siempre en el servidor
// a partir de movimientos; el turno cerrado es inmutable.
import { HttpError } from '../core.js';

export function expectedCash(db, tenantId, shiftId) {
  const s = db.prepare('SELECT opening_cents FROM shifts WHERE id = ? AND tenant_id = ?').get(shiftId, tenantId);
  if (!s) throw new HttpError(404, 'Turno inexistente');
  const q = (sql) => db.prepare(sql).get(tenantId, shiftId).v || 0;
  const cashSales = q(`SELECT SUM(p.amount_cents) AS v FROM payments p JOIN sales s ON s.id = p.sale_id
                       WHERE s.tenant_id = ? AND s.shift_id = ? AND s.status = 'confirmed' AND p.method = 'cash'`);
  const ins = q(`SELECT SUM(amount_cents) AS v FROM cash_movements WHERE tenant_id = ? AND shift_id = ? AND type = 'in'`);
  const outs = q(`SELECT SUM(amount_cents) AS v FROM cash_movements WHERE tenant_id = ? AND shift_id = ? AND type = 'out'`);
  return s.opening_cents + cashSales + ins - outs;
}

export function shiftSummary(db, tenantId, shiftId) {
  const s = db.prepare('SELECT sh.*, u.name AS user_name FROM shifts sh JOIN users u ON u.id = sh.user_id WHERE sh.id = ? AND sh.tenant_id = ?').get(shiftId, tenantId);
  if (!s) throw new HttpError(404, 'Turno inexistente');
  const byMethod = db.prepare(`SELECT p.method, SUM(p.amount_cents) AS total FROM payments p JOIN sales s ON s.id = p.sale_id
                               WHERE s.tenant_id = ? AND s.shift_id = ? AND s.status = 'confirmed' GROUP BY p.method`).all(tenantId, shiftId);
  const movements = db.prepare('SELECT type, amount_cents AS amountCents, reason, ts FROM cash_movements WHERE tenant_id = ? AND shift_id = ? ORDER BY ts').all(tenantId, shiftId);
  return {
    id: s.id, user: s.user_name, registerId: s.register_id, status: s.status, openedAt: s.opened_at, closedAt: s.closed_at,
    openingCents: s.opening_cents, expectedCents: s.status === 'closed' ? s.expected_cents : expectedCash(db, tenantId, shiftId),
    countedCents: s.counted_cents, differenceCents: s.difference_cents,
    byMethod: Object.fromEntries(byMethod.map(r => [r.method, r.total])), movements,
  };
}

export function listShifts(db, session, limit = 30) {
  return db.prepare(`SELECT sh.id FROM shifts sh WHERE sh.tenant_id = ? ORDER BY sh.opened_at DESC LIMIT ?`)
    .all(session.tenantId, limit).map(r => shiftSummary(db, session.tenantId, r.id));
}
