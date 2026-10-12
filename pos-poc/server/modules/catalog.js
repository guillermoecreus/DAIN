// M2 Catálogo: productos por unidad, por peso y "monto libre"; varios códigos por producto.
// Precio con IVA incluido (comprobantes B/C). Variantes y combos quedan para F1 completo.
import { uuidv7 } from '../../public/lib/uuidv7.js';
import { HttpError, audit, requirePerm } from '../core.js';
import { nowIso, tx } from '../db.js';
import { assertWithinLimit } from './subscription.js';

const STOCK_SQL = '(SELECT COALESCE(SUM(qty), 0) FROM stock_movements m WHERE m.tenant_id = p.tenant_id AND m.product_id = p.id)';

export function listProducts(db, tenantId, { includeInactive = false } = {}) {
  const rows = db.prepare(`SELECT p.*, ${STOCK_SQL} AS stock FROM products p
                           WHERE p.tenant_id = ? ${includeInactive ? '' : 'AND p.active = 1'} ORDER BY p.name`).all(tenantId);
  const codes = db.prepare('SELECT code, product_id, kind FROM barcodes WHERE tenant_id = ?').all(tenantId);
  const byProduct = new Map();
  for (const c of codes) (byProduct.get(c.product_id) || byProduct.set(c.product_id, []).get(c.product_id)).push({ code: c.code, kind: c.kind });
  return rows.map(r => ({
    id: r.id, name: r.name, type: r.type, category: r.category, costCents: r.cost_cents, priceCents: r.price_cents,
    ivaRate: r.iva_rate, minStock: r.min_stock, active: !!r.active, stock: r.stock, updatedAt: r.updated_at,
    barcodes: byProduct.get(r.id) || [],
  }));
}

function validate(p) {
  if (!p.name || String(p.name).trim().length < 2) throw new HttpError(400, 'El nombre es obligatorio');
  if (!['unit', 'weight', 'open'].includes(p.type)) throw new HttpError(400, 'Tipo de producto inválido');
  for (const k of ['priceCents', 'costCents']) if (p[k] != null && (!Number.isInteger(p[k]) || p[k] < 0)) throw new HttpError(400, `${k} inválido`);
}

function setBarcodes(db, tenantId, productId, barcodes = []) {
  db.prepare('DELETE FROM barcodes WHERE tenant_id = ? AND product_id = ?').run(tenantId, productId);
  for (const b of barcodes) {
    const code = String(b.code || b).trim();
    if (!code) continue;
    const taken = db.prepare('SELECT product_id FROM barcodes WHERE tenant_id = ? AND code = ?').get(tenantId, code);
    if (taken) throw new HttpError(409, `El código ${code} ya pertenece a otro producto`);
    db.prepare('INSERT INTO barcodes (tenant_id, code, product_id, kind) VALUES (?, ?, ?, ?)').run(tenantId, code, productId, b.kind || 'ean');
  }
}

export function createProduct(db, session, p) {
  requirePerm(session, 'products');
  validate(p);
  assertWithinLimit(db, session.tenantId, 'products');
  const id = uuidv7();
  tx(db, () => {
    db.prepare(`INSERT INTO products (id, tenant_id, name, type, category, cost_cents, price_cents, iva_rate, min_stock, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, session.tenantId, p.name.trim(), p.type, p.category || null, p.costCents || 0, p.priceCents || 0, p.ivaRate ?? 21, p.minStock || 0, nowIso());
    setBarcodes(db, session.tenantId, id, p.barcodes);
    if (p.initialStock) addMovement(db, session, id, 'adjust', Number(p.initialStock), 'alta');
    audit(db, session, 'product.create', 'product', id, { name: p.name, priceCents: p.priceCents });
  });
  return { id };
}

export function updateProduct(db, session, id, p) {
  requirePerm(session, 'products');
  const cur = db.prepare('SELECT * FROM products WHERE id = ? AND tenant_id = ?').get(id, session.tenantId);
  if (!cur) throw new HttpError(404, 'Producto inexistente');
  const next = {
    name: p.name ?? cur.name, type: p.type ?? cur.type, category: p.category ?? cur.category,
    costCents: p.costCents ?? cur.cost_cents, priceCents: p.priceCents ?? cur.price_cents,
    minStock: p.minStock ?? cur.min_stock, active: p.active ?? !!cur.active,
  };
  validate(next);
  tx(db, () => {
    db.prepare(`UPDATE products SET name = ?, type = ?, category = ?, cost_cents = ?, price_cents = ?, min_stock = ?, active = ?, updated_at = ?
                WHERE id = ? AND tenant_id = ?`)
      .run(next.name, next.type, next.category, next.costCents, next.priceCents, next.minStock, next.active ? 1 : 0, nowIso(), id, session.tenantId);
    if (p.barcodes) setBarcodes(db, session.tenantId, id, p.barcodes);
    audit(db, session, 'product.update', 'product', id, { before: { priceCents: cur.price_cents, costCents: cur.cost_cents }, after: { priceCents: next.priceCents, costCents: next.costCents } });
  });
  return { id };
}

export function addMovement(db, session, productId, type, qty, refDoc, id = uuidv7(), ts = nowIso()) {
  db.prepare('INSERT OR IGNORE INTO stock_movements (id, tenant_id, product_id, type, qty, ref_doc, user_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, session.tenantId, productId, type, qty, refDoc ?? null, session.userId ?? null, ts);
}

export function stockOf(db, tenantId, productId) {
  return db.prepare('SELECT COALESCE(SUM(qty), 0) AS s FROM stock_movements WHERE tenant_id = ? AND product_id = ?').get(tenantId, productId).s;
}
