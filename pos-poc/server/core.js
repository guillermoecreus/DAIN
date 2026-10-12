// Piezas transversales: errores, bus de eventos in-process, roles, auditoría, avisos.
import { EventEmitter } from 'node:events';
import { uuidv7 } from '../public/lib/uuidv7.js';
import { nowIso } from './db.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Bus in-process: los módulos se comunican por eventos de dominio, no por tablas
// ajenas. Es el punto donde un módulo (Fiscal, IA) se separaría a servicio propio.
export function createBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  return bus;
}

// 4 roles semilla (M1). Permisos editables en el diseño; fijos en la PoC.
export const ROLE_PERMISSIONS = {
  owner: ['*'],
  manager: ['sell', 'cash', 'customers', 'customers.view', 'products', 'inventory', 'reports', 'fiscal', 'audit', 'void'],
  employee: ['sell', 'cash', 'customers', 'customers.view', 'products', 'inventory'],
  cashier: ['sell', 'cash', 'customers.view'],
};

export function can(role, perm) {
  const p = ROLE_PERMISSIONS[role] || [];
  return p.includes('*') || p.includes(perm);
}

export function requirePerm(session, perm) {
  if (!can(session.role, perm)) throw new HttpError(403, `Tu rol (${session.role}) no permite: ${perm}`);
}

export function audit(db, session, action, entity, entityId, data, device) {
  db.prepare(`INSERT INTO audit_log (id, tenant_id, user_id, action, entity, entity_id, data, device, ts)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuidv7(), session.tenantId, session.userId ?? null, action, entity ?? null, entityId ?? null,
      data ? JSON.stringify(data) : null, device ?? null, nowIso());
}

export function notify(db, tenantId, kind, message) {
  db.prepare('INSERT INTO notifications (id, tenant_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuidv7(), tenantId, kind, message, nowIso());
}
