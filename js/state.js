
export const defaultState = () => ({
  settings: {
    taxYear: 2026,
    taxRate: 28,
    autoContinuity: true,
    ignoreDust: true,
    swapPolicy: 'carry_data',
    coinGeckoAutoFill: true,
    coinGeckoApiKey: '',
  },
  queueFiles: [],
  recognizedFiles: [],
  raw: {
    krakenLedgers: [],
    krakenTrades: [],
    krakenBalances: [],
    robinhood: [],
  },
  transactions: [],
  lots: [],
  closedLots: [],
  taxableDisposals: [],
  exemptDisposals: [],
  reviewItems: [],
  prices: {},
  overrides: [],
  auditTrail: [],
  transferLinks: [],
  coinGeckoIds: {},
  priceSync: {
    lastRunAt: '',
    fetched: 0,
    failed: 0,
    checked: 0,
    message: '',
  },
  summary: {
    importedMovements: 0,
    classifiedMovements: 0,
    lotsCreated: 0,
    reconciledTransfers: 0,
    reviewPoints: 0,
    missingPrices: 0,
    ignoredTechnical: 0,
  },
});

export let state = defaultState();

export function resetState(preserveSettings = true) {
  const previousSettings = structuredClone(state.settings);
  state = defaultState();
  if (preserveSettings) state.settings = previousSettings;
  return state;
}

export function replaceState(nextState) {
  const fresh = defaultState();
  state = {
    ...fresh,
    ...(nextState || {}),
    settings: { ...fresh.settings, ...(nextState?.settings || {}) },
    raw: { ...fresh.raw, ...(nextState?.raw || {}) },
    summary: { ...fresh.summary, ...(nextState?.summary || {}) },
    coinGeckoIds: { ...fresh.coinGeckoIds, ...(nextState?.coinGeckoIds || {}) },
    priceSync: { ...fresh.priceSync, ...(nextState?.priceSync || {}) },
  };
  return state;
}
