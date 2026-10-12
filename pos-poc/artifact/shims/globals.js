// Globales de Node que usa el código del servidor, para correrlo en el navegador.
export class Buffer extends Uint8Array {
  static from(v, enc) {
    if (typeof v !== 'string') return new Buffer(v);
    if (enc === 'hex') return new Buffer((v.match(/../g) || []).map(h => parseInt(h, 16)));
    return new Buffer(new TextEncoder().encode(v));
  }
  static concat(list) {
    const out = new Buffer(list.reduce((a, b) => a + b.length, 0));
    let o = 0;
    for (const b of list) { out.set(b, o); o += b.length; }
    return out;
  }
  toString(enc) {
    if (enc === 'hex') return [...this].map(b => b.toString(16).padStart(2, '0')).join('');
    if (enc === 'base64' || enc === 'base64url') {
      let bin = '';
      for (const b of this) bin += String.fromCharCode(b);
      const b64 = btoa(bin);
      return enc === 'base64' ? b64 : b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return new TextDecoder().decode(this);
  }
}
export const process = { env: {}, argv: [] };
