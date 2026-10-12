import { notify } from '../core.js';
import { ars } from '../../public/lib/money.js';

// M16 Notificaciones: en la PoC solo avisos dentro de la app. Email y WhatsApp
// Business quedan detrás del mismo punto (los recordatorios de deuda usan wa.me).
export function registerNotificationListeners(ctx, { checkLowStock }) {
  const { db, bus } = ctx;
  bus.on('sale.confirmed', ({ tenantId, productIds }) => checkLowStock(db, tenantId, productIds));
  bus.on('shift.closed', ({ tenantId, differenceCents, userName }) => {
    if (differenceCents !== 0) notify(db, tenantId, 'caja', `Cierre de caja de ${userName} con diferencia de ${ars(differenceCents)}`);
  });
}

export function listNotifications(db, session) {
  return db.prepare('SELECT id, kind, message, created_at AS createdAt, read FROM notifications WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100').all(session.tenantId);
}

export function markAllRead(db, session) {
  db.prepare('UPDATE notifications SET read = 1 WHERE tenant_id = ?').run(session.tenantId);
}
