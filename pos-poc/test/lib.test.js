import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7, isUuid } from '../public/lib/uuidv7.js';
import { decodeScaleBarcode, encodeScaleBarcode, isValidEan13, DEFAULT_SCALE } from '../public/lib/scale.js';
import { agingOf } from '../server/modules/customers.js';
import { invoiceKind } from '../server/modules/fiscal.js';

test('UUID v7: formato válido y orden por tiempo', () => {
  const a = uuidv7(1_700_000_000_000), b = uuidv7(1_700_000_000_001);
  assert.ok(isUuid(a) && a[14] === '7');
  assert.ok(a < b);
});

test('balanza: decodifica peso embebido y valida dígito verificador', () => {
  const code = encodeScaleBarcode('00123', 0.755);
  assert.ok(isValidEan13(code));
  assert.deepEqual(decodeScaleBarcode(code), { plu: '00123', weightKg: 0.755 });
  const bad = code.slice(0, 12) + ((Number(code[12]) + 1) % 10);
  assert.equal(decodeScaleBarcode(bad), null);
  assert.equal(decodeScaleBarcode('7790000010007'), null); // EAN común, no es de balanza
});

test('balanza: variante con importe embebido', () => {
  const cfg = { ...DEFAULT_SCALE, valueType: 'price', valueDecimals: 0 };
  const code = encodeScaleBarcode('00999', 4520, cfg);
  assert.deepEqual(decodeScaleBarcode(code, cfg), { plu: '00999', priceCents: 452000 });
});

test('cuenta corriente: pagos aplicados FIFO y antigüedad del cargo más viejo abierto', () => {
  const day = d => new Date(Date.UTC(2026, 9, d)).toISOString();
  const entries = [
    { type: 'charge', amount_cents: 1000, ts: day(1), sale_id: 'a' },
    { type: 'charge', amount_cents: 500, ts: day(5), sale_id: 'b' },
    { type: 'payment', amount_cents: 1200, ts: day(6) },
  ];
  const r = agingOf(entries, Date.UTC(2026, 9, 11));
  assert.equal(r.balanceCents, 300);
  assert.equal(r.oldestDebtDays, 6); // el cargo del día 1 quedó saldado; el abierto es el del día 5
  const withReversal = agingOf([...entries, { type: 'reversal', amount_cents: 500, ts: day(7), sale_id: 'b' }], Date.UTC(2026, 9, 11));
  assert.equal(withReversal.balanceCents, -200); // saldo a favor
});

test('tipo de comprobante: A, B o C según emisor y receptor', () => {
  assert.equal(invoiceKind('MONOTRIBUTO', { iva_condition: 'RI', doc_number: '30711111119' }), 'FC');
  assert.equal(invoiceKind('RI', { iva_condition: 'RI', doc_number: '30711111119' }), 'FA');
  assert.equal(invoiceKind('RI', { iva_condition: 'CF', doc_number: '27333444' }), 'FB');
  assert.equal(invoiceKind('RI', null), 'FB');
});
