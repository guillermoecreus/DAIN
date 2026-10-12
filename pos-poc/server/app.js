// Monolito modular: un proceso, módulos dueños de sus tablas, comunicación por
// eventos y puertos para lo externo (fiscal). Sin framework: node:http alcanza.
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { HttpError, createBus, requirePerm } from './core.js';
import * as platform from './modules/platform.js';
import * as catalog from './modules/catalog.js';
import * as inventory from './modules/inventory.js';
import * as customers from './modules/customers.js';
import * as cash from './modules/cash.js';
import * as sync from './modules/sync.js';
import * as fiscal from './modules/fiscal.js';
import * as reports from './modules/reports.js';
import * as notifications from './modules/notifications.js';
import { subscriptionStatus } from './modules/subscription.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createApp({ dbFile = ':memory:', fiscalAdapter = new fiscal.MockIntegratorAdapter() } = {}) {
  const db = openDb(dbFile);
  const ctx = { db, bus: createBus(), fiscalAdapter };
  fiscal.registerFiscalListeners(ctx);
  notifications.registerNotificationListeners(ctx, { checkLowStock: inventory.checkLowStock });

  // Tabla de rutas: [método, patrón, handler(session, body, params, query), opciones]
  const routes = [
    ['POST', '/api/auth/login', (s, b) => platform.login(db, b), { public: true }],
    ['POST', '/api/auth/logout', (s, b, p, q, token) => platform.logout(db, token)],
    ['GET', '/api/me', s => platform.me(db, s)],
    ['GET', '/api/health', () => ({ ok: true }), { public: true }],

    ['GET', '/api/sync/pull', (s, b, p, q) => pull(s, q.registerId)],
    ['POST', '/api/sync/push', (s, b) => sync.pushOps(ctx, s, b)],

    ['GET', '/api/products', s => catalog.listProducts(db, s.tenantId, { includeInactive: true })],
    ['POST', '/api/products', (s, b) => catalog.createProduct(db, s, b)],
    ['PUT', '/api/products/:id', (s, b, p) => catalog.updateProduct(db, s, p.id, b)],
    ['POST', '/api/inventory/adjust', (s, b) => inventory.adjustStock(db, s, b)],
    ['POST', '/api/inventory/purchases', (s, b) => inventory.registerPurchase(db, s, b)],

    ['GET', '/api/customers', s => customers.listCustomers(db, s)],
    ['POST', '/api/customers', (s, b) => customers.createCustomer(db, s, b)],
    ['GET', '/api/customers/:id', (s, b, p) => customers.statement(db, s, p.id)],

    ['GET', '/api/shifts', s => { requirePerm(s, 'cash'); return cash.listShifts(db, s); }],
    ['GET', '/api/shifts/:id', (s, b, p) => { requirePerm(s, 'cash'); return cash.shiftSummary(db, s.tenantId, p.id); }],
    ['GET', '/api/sales', s => reports.recentSales(db, s)],
    ['GET', '/api/sales/:id/fiscal', (s, b, p) => fiscal.docsForSale(db, s, p.id)],

    ['GET', '/api/reports/summary', (s, b, p, q) => reports.summary(db, s, q)],
    ['GET', '/api/reports/sales.csv', (s, b, p, q) => ({ csv: reports.salesCsv(db, s, q) })],

    ['GET', '/api/fiscal', (s, b, p, q) => fiscal.listFiscalDocs(db, s, q)],
    ['POST', '/api/fiscal/:id/retry', (s, b, p) => fiscal.retryDoc(db, s, p.id)],

    ['GET', '/api/notifications', s => notifications.listNotifications(db, s)],
    ['POST', '/api/notifications/read', s => notifications.markAllRead(db, s)],
    ['GET', '/api/subscription', s => subscriptionStatus(db, s.tenantId)],
    ['GET', '/api/users', s => platform.listUsers(db, s)],
    ['POST', '/api/users', (s, b) => platform.createUser(db, s, b)],
    ['GET', '/api/audit', s => { requirePerm(s, 'audit'); return db.prepare(`SELECT a.ts, u.name AS user, a.action, a.entity, a.entity_id AS entityId, a.data, a.device
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.tenant_id = ? ORDER BY a.ts DESC LIMIT 200`).all(s.tenantId); }],
  ].map(([method, pattern, fn, opts = {}]) => ({ method, fn, opts, keys: [...pattern.matchAll(/:(\w+)/g)].map(m => m[1]),
    re: new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$') }));

  // Lo que la caja necesita para vender sin red: catálogo, clientes, configuración y su turno.
  function pull(session, registerId) {
    requirePerm(session, 'sell');
    const reg = db.prepare('SELECT id FROM registers WHERE id = ? AND tenant_id = ?').get(registerId, session.tenantId);
    if (!reg) throw new HttpError(400, 'Caja inexistente para este comercio');
    const shift = db.prepare(`SELECT id FROM shifts WHERE tenant_id = ? AND register_id = ? AND user_id = ? AND status = 'open'`).get(session.tenantId, registerId, session.userId);
    return {
      serverTime: new Date().toISOString(),
      tenant: platform.tenantConfig(db, session.tenantId),
      products: catalog.listProducts(db, session.tenantId),
      customers: customers.listCustomers(db, session),
      openShift: shift ? cash.shiftSummary(db, session.tenantId, shift.id) : null,
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    try {
      if (!url.pathname.startsWith('/api/')) return await serveStatic(url.pathname, res);
      const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!route) throw new HttpError(404, 'Ruta inexistente');
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(route.re)[i + 1])]));
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const session = platform.sessionFromToken(db, token);
      if (!route.opts.public && !session) throw new HttpError(401, 'Sesión vencida o inexistente');
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
      const out = await route.fn(session, body, params, Object.fromEntries(url.searchParams), token);
      send(res, 200, out ?? { ok: true });
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Error interno' });
    }
  }

  return { ctx, handle, close: () => db.close() };
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, 'Cuerpo demasiado grande');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido'); }
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) throw new HttpError(404, 'No encontrado');
  let data;
  try { data = await readFile(file); } catch { throw new HttpError(404, 'No encontrado'); }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  });
  res.end(data);
}
