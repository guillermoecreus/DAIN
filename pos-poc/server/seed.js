// Datos de demo: dos comercios (para ver el aislamiento) y 14 días de ventas
// generadas con el mismo sync que usa la caja, para que reportes y caja tengan historia.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '../public/lib/uuidv7.js';
import { ean13CheckDigit } from '../public/lib/scale.js';
import { nowIso } from './db.js';
import { hashPassword } from './modules/platform.js';
import { PLANS } from './modules/subscription.js';
import { pushOps } from './modules/sync.js';
import { expectedCash } from './modules/cash.js';

const ean = n => { const b = '779' + String(n).padStart(9, '0'); return b + ean13CheckDigit(b); };

const KIOSCO = [
  // nombre, categoría, costo, precio, stock, mínimo, ventas/día (peso relativo)
  ['Coca-Cola 500 ml', 'Bebidas', 900, 1500, 48, 12, 9],
  ['Agua mineral 500 ml', 'Bebidas', 450, 900, 36, 12, 6],
  ['Cerveza lata 473 ml', 'Bebidas', 1100, 1900, 30, 12, 5],
  ['Alfajor triple chocolate', 'Golosinas', 500, 950, 60, 20, 10],
  ['Chicles menta x10', 'Golosinas', 250, 500, 40, 10, 4],
  ['Turrón de maní', 'Golosinas', 180, 350, 50, 10, 4],
  ['Galletitas dulces 300 g', 'Almacén', 900, 1600, 20, 6, 3],
  ['Papas fritas 150 g', 'Snacks', 1300, 2300, 18, 6, 4],
  ['Yerba mate 1 kg', 'Almacén', 2900, 4300, 15, 5, 2],
  ['Leche entera 1 L', 'Lácteos', 950, 1400, 24, 8, 5],
  ['Pan lactal grande', 'Almacén', 1700, 2600, 10, 4, 2],
  ['Encendedor', 'Varios', 400, 900, 25, 5, 1],
  ['Pilas AA x2', 'Varios', 1500, 2900, 12, 4, 0.5],
  ['Cargador USB', 'Varios', 3500, 7900, 6, 2, 0],          // sin rotación
  ['Paraguas plegable', 'Varios', 5200, 11900, 4, 1, 0],     // sin rotación
];
const WEIGHED = [['Queso cremoso (kg)', '00123', 6900, 11500, 8], ['Jamón cocido (kg)', '00124', 8200, 14900, 6]];

export function seed(ctx) {
  const { db } = ctx;
  const now = nowIso();
  for (const p of PLANS) db.prepare('INSERT OR IGNORE INTO plans (id, name, price_cents, max_products, max_users, features) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.id, p.name, p.price_cents, p.max_products, p.max_users, JSON.stringify(p.features));

  const trialEnd = new Date(Date.now() + 7 * 864e5).toISOString();
  const tenant = (id, name, cuit, iva, rubro, plan) => {
    db.prepare(`INSERT INTO tenants (id, name, cuit, iva_condition, rubro, plan_id, status, trial_ends_at, fiscal_enabled, pos_number, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'trial', ?, 0, 3, ?)`).run(id, name, cuit, iva, rubro, plan, trialEnd, now);
    const store = uuidv7();
    db.prepare('INSERT INTO stores (id, tenant_id, name) VALUES (?, ?, ?)').run(store, id, 'Local');
    const reg = uuidv7();
    db.prepare('INSERT INTO registers (id, tenant_id, store_id, name) VALUES (?, ?, ?, ?)').run(reg, id, store, 'Caja 1');
    return reg;
  };
  const user = (tenantId, email, name, role) => {
    const id = uuidv7();
    db.prepare('INSERT INTO users (id, tenant_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)').run(id, tenantId, email, name, role, hashPassword('demo1234'));
    return { userId: id, tenantId, role, name };
  };
  const product = (tenantId, name, type, category, cost, price, min, codes) => {
    const id = uuidv7();
    db.prepare(`INSERT INTO products (id, tenant_id, name, type, category, cost_cents, price_cents, min_stock, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, name, type, category, cost, price, min, now);
    for (const [code, kind] of codes) db.prepare('INSERT INTO barcodes (tenant_id, code, product_id, kind) VALUES (?, ?, ?, ?)').run(tenantId, code, id, kind);
    return id;
  };
  const stockIn = (tenantId, productId, qty, ts) => db.prepare(`INSERT INTO stock_movements (id, tenant_id, product_id, type, qty, ref_doc, ts) VALUES (?, ?, ?, 'purchase', ?, 'stock inicial', ?)`)
    .run(uuidv7(), tenantId, productId, qty, ts);

  // --- Comercio 1: kiosco, Responsable Inscripto, plan IA, factura electrónica
  const T1 = uuidv7();
  const reg1 = tenant(T1, 'Kiosco La Esquina', '20111111112', 'RI', 'kiosco', 'ia');
  const owner = user(T1, 'dueno@demo.ar', 'Laura (dueña)', 'owner');
  user(T1, 'cajero@demo.ar', 'Martín (cajero)', 'cashier');
  const longAgo = new Date(Date.now() - 40 * 864e5).toISOString();
  const items = KIOSCO.map(([name, cat, cost, price, stock, min, w], i) => {
    const id = product(T1, name, 'unit', cat, cost * 100, price * 100, min, [[ean(1000 + i), 'ean']]);
    stockIn(T1, id, stock + Math.round(w * 22), longAgo);
    return { id, name, cost: cost * 100, price: price * 100, w, type: 'unit' };
  });
  for (const [name, plu, cost, price, stock] of WEIGHED) {
    const id = product(T1, name, 'weight', 'Fiambrería', cost * 100, price * 100, 1, [[plu, 'plu']]);
    stockIn(T1, id, stock + 14, longAgo);
    items.push({ id, name, cost: cost * 100, price: price * 100, w: 2, type: 'weight' });
  }
  product(T1, 'Varios (monto libre)', 'open', 'Varios', 0, 0, 0, []);

  const customers = [
    ['Rosa Gómez', '5491155550001', null, 'CF', 3000000],
    ['Carlos Pérez', '5491155550002', '27333444', 'CF', 1500000],
    ['Distribuidora Norte SRL', '5491155550003', '30711111119', 'RI', 0],
  ].map(([name, phone, doc, iva, limit]) => {
    const id = uuidv7();
    db.prepare(`INSERT INTO customers (id, tenant_id, name, phone, doc_type, doc_number, iva_condition, credit_limit_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, T1, name, phone, doc ? (doc.length === 11 ? 'CUIT' : 'DNI') : null, doc, iva, limit, now);
    return id;
  });

  history(ctx, { ...owner, registerId: reg1 }, items, customers);
  db.prepare('UPDATE tenants SET fiscal_enabled = 1 WHERE id = ?').run(T1);

  // --- Comercio 2: almacén monotributista, plan Esencial (solo para probar aislamiento)
  const T2 = uuidv7();
  tenant(T2, 'Almacén Don Pepe', '20222222223', 'MONOTRIBUTO', 'almacen', 'esencial');
  user(T2, 'almacen@demo.ar', 'Pepe (dueño)', 'owner');
  const fideos = product(T2, 'Fideos 500 g', 'unit', 'Almacén', 90000, 140000, 5, [[ean(5000), 'ean']]);
  stockIn(T2, fideos, 30, longAgo);
  db.prepare('UPDATE tenants SET fiscal_enabled = 1 WHERE id = ?').run(T2);
}

// 14 días de turnos y ventas, aplicados por el mismo pushOps que usa la caja.
function history(ctx, session, items, customers) {
  let seedN = 7;
  const rnd = () => ((seedN = (seedN * 16807) % 2147483647) / 2147483647);
  const pickItem = () => { const tot = items.reduce((a, x) => a + x.w, 0); let r = rnd() * tot; for (const x of items) if ((r -= x.w) <= 0) return x; return items[0]; };
  const day0 = new Date(); day0.setUTCHours(11, 0, 0, 0); // 8:00 en Argentina
  for (let d = 14; d >= 1; d--) {
    const open = new Date(day0.getTime() - d * 864e5);
    const shiftId = uuidv7(open.getTime());
    const ops = [{ id: uuidv7(open.getTime()), type: 'shift.open', payload: { shiftId, openingCents: 1000000, openedAt: open.toISOString() } }];
    const n = 18 + Math.floor(rnd() * 14);
    for (let i = 0; i < n; i++) {
      const at = new Date(open.getTime() + (0.3 + rnd() * 12.5) * 3600e3);
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
        const it = pickItem();
        const qty = it.type === 'weight' ? Math.round((0.15 + rnd() * 0.5) * 1000) / 1000 : 1 + Math.floor(rnd() * 2);
        return { id: uuidv7(at.getTime()), productId: it.id, description: it.name, qty, unitPriceCents: it.price, unitCostCents: it.cost };
      });
      const total = lines.reduce((a, l) => a + Math.round(l.unitPriceCents * l.qty), 0);
      const r = rnd();
      const method = r < 0.5 ? 'cash' : r < 0.75 ? 'mp' : r < 0.9 ? 'card' : r < 0.95 ? 'transfer' : 'account';
      const customerId = method === 'account' ? customers[Math.floor(rnd() * 2)] : null;
      ops.push({ id: uuidv7(at.getTime()), type: 'sale', payload: { id: uuidv7(at.getTime()), shiftId, customerId, createdAt: at.toISOString(), lines,
        payments: [{ id: uuidv7(at.getTime()), method, amountCents: total }] } });
    }
    const res = pushOps(ctx, session, { registerId: session.registerId, ops });
    if (res.results.some(r => r.status === 'error')) throw new Error('seed: ' + JSON.stringify(res.results.find(r => r.status === 'error')));
    // Cierre: lo contado coincide con lo esperado, salvo algún día con faltante.
    const close = new Date(open.getTime() + 13 * 3600e3);
    const countedCents = expectedCash(ctx.db, session.tenantId, shiftId) - (d % 5 === 0 ? 50000 : 0);
    pushOps(ctx, session, { registerId: session.registerId, ops: [{ id: uuidv7(close.getTime()), type: 'shift.close', payload: { shiftId, countedCents, closedAt: close.toISOString() } }] });
  }
  ctx.db.prepare('DELETE FROM notifications').run(); // los avisos del historial no aportan a la demo
}

// `npm run reset`: borra la base local y la recrea con datos de demo.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--reset')) {
  const file = process.env.DB_FILE || fileURLToPath(new URL('../data/pos.db', import.meta.url));
  for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  const { createApp } = await import('./app.js');
  const app = createApp({ dbFile: file });
  seed(app.ctx);
  app.close();
  console.log('Base recreada con datos de demo:', file);
}
