
import { daysBetween, round } from './utils.js';

export function buildPriceKey(asset, date) {
  return `${date}|${asset}`;
}

function normalizePriceEntry(entry = {}) {
  const asset = String(entry.asset || '').trim().toUpperCase();
  const date = String(entry.date || '').slice(0, 10);
  const price = Number(entry.price_eur);
  if (!asset || !date || !Number.isFinite(price) || price <= 0) return null;
  return {
    ...entry,
    asset,
    date,
    price_eur: round(price, 10),
    source: String(entry.source || entry.source_label || entry.source_kind || 'importado'),
    source_kind: String(entry.source_kind || ''),
    provider: String(entry.provider || ''),
    provider_id: String(entry.provider_id || entry.coinGeckoId || entry.coingecko_id || ''),
    provider_name: String(entry.provider_name || ''),
    nearest_date: entry.nearest_date ? String(entry.nearest_date).slice(0, 10) : '',
    nearest_distance_days: Number.isFinite(Number(entry.nearest_distance_days)) ? Number(entry.nearest_distance_days) : '',
    derived_from_source: String(entry.derived_from_source || ''),
    fetched_at: String(entry.fetched_at || ''),
    manually_edited: Boolean(entry.manually_edited),
  };
}

export function buildPriceStore(seedPrices = []) {
  const store = {};
  for (const rawPrice of seedPrices) {
    const price = normalizePriceEntry(rawPrice);
    if (!price) continue;
    const key = buildPriceKey(price.asset, price.date);
    if (!store[key]) store[key] = price;
  }
  return store;
}

export function findClosestPriceEntry(store, asset, date, maxDistanceDays = Number.POSITIVE_INFINITY) {
  const symbol = String(asset || '').trim().toUpperCase();
  const candidates = Object.values(store)
    .filter((entry) => entry.asset === symbol && entry.date !== date)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!candidates.length) return null;

  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(daysBetween(candidate.date, date));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (!best || bestDistance > maxDistanceDays) return null;
  return { entry: best, distance: bestDistance };
}

export function findAdjacentPriceEntries(store, asset, date) {
  const symbol = String(asset || '').trim().toUpperCase();
  const candidates = Object.values(store)
    .filter((entry) => entry.asset === symbol && entry.date !== date)
    .sort((a, b) => a.date.localeCompare(b.date));

  let previous = null;
  let next = null;

  for (const candidate of candidates) {
    if (candidate.date < date) previous = candidate;
    if (!next && candidate.date > date) next = candidate;
  }

  return {
    previous: previous ? { ...previous, distance_days: Math.abs(daysBetween(previous.date, date)) } : null,
    next: next ? { ...next, distance_days: Math.abs(daysBetween(next.date, date)) } : null,
  };
}

export function getPrice(store, asset, date, maxDistanceDays = 7) {
  const exact = store[buildPriceKey(String(asset || '').trim().toUpperCase(), date)];
  if (exact) return Number(exact.price_eur);
  const match = findClosestPriceEntry(store, asset, date, maxDistanceDays);
  return match ? Number(match.entry.price_eur) : null;
}

export function deriveMissingPrices(store, transactions) {
  let changed = true;
  let loop = 0;

  while (changed && loop < 5) {
    changed = false;
    loop += 1;

    for (const tx of transactions) {
      if (tx.kind === 'swap') {
        const outPrice = getPrice(store, tx.assetOut, tx.date);
        const inPrice = getPrice(store, tx.assetIn, tx.date);
        if (outPrice && !inPrice && tx.quantityIn > 0) {
          store[buildPriceKey(tx.assetIn, tx.date)] = {
            asset: tx.assetIn,
            date: tx.date,
            price_eur: round((outPrice * tx.quantityOut) / tx.quantityIn, 10),
            source: 'inferido via swap',
            source_kind: 'swap-derived',
            provider: 'internal',
          };
          changed = true;
        } else if (inPrice && !outPrice && tx.quantityOut > 0) {
          store[buildPriceKey(tx.assetOut, tx.date)] = {
            asset: tx.assetOut,
            date: tx.date,
            price_eur: round((inPrice * tx.quantityIn) / tx.quantityOut, 10),
            source: 'inferido via swap',
            source_kind: 'swap-derived',
            provider: 'internal',
          };
          changed = true;
        }
      }

      if ((tx.kind === 'reward' || tx.kind === 'staking_reward') && tx.referenceEur && tx.quantity > 0) {
        const key = buildPriceKey(tx.asset, tx.date);
        if (!store[key]) {
          store[key] = {
            asset: tx.asset,
            date: tx.date,
            price_eur: round(tx.referenceEur / tx.quantity, 10),
            source: 'valor do ficheiro original',
            source_kind: 'file',
            provider: 'file',
          };
          changed = true;
        }
      }
    }
  }

  return store;
}

export function fillNearestPrices(store, transactions) {
  for (const tx of transactions) {
    if (!tx.asset || !['reward', 'staking_reward', 'external_deposit'].includes(tx.kind)) continue;
    const key = buildPriceKey(tx.asset, tx.date);
    if (store[key]) continue;
    const fallback = findClosestPriceEntry(store, tx.asset, tx.date, 7);
    if (fallback) {
      store[key] = {
        asset: tx.asset,
        date: tx.date,
        price_eur: round(fallback.entry.price_eur, 10),
        source: 'aproximado por proximidade',
        source_kind: 'nearest',
        provider: 'internal',
        nearest_date: fallback.entry.date,
        nearest_distance_days: fallback.distance,
        derived_from_source: fallback.entry.source || '',
      };
    }
  }
  return store;
}

export function buildPriceReviewRows({ store, reviewItems, coinGeckoIds = {} }) {
  const registry = new Map();

  for (const entry of Object.values(store)) {
    if (!entry?.asset || !entry?.date) continue;
    if (!['coingecko', 'nearest'].includes(String(entry.source_kind || '')) && !String(entry.source || '').toLowerCase().includes('coingecko')) continue;
    const key = buildPriceKey(entry.asset, entry.date);
    registry.set(key, {
      key,
      asset: entry.asset,
      date: entry.date,
      transactionId: '',
      reviewId: '',
      unresolved: false,
    });
  }

  for (const item of reviewItems.filter((review) => !review.resolved && review.type === 'Preço em falta')) {
    const asset = String(item.data?.asset || '').trim().toUpperCase();
    const date = String(item.data?.date || '').slice(0, 10);
    if (!asset || !date) continue;
    const key = buildPriceKey(asset, date);
    registry.set(key, {
      ...(registry.get(key) || {}),
      key,
      asset,
      date,
      transactionId: item.data?.transactionId || '',
      reviewId: item.id,
      unresolved: true,
      platform: item.data?.platform || '',
      reviewTitle: item.title || '',
    });
  }

  return [...registry.values()]
    .map((row) => {
      const entry = store[row.key] || null;
      const around = findAdjacentPriceEntries(store, row.asset, row.date);
      return {
        ...row,
        currentPrice: entry?.price_eur ?? '',
        source: entry?.source || (row.unresolved ? 'sem preço' : ''),
        sourceKind: entry?.source_kind || '',
        provider: entry?.provider || '',
        coinGeckoId: entry?.provider_id || coinGeckoIds[row.asset] || '',
        previousDate: around.previous?.date || '',
        previousPrice: around.previous?.price_eur ?? '',
        previousSource: around.previous?.source || '',
        previousDistanceDays: around.previous?.distance_days ?? '',
        nextDate: around.next?.date || '',
        nextPrice: around.next?.price_eur ?? '',
        nextSource: around.next?.source || '',
        nextDistanceDays: around.next?.distance_days ?? '',
      };
    })
    .sort((a, b) => `${a.date}${a.asset}`.localeCompare(`${b.date}${b.asset}`));
}
