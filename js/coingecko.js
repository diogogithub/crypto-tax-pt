
const DEMO_API_ROOT = 'https://api.coingecko.com/api/v3';

const KNOWN_COIN_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  DOGE: 'dogecoin',
  PEPE: 'pepe',
  XRP: 'ripple',
  ADA: 'cardano',
  LTC: 'litecoin',
  DOT: 'polkadot',
  LINK: 'chainlink',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  POL: 'polygon-ecosystem-token',
  USDT: 'tether',
  USDC: 'usd-coin',
  DAI: 'dai',
  EURC: 'euro-coin',
  EURT: 'tether-eurt',
};

function buildHeaders(apiKey = '') {
  const headers = { accept: 'application/json' };
  if (apiKey) headers['x-cg-demo-api-key'] = apiKey;
  return headers;
}

function buildUrl(path, params = {}, apiKey = '') {
  const url = new URL(`${DEMO_API_ROOT}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  });
  if (apiKey) url.searchParams.set('x_cg_demo_api_key', apiKey);
  return url.toString();
}

function formatHistoryDate(date) {
  const [year, month, day] = String(date || '').slice(0, 10).split('-');
  return day && month && year ? `${day}-${month}-${year}` : '';
}

function scoreCandidate(candidate, asset) {
  const symbol = String(candidate?.symbol || candidate?.api_symbol || '').toUpperCase();
  const name = String(candidate?.name || '').toUpperCase();
  const id = String(candidate?.id || '').toLowerCase();
  let score = 0;

  if (symbol === asset) score += 120;
  if (name === asset) score += 50;
  if (id === asset.toLowerCase()) score += 25;
  if (id.includes(asset.toLowerCase())) score += 10;

  const marketCapRank = Number(candidate?.market_cap_rank);
  if (Number.isFinite(marketCapRank) && marketCapRank > 0) {
    score += Math.max(0, 40 - Math.min(marketCapRank, 40));
  }

  return score;
}

async function fetchJson(path, params = {}, apiKey = '') {
  const response = await fetch(buildUrl(path, params, apiKey), {
    method: 'GET',
    headers: buildHeaders(apiKey),
  });
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json();
}

export async function resolveCoinGeckoId({ asset, apiKey = '', knownCoinId = '' }) {
  const symbol = String(asset || '').trim().toUpperCase();
  if (!symbol) throw new Error('Ativo inválido.');
  if (knownCoinId) return { coinId: knownCoinId, confidence: 'stored' };
  if (KNOWN_COIN_IDS[symbol]) return { coinId: KNOWN_COIN_IDS[symbol], confidence: 'known' };

  const payload = await fetchJson('/search', { query: symbol }, apiKey);
  const coins = Array.isArray(payload?.coins) ? payload.coins : [];
  if (!coins.length) throw new Error(`Sem resultados CoinGecko para ${symbol}.`);

  const ranked = [...coins]
    .map((coin) => ({ coin, score: scoreCandidate(coin, symbol) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0]?.coin;
  if (!best?.id) throw new Error(`Não foi possível escolher um CoinGecko ID para ${symbol}.`);

  return {
    coinId: best.id,
    coinName: best.name || '',
    symbol: best.symbol || symbol,
    confidence: ranked[0]?.score >= 120 ? 'high' : ranked[0]?.score >= 70 ? 'medium' : 'low',
  };
}

export async function fetchHistoricalCoinGeckoPrice({ coinId, date, apiKey = '' }) {
  if (!coinId) throw new Error('CoinGecko ID em falta.');
  const formattedDate = formatHistoryDate(date);
  if (!formattedDate) throw new Error('Data inválida para histórico CoinGecko.');

  const payload = await fetchJson(`/coins/${encodeURIComponent(coinId)}/history`, {
    date: formattedDate,
    localization: 'false',
  }, apiKey);

  const price = Number(payload?.market_data?.current_price?.eur);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`CoinGecko não devolveu preço EUR para ${coinId} em ${date}.`);

  return {
    price,
    coinId,
    coinName: payload?.name || '',
    provider: 'coingecko',
    source: `CoinGecko histórico (${coinId})`,
    source_kind: 'coingecko',
    fetched_at: new Date().toISOString(),
  };
}

export async function lookupHistoricalPrice({ asset, date, apiKey = '', knownCoinId = '' }) {
  const resolved = await resolveCoinGeckoId({ asset, apiKey, knownCoinId });
  const history = await fetchHistoricalCoinGeckoPrice({ coinId: resolved.coinId, date, apiKey });
  return {
    ...history,
    coinId: resolved.coinId,
    coinName: history.coinName || resolved.coinName || '',
    confidence: resolved.confidence,
  };
}
