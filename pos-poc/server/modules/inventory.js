// M5 Inventario y compras: ajustes, recuento y compra a proveedor.
// La compra actualiza costo (y opcionalmente precio respetando margen) — mismo
// punto de entrada que usará el OCR de facturas de F3.
import { HttpError, audit, requirePerm, notify } from '../core.js';
import { tx } from '../db.js';
import { addMovement, stockOf } from './catalog.js';
import { uuidv7 } from '../../public/lib/uuidv7.js';

function ownProduct(db, tenantId, id) {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!p) throw new HttpError(404, 'Producto inexistente');
  return p;
}

export function adjustStock(db, session, { productId, qty, countedQty, reason }) {
  requirePerm(session, 'inventory');
  const p = ownProduct(db, session.tenantId, productId);
  // Recuento físico: se informa lo contado y se registra la diferencia como ajuste.
  const delta = countedQty != null ? Number(countedQty) - stockOf(db, session.tenantId, productId) : Number(qty);
  if (!Number.isFinite(delta) || delta === 0) throw new HttpError(400, 'Sin diferencia para ajustar');
  tx(db, () => {
    addMovement(db, session, productId, 'adjust', delta, reason || (countedQty != null ? 'recuento' : 'ajuste'));
    audit(db, session, 'stock.adjust', 'product', productId, { delta, reason });
  });
  return { productId, stock: stockOf(db, session.tenantId, p.id) };
}

export function registerPurchase(db, session, { supplier, lines, updatePrices = false, targetMarginPct = null }) {
  requirePerm(session, 'inventory');
  if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, 'La compra no tiene líneas');
  const purchaseId = uuidv7();
  tx(db, () => {
    for (const l of lines) {
      const p = ownProduct(db, session.tenantId, l.productId);
      const qty = Number(l.qty);
      if (!(qty > 0)) throw new HttpError(400, `Cantidad inválida para ${p.name}`);
      addMovement(db, session, p.id, 'purchase', qty, `compra:${purchaseId}`);
      if (Number.isInteger(l.unitCostCents) && l.unitCostCents > 0) {
        let price = p.price_cents;
        if (updatePrices && targetMarginPct != null) price = Math.round(l.unitCostCents * (1 + targetMarginPct / 100));
        db.prepare('UPDATE products SET cost_cents = ?, price_cents = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
          .run(l.unitCostCents, price, new Date().toISOString(), p.id, session.tenantId);
      }
    }
    audit(db, session, 'purchase.create', 'purchase', purchaseId, { supplier, lines: lines.length });
  });
  return { purchaseId };
}

// Escucha "venta confirmada" para avisar stock bajo mínimo (evento → M16).
export function checkLowStock(db, tenantId, productIds) {
  for (const id of productIds) {
    const p = db.prepare('SELECT name, min_stock, type FROM products WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    if (!p || p.type === 'open' || !(p.min_stock > 0)) continue;
    const s = stockOf(db, tenantId, id);
    if (s <= p.min_stock) notify(db, tenantId, 'stock', `${p.name}: stock ${round(s)} (mínimo ${p.min_stock})${s < 0 ? ' — stock negativo, revisar' : ''}`);
  }
}

const round = n => Math.round(n * 1000) / 1000;
