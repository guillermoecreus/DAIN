// M1 Plataforma y tenancy: login, sesiones, usuarios y configuración del comercio.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from '../../public/lib/uuidv7.js';
import { DEFAULT_SCALE } from '../../public/lib/scale.js';
import { HttpError, audit, requirePerm, ROLE_PERMISSIONS } from '../core.js';
import { nowIso } from '../db.js';
import { assertWithinLimit } from './subscription.js';

const SESSION_HOURS = 12;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 32).toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const got = scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

export function login(db, { email, password }) {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!u || !verifyPassword(String(password || ''), u.password_hash)) throw new HttpError(401, 'Email o contraseña incorrectos');
  const token = randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, tenant_id, expires_at) VALUES (?, ?, ?, ?)').run(token, u.id, u.tenant_id, expires);
  audit(db, { tenantId: u.tenant_id, userId: u.id }, 'login', 'user', u.id);
  return { token, expiresAt: expires };
}

export function logout(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// La sesión es la única fuente del tenant_id: nunca se toma del cuerpo del request.
export function sessionFromToken(db, token) {
  if (!token) return null;
  const s = db.prepare(`SELECT s.token, s.expires_at, u.id AS userId, u.tenant_id AS tenantId, u.role, u.name, u.email
                        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!s || s.expires_at < nowIso()) return null;
  return s;
}

export function tenantConfig(db, tenantId) {
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(t.plan_id);
  return {
    id: t.id, name: t.name, cuit: t.cuit, ivaCondition: t.iva_condition, rubro: t.rubro,
    status: t.status, trialEndsAt: t.trial_ends_at, fiscalEnabled: !!t.fiscal_enabled, posNumber: t.pos_number,
    scale: t.scale_config ? JSON.parse(t.scale_config) : DEFAULT_SCALE,
    plan: { id: plan.id, name: plan.name, maxProducts: plan.max_products, maxUsers: plan.max_users, features: JSON.parse(plan.features) },
  };
}

export function me(db, session) {
  const registers = db.prepare('SELECT id, name FROM registers WHERE tenant_id = ? ORDER BY name').all(session.tenantId);
  return {
    user: { id: session.userId, name: session.name, email: session.email, role: session.role, permissions: ROLE_PERMISSIONS[session.role] },
    tenant: tenantConfig(db, session.tenantId),
    registers,
  };
}

export function listUsers(db, session) {
  requirePerm(session, 'users');
  return db.prepare('SELECT id, email, name, role FROM users WHERE tenant_id = ? ORDER BY name').all(session.tenantId);
}

export function createUser(db, session, { email, name, role, password }) {
  requirePerm(session, 'users');
  if (!ROLE_PERMISSIONS[role] || role === 'owner') throw new HttpError(400, 'Rol inválido');
  if (!email || !name || !password || password.length < 8) throw new HttpError(400, 'Email, nombre y contraseña (8+) obligatorios');
  assertWithinLimit(db, session.tenantId, 'users');
  const id = uuidv7();
  try {
    db.prepare('INSERT INTO users (id, tenant_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, session.tenantId, email.toLowerCase(), name, role, hashPassword(password));
  } catch { throw new HttpError(409, 'Ese email ya está registrado'); }
  audit(db, session, 'user.create', 'user', id, { email, role });
  return { id };
}
