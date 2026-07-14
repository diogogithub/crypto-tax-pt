import { processFiscal } from './fiscal.js';
import { normalizeRaw } from './parsers.js';
import { buildPriceStore, deriveMissingPrices, fillNearestPrices } from './prices.js';

export function runPipeline({ raw, settings, overrides = [], existingPrices = {} }) {
  const { transactions, derivedPrices, ignoredTechnical } = normalizeRaw(raw, settings);
  let priceStore = buildPriceStore([...Object.values(existingPrices), ...derivedPrices]);
  priceStore = deriveMissingPrices(priceStore, transactions);
  priceStore = fillNearestPrices(priceStore, transactions);

  const fiscal = processFiscal({ transactions, prices: priceStore, settings, overrides });

  const summary = {
    importedMovements: raw.krakenLedgers.length + raw.krakenTrades.length + raw.krakenBalances.length + raw.robinhood.length,
    classifiedMovements: transactions.length,
    lotsCreated: fiscal.lots.length + fiscal.closedLots.length,
    reconciledTransfers: fiscal.transferLinks.length,
    reviewPoints: fiscal.reviewItems.length,
    missingPrices: fiscal.reviewItems.filter((item) => item.type === 'Preço em falta').length,
    ignoredTechnical,
  };

  return {
    transactions,
    prices: priceStore,
    ...fiscal,
    summary,
  };
}
