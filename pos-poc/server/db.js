// Persistencia de la PoC sobre SQLite embebido (node:sqlite).
// En producción el diseño pide PostgreSQL con row-level security; acá el
// aislamiento por tenant se aplica en la capa de repositorio (cada consulta de
// negocio filtra por tenant_id tomado de la sesión) y se prueba en test/.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL,
  max_products INTEGER NOT NULL, max_users INTEGER NOT NULL, features TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, cuit TEXT, iva_condition TEXT NOT NULL,
  rubro TEXT, plan_id TEXT NOT NULL REFERENCES plans(id), status TEXT NOT NULL DEFAULT 'trial',
  trial_ends_at TEXT, fiscal_enabled INTEGER NOT NULL DEFAULT 0, pos_number INTEGER NOT NULL DEFAULT 1,
  scale_config TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS registers (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, store_id TEXT NOT NULL, name TEXT NOT NULL, last_sync_at TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  role TEXT NOT NULL, password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('unit','weight','open')), category TEXT,
  cost_cents INTEGER NOT NULL DEFAULT 0, price_cents INTEGER NOT NULL DEFAULT 0,
  iva_rate REAL NOT NULL DEFAULT 21, min_stock REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_products_tenant ON products(tenant_id);
CREATE TABLE IF NOT EXISTS barcodes (
  tenant_id TEXT NOT NULL, code TEXT NOT NULL, product_id TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY (tenant_id, code)
);
-- Stock = suma de movimientos append-only; el nivel se proyecta en consulta.
CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, product_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('sale','void','purchase','adjust')),
  qty REAL NOT NULL, ref_doc TEXT, user_id TEXT, ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stock_product ON stock_movements(tenant_id, product_id);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT,
  doc_type TEXT, doc_number TEXT, iva_condition TEXT NOT NULL DEFAULT 'CF',
  credit_limit_cents INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
-- Cuenta corriente: saldo = suma; nunca se edita un asiento.
CREATE TABLE IF NOT EXISTS account_entries (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, customer_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('charge','payment','reversal')),
  amount_cents INTEGER NOT NULL, sale_id TEXT, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, register_id TEXT NOT NULL, user_id TEXT NOT NULL,
  opened_at TEXT NOT NULL, closed_at TEXT, opening_cents INTEGER NOT NULL,
  expected_cents INTEGER, counted_cents INTEGER, difference_cents INTEGER,
  status TEXT NOT NULL CHECK (status IN ('open','closed'))
);
CREATE TABLE IF NOT EXISTS cash_movements (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, shift_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('in','out')), amount_cents INTEGER NOT NULL,
  reason TEXT, user_id TEXT, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, register_id TEXT, shift_id TEXT,
  user_id TEXT, customer_id TEXT, total_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed','voided')),
  created_at TEXT NOT NULL, synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sales_tenant_date ON sales(tenant_id, created_at);
CREATE TABLE IF NOT EXISTS sale_lines (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sale_id TEXT NOT NULL, product_id TEXT,
  description TEXT NOT NULL, qty REAL NOT NULL, unit_price_cents INTEGER NOT NULL,
  unit_cost_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sale_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','card','mp','transfer','account')),
  amount_cents INTEGER NOT NULL, reference TEXT
);
CREATE TABLE IF NOT EXISTS fiscal_documents (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sale_id TEXT NOT NULL, kind TEXT NOT NULL,
  pos_number INTEGER NOT NULL, number INTEGER, cae TEXT, cae_due TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','authorized','rejected')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, error TEXT,
  quota_consumed INTEGER NOT NULL DEFAULT 0, related_doc_id TEXT, payload TEXT NOT NULL,
  created_at TEXT NOT NULL, authorized_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_fiscal_pending ON fiscal_documents(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS invoice_quota (
  tenant_id TEXT NOT NULL, period TEXT NOT NULL, quota INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period)
);
-- Registro de operaciones de sync ya aplicadas: base de la idempotencia.
CREATE TABLE IF NOT EXISTS processed_ops (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, register_id TEXT, type TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT, received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL,
  created_at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, data TEXT, device TEXT, ts TEXT NOT NULL
);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// Transacción simple: node:sqlite es sincrónico, así que no hay intercalado.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const nowIso = () => new Date().toISOString();
