// M8 Reportes y dashboard — solo lectura sobre ventas, pagos y stock.
// Incluye "productos sin rotación" (M14), que es una regla determinística y no
// necesita IA ni datos de otros comercios.
import { requirePerm } from '../core.js';

const TZ_OFFSET_H = -3; // Argentina (sin horario de verano)
const DAY = 864e5;

function range(from, to) {
  const t = to ? Date.parse(to) : Date.now();
  const f = from ? Date.parse(from) : t - DAY;
  return { from: new Date(f).toISOString(), to: new Date(t).toISOString(), ms: t - f };
}

function periodTotals(db, tenantId, from, to) {
  const s = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS total FROM sales
                        WHERE tenant_id = ? AND status = 'confirmed' AND created_at >= ? AND created_at < ?`).get(tenantId, from, to);
  const m = db.prepare(`SELECT COALESCE(SUM(l.total_cents - ROUND(l.unit_cost_cents * l.qty)), 0) AS margin FROM sale_lines l
                        JOIN sales s ON s.id = l.sale_id WHERE s.tenant_id = ? AND s.status = 'confirmed' AND s.created_at >= ? AND s.created_at < ?`).get(tenantId, from, to);
  return { salesCount: s.n, totalCents: s.total, avgTicketCents: s.n ? Math.round(s.total / s.n) : 0, marginCents: m.margin };
}

export function summary(db, session, q = {}) {
  requirePerm(session, 'reports');
  const t = session.tenantId;
  const { from, to, ms } = range(q.from, q.to);
  const prevFrom = new Date(Date.parse(from) - ms).toISOString();
  const cur = periodTotals(db, t, from, to);
  const prev = periodTotals(db, t, prevFrom, from);

  const sales = db.prepare(`SELECT created_at, total_cents FROM sales WHERE tenant_id = ? AND status = 'confirmed' AND created_at >= ? AND created_at < ?`).all(t, from, to);
  const byHour = Array(24).fill(0);
  for (const s of sales) byHour[(new Date(s.created_at).getUTCHours() + TZ_OFFSET_H + 24) % 24] += s.total_cents;

  const byMethod = db.prepare(`SELECT p.method, SUM(p.amount_cents) AS total FROM payments p JOIN sales s ON s.id = p.sale_id
                               WHERE s.tenant_id = ? AND s.status = 'confirmed' AND s.created_at >= ? AND s.created_at < ? GROUP BY p.method ORDER BY total DESC`).all(t, from, to);
  const products = db.prepare(`SELECT l.description AS name, SUM(l.qty) AS qty, SUM(l.total_cents) AS total,
                                      SUM(l.total_cents - ROUND(l.unit_cost_cents * l.qty)) AS margin
                               FROM sale_lines l JOIN sales s ON s.id = l.sale_id
                               WHERE s.tenant_id = ? AND s.status = 'confirmed' AND s.created_at >= ? AND s.created_at < ?
                               GROUP BY COALESCE(l.product_id, l.description) ORDER BY total DESC`).all(t, from, to);
  return {
    from, to, current: cur, previous: prev, byHour,
    byMethod: byMethod.map(r => ({ method: r.method, totalCents: r.total })),
    topProducts: products.slice(0, 5).map(shapeP),
    bottomProducts: products.length > 5 ? products.slice(-5).reverse().map(shapeP) : [],
    noRotation: noRotation(db, t, 30),
  };
}

const shapeP = r => ({ name: r.name, qty: Math.round(r.qty * 1000) / 1000, totalCents: r.total, marginCents: r.margin });

export function noRotation(db, tenantId, days = 30) {
  const since = new Date(Date.now() - days * DAY).toISOString();
  return db.prepare(`SELECT p.name, p.cost_cents, st.stock FROM products p
                     JOIN (SELECT product_id, SUM(qty) AS stock FROM stock_movements WHERE tenant_id = ? GROUP BY product_id) st ON st.product_id = p.id
                     WHERE p.tenant_id = ? AND p.active = 1 AND st.stock > 0
                       AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id = p.tenant_id AND m.product_id = p.id AND m.type = 'sale' AND m.ts >= ?)
                     ORDER BY p.cost_cents * st.stock DESC LIMIT 20`).all(tenantId, tenantId, since)
    .map(r => ({ name: r.name, stock: r.stock, valueAtCostCents: Math.round(r.cost_cents * r.stock) }));
}

export function salesCsv(db, session, q = {}) {
  requirePerm(session, 'reports');
  const { from, to } = range(q.from, q.to);
  const rows = db.prepare(`SELECT s.created_at, s.id, u.name AS user, l.description, l.qty, l.unit_price_cents, l.total_cents, l.unit_cost_cents
                           FROM sales s JOIN sale_lines l ON l.sale_id = s.id LEFT JOIN users u ON u.id = s.user_id
                           WHERE s.tenant_id = ? AND s.status = 'confirmed' AND s.created_at >= ? AND s.created_at < ? ORDER BY s.created_at`).all(session.tenantId, from, to);
  const esc = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const head = 'fecha;venta;usuario;producto;cantidad;precio_unitario;total;costo_unitario';
  return [head, ...rows.map(r => [r.created_at, r.id, r.user, r.description, r.qty, r.unit_price_cents / 100, r.total_cents / 100, r.unit_cost_cents / 100].map(esc).join(';'))].join('\n');
}

export function recentSales(db, session, limit = 50) {
  requirePerm(session, 'sell');
  return db.prepare(`SELECT s.id, s.created_at AS createdAt, s.total_cents AS totalCents, s.status, s.customer_id AS customerId, u.name AS user,
                            (SELECT status FROM fiscal_documents f WHERE f.sale_id = s.id AND f.kind IN ('FA','FB','FC')) AS fiscalStatus
                     FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT ?`).all(session.tenantId, limit);
}
