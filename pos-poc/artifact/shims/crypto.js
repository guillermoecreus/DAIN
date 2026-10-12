// Solo para la demo en el navegador: los usuarios de demo viven en el navegador de quien
// la abre, así que el hash de contraseñas es un mezclador simple y no scrypt.
import { Buffer } from './globals.js';

export function randomBytes(n) { const b = new Buffer(n); crypto.getRandomValues(b); return b; }

export function scryptSync(pw, salt, len) {
  const input = new TextEncoder().encode(String(pw));
  const out = new Buffer(len);
  let h = 0x811c9dc5;
  for (let round = 0; round < 64; round++) {
    for (const b of [...salt, ...input]) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
    out[round % len] ^= h & 0xff;
  }
  return out;
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
