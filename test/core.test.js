import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSerializableState } from '../js/storage.js';
import { buildPriceStore, getPrice } from '../js/prices.js';
import { daysBetween, parseNumber, transactionPriority } from '../js/utils.js';

test('normalises Portuguese and international number formats', () => {
  assert.equal(parseNumber('1.234,56 €'), 1234.56);
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('nan'), 0);
});

test('orders acquisitions before disposals and counts whole days', () => {
  assert.ok(transactionPriority('buy_fiat') < transactionPriority('sell_fiat'));
  assert.equal(daysBetween('2024-01-01', '2024-01-08'), 7);
});

test('finds an exact or nearby price within the allowed window', () => {
  const store = buildPriceStore([
    { asset: 'btc', date: '2024-01-01', price_eur: 40000, source: 'test' },
  ]);
  assert.equal(getPrice(store, 'BTC', '2024-01-01'), 40000);
  assert.equal(getPrice(store, 'BTC', '2024-01-03', 3), 40000);
  assert.equal(getPrice(store, 'BTC', '2024-01-10', 3), null);
});

test('never serialises a CoinGecko API key', () => {
  const output = buildSerializableState({
    settings: { taxYear: 2026, coinGeckoApiKey: 'sensitive-value' },
    queueFiles: [],
  });
  assert.equal(output.settings.coinGeckoApiKey, '');
  assert.doesNotMatch(JSON.stringify(output), /sensitive-value/);
});
