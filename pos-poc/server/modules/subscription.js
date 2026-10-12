// M13 Suscripción SaaS: planes, trial y límites por plan. El cobro recurrente
// (Mercado Pago / Rebill vía webhooks) queda fuera de la PoC.
import { HttpError } from '../core.js';
import { nowIso } from '../db.js';

export const PLANS = [
  { id: 'esencial', name: 'Esencial', price_cents: 1480000, max_products: 3500, max_users: 2, features: ['pos', 'stock', 'reports', 'accounts'] },
  { id: 'pro', name: 'Pro', price_cents: 2280000, max_products: 10000, max_users: 5, features: ['pos', 'stock', 'reports', 'accounts', 'storefront', 'scales'] },
  { id: 'ia', name: 'IA', price_cents: 2560000, max_products: 15000, max_users: 7, features: ['pos', 'stock', 'reports', 'accounts', 'storefront', 'scales', 'ai'] },
];

function plan(db, tenantId) {
  return db.prepare('SELECT p.* , t.status, t.trial_ends_at FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = ?').get(tenantId);
}

export function assertWithinLimit(db, tenantId, what) {
  const p = plan(db, tenantId);
  if (what === 'products') {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM products WHERE tenant_id = ? AND active = 1').get(tenantId);
    if (n >= p.max_products) throw new HttpError(402, `Tu plan ${p.name} permite hasta ${p.max_products} productos`);
  } else if (what === 'users') {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?').get(tenantId);
    if (n >= p.max_users) throw new HttpError(402, `Tu plan ${p.name} permite hasta ${p.max_users} usuarios`);
  }
}

export function hasFeature(db, tenantId, feature) {
  return JSON.parse(plan(db, tenantId).features).includes(feature);
}

export function subscriptionStatus(db, tenantId) {
  const p = plan(db, tenantId);
  const products = db.prepare('SELECT COUNT(*) AS n FROM products WHERE tenant_id = ? AND active = 1').get(tenantId).n;
  const users = db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?').get(tenantId).n;
  const trialDaysLeft = p.trial_ends_at ? Math.max(0, Math.ceil((Date.parse(p.trial_ends_at) - Date.parse(nowIso())) / 864e5)) : null;
  return {
    plan: p.name, priceCents: p.price_cents, status: p.status, trialDaysLeft,
    usage: { products, maxProducts: p.max_products, users, maxUsers: p.max_users },
    plans: PLANS.map(x => ({ id: x.id, name: x.name, priceCents: x.price_cents, maxProducts: x.max_products, maxUsers: x.max_users })),
  };
}
