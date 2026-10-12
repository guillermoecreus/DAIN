import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setup } from './helpers.js';

describe('API HTTP', () => {
  let server, base, t;
  before(async () => {
    t = setup();
    server = createServer(t.app.handle);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const call = async (path, { token, method = 'GET', body } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, data: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
  };

  test('sin sesión responde 401; login inválido 401', async () => {
    assert.equal((await call('/api/products')).status, 401);
    assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'dueno@demo.ar', password: 'mal' } })).status, 401);
  });

  test('login, pull de la caja y reporte', async () => {
    const { data: { token } } = await call('/api/auth/login', { method: 'POST', body: { email: 'dueno@demo.ar', password: 'demo1234' } });
    const me = await call('/api/me', { token });
    assert.equal(me.data.tenant.name, 'Kiosco La Esquina');
    const pull = await call(`/api/sync/pull?registerId=${me.data.registers[0].id}`, { token });
    assert.ok(pull.data.products.length >= 15);
    const rep = await call('/api/reports/summary?from=' + new Date(Date.now() - 7 * 864e5).toISOString(), { token });
    assert.ok(rep.data.current.salesCount > 0);
    assert.ok(rep.data.noRotation.some(p => p.name === 'Cargador USB'));
  });

  test('el cajero no ve reportes', async () => {
    const { data: { token } } = await call('/api/auth/login', { method: 'POST', body: { email: 'cajero@demo.ar', password: 'demo1234' } });
    assert.equal((await call('/api/reports/summary', { token })).status, 403);
  });

  test('estáticos: sirve la app y bloquea path traversal', async () => {
    const home = await call('/');
    assert.equal(home.status, 200);
    assert.match(home.data, /<title>/);
    assert.equal((await call('/..%2fserver%2fdb.js')).status, 404);
  });
});
