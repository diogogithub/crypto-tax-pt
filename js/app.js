
import { lookupHistoricalPrice } from './coingecko.js';
import { parseFiles } from './parsers.js';
import { runPipeline } from './process.js';
import { buildPriceKey } from './prices.js';
import { buildSerializableState, clearLocalStorage, loadFromLocalStorage, saveToLocalStorage } from './storage.js';
import { replaceState, resetState, state } from './state.js';
import { exportHelpers, renderAll, syncSettingsToInputs } from './ui.js';
import { downloadJson, el, parseNumber, showToast } from './utils.js';

const queuedFiles = [];

function describeFile(file) {
  return {
    name: String(file?.name || 'ficheiro'),
    size: Number(file?.size || 0),
    type: String(file?.type || ''),
    lastModified: Number(file?.lastModified || 0),
  };
}

function collectSettings() {
  state.settings.taxYear = Number(el('taxYear').value);
  state.settings.taxRate = Number(el('taxRate').value);
  state.settings.autoContinuity = el('autoContinuity').checked;
  state.settings.ignoreDust = el('ignoreDust').checked;
  state.settings.swapPolicy = el('swapPolicy').value;
  if (el('coinGeckoAutoFill')) state.settings.coinGeckoAutoFill = el('coinGeckoAutoFill').checked;
  if (el('coinGeckoApiKey')) state.settings.coinGeckoApiKey = String(el('coinGeckoApiKey').value || '').trim();
}

function applyPersistedReviewResolutions() {
  state.reviewItems = state.reviewItems.map((item) => {
    const transactionId = item.data?.transactionId;
    const persisted = state.overrides.find((override) => override.type === 'mark-reviewed' && (override.targetId === transactionId || override.targetId === item.id));
    return persisted ? { ...item, resolved: true, resolution: persisted.note || 'Revisto manualmente' } : item;
  });
}

function runCurrentPipeline() {
  const result = runPipeline({
    raw: state.raw,
    settings: state.settings,
    overrides: state.overrides,
    existingPrices: state.prices,
  });
  Object.assign(state, result);
  applyPersistedReviewResolutions();
}

function collectCoinGeckoCandidates() {
  const registry = new Map();

  state.reviewItems
    .filter((item) => !item.resolved && item.type === 'Preço em falta')
    .forEach((item) => {
      const asset = String(item.data?.asset || '').trim().toUpperCase();
      const date = String(item.data?.date || '').slice(0, 10);
      if (!asset || !date) return;
      const key = buildPriceKey(asset, date);
      registry.set(key, { key, asset, date, reason: 'review' });
    });

  Object.values(state.prices)
    .filter((entry) => entry?.asset && entry?.date && String(entry.source_kind || '') === 'nearest')
    .forEach((entry) => {
      const key = buildPriceKey(entry.asset, entry.date);
      if (!registry.has(key)) registry.set(key, { key, asset: entry.asset, date: entry.date, reason: 'upgrade-nearest' });
    });

  return [...registry.values()];
}

async function syncCoinGeckoPrices({ force = false, specificKeys = null, silent = false } = {}) {
  const candidates = specificKeys && specificKeys.length
    ? specificKeys.map((key) => {
      const [date, asset] = String(key).split('|');
      return { key, asset, date, reason: 'manual' };
    }).filter((item) => item.asset && item.date)
    : collectCoinGeckoCandidates();

  if (!candidates.length) {
    state.priceSync = {
      ...state.priceSync,
      lastRunAt: new Date().toISOString(),
      fetched: 0,
      failed: 0,
      checked: 0,
      message: 'Sem preços em falta para consultar no CoinGecko.',
    };
    saveToLocalStorage(state);
    render();
    return { checked: 0, fetched: 0, failed: 0 };
  }

  let fetched = 0;
  let failed = 0;
  let checked = 0;
  const failures = [];

  for (const candidate of candidates) {
    const existing = state.prices[candidate.key];
    if (!force && existing && Number(existing.price_eur) > 0 && !['nearest', 'coingecko'].includes(String(existing.source_kind || ''))) continue;

    checked += 1;
    try {
      const resolved = await lookupHistoricalPrice({
        asset: candidate.asset,
        date: candidate.date,
        apiKey: state.settings.coinGeckoApiKey,
        knownCoinId: existing?.provider_id || state.coinGeckoIds?.[candidate.asset] || '',
      });

      state.coinGeckoIds[candidate.asset] = resolved.coinId;
      state.prices[candidate.key] = {
        ...(existing || {}),
        asset: candidate.asset,
        date: candidate.date,
        price_eur: resolved.price,
        source: `CoinGecko histórico (${resolved.coinId})`,
        source_kind: 'coingecko',
        provider: 'coingecko',
        provider_id: resolved.coinId,
        provider_name: resolved.coinName || '',
        fetched_at: resolved.fetched_at,
        manually_edited: false,
      };
      fetched += 1;
    } catch (error) {
      failed += 1;
      failures.push(`${candidate.asset} ${candidate.date}`);
      if (!state.coinGeckoIds) state.coinGeckoIds = {};
    }
  }

  const message = fetched
    ? `CoinGecko aplicou ${fetched} preço(s).${failed ? ` Falharam ${failed}.` : ''}`
    : failed
      ? `CoinGecko não conseguiu preencher ${failed} preço(s).`
      : 'CoinGecko não tinha novos preços para aplicar.';

  state.priceSync = {
    lastRunAt: new Date().toISOString(),
    fetched,
    failed,
    checked,
    message: failures.length ? `${message} (${failures.slice(0, 6).join(', ')})` : message,
  };

  saveToLocalStorage(state);
  render();
  if (!silent) showToast(message);
  return { checked, fetched, failed };
}

async function reprocess({ allowAutoCoinGecko = false, silent = false } = {}) {
  collectSettings();
  if (!state.raw) return;
  runCurrentPipeline();
  saveToLocalStorage(state);
  render();

  if (allowAutoCoinGecko && state.settings.coinGeckoAutoFill) {
    const sync = await syncCoinGeckoPrices({ silent: true });
    if (sync.fetched > 0) {
      runCurrentPipeline();
      saveToLocalStorage(state);
      render();
      if (!silent) showToast(`CoinGecko aplicou ${sync.fetched} preço(s) e a sessão foi reprocessada.`);
      return;
    }
    if (!silent && sync.checked > 0) showToast(sync.fetched ? 'Preços atualizados.' : state.priceSync.message || 'CoinGecko verificado.');
  }
}

async function processFiles() {
  if (!queuedFiles.length) {
    showToast('Selecione primeiro um ou mais ficheiros.');
    return;
  }
  collectSettings();
  state.queueFiles = queuedFiles.map(describeFile);
  const { raw, recognizedFiles } = await parseFiles(queuedFiles);
  state.raw = raw;
  state.recognizedFiles = recognizedFiles;
  state.overrides = state.overrides || [];
  await reprocess({ allowAutoCoinGecko: true });
  showToast('Ficheiros processados com sucesso.');
}

function queueInputFiles(files) {
  for (const file of files) queuedFiles.push(file);
  state.queueFiles = queuedFiles.map(describeFile);
  render();
}

function clearQueuedFiles() {
  queuedFiles.splice(0, queuedFiles.length);
  state.queueFiles = [];
  state.recognizedFiles = [];
  render();
}

async function applyReviewAction(reviewId, action, payload) {
  const review = state.reviewItems.find((item) => item.id === reviewId);
  if (!review) return;
  const transactionId = review.data.transactionId;

  if (action === 'assign-price') {
    if (!payload.price) {
      showToast('Indique primeiro um preço manual.');
      return;
    }
    state.overrides.push({ id: crypto.randomUUID(), reviewId, targetId: transactionId, type: 'manual-price', value: Number(payload.price), note: payload.note || '', resolved: true });
  } else if (action === 'accept-external') {
    state.overrides.push({ id: crypto.randomUUID(), reviewId, targetId: transactionId, type: 'accept-external', note: payload.note || '', resolved: true });
  } else if (action === 'assume-transfer') {
    const candidateLot = state.lots.find((lot) => lot.asset === review.data.asset && lot.platform !== review.data.platform && lot.quantityRemaining > 0);
    if (!candidateLot) {
      showToast('Não existe um lote candidato evidente para ligar manualmente.');
      return;
    }
    state.overrides.push({ id: crypto.randomUUID(), reviewId, targetId: transactionId, type: 'assume-transfer', sourceLotId: candidateLot.id, note: payload.note || '', resolved: true });
  } else if (action === 'mark-reviewed') {
    state.overrides.push({ id: crypto.randomUUID(), reviewId, targetId: transactionId || reviewId, type: 'mark-reviewed', note: payload.note || '', resolved: true });
  } else if (action === 'mark-non-fiscal') {
    state.overrides.push({ id: crypto.randomUUID(), reviewId, targetId: transactionId, type: 'mark-non-fiscal', note: payload.note || '', resolved: true });
  }

  review.resolved = true;
  review.resolution = payload.note || action;
  await reprocess({ allowAutoCoinGecko: false, silent: true });
  showToast('Decisão manual registada.');
}

function ensurePriceRow(key) {
  if (state.prices[key]) return state.prices[key];
  const [date, asset] = String(key).split('|');
  state.prices[key] = {
    asset: String(asset || '').trim().toUpperCase(),
    date: String(date || '').slice(0, 10),
    price_eur: 0,
    source: 'manual',
    source_kind: 'manual',
    provider: '',
    provider_id: '',
    manually_edited: true,
  };
  return state.prices[key];
}

function editPrice(input) {
  const key = input.dataset.priceKey || input.dataset.sourceKey || input.dataset.providerKey;
  if (!key) return;
  const row = ensurePriceRow(key);

  if (input.dataset.priceKey) {
    row.price_eur = Number(input.value || 0);
    row.manually_edited = true;
    if (!row.source || String(row.source).startsWith('CoinGecko histórico')) row.source = 'manual';
    row.source_kind = 'manual';
  }

  if (input.dataset.sourceKey) {
    row.source = input.value || '';
    row.manually_edited = true;
    if (row.source) row.source_kind = 'manual';
  }

  if (input.dataset.providerKey) {
    const providerId = String(input.value || '').trim();
    row.provider_id = providerId;
    if (!state.coinGeckoIds) state.coinGeckoIds = {};
    if (providerId) state.coinGeckoIds[row.asset] = providerId;
    else delete state.coinGeckoIds[row.asset];
  }

  saveToLocalStorage(state);
}

async function handlePriceAction(action, targetKey) {
  if (action !== 'refresh-coingecko' || !targetKey) return;
  await syncCoinGeckoPrices({ force: true, specificKeys: [targetKey], silent: true });
  runCurrentPipeline();
  saveToLocalStorage(state);
  render();
  showToast('Preço atualizado via CoinGecko.');
}

function changeCountry(rowId, value) {
  const row = state.taxableDisposals.find((item) => item.id === rowId);
  if (!row) return;
  row.countrySource = String(value || '').trim().toUpperCase().slice(0, 2);
  saveToLocalStorage(state);
}

function exportWorkpack() {
  downloadJson(`crypto-irs-pt-workpack-${state.settings.taxYear}.json`, buildSerializableState(state));
}

function saveSessionFile() {
  downloadJson(`crypto-irs-pt-session-${state.settings.taxYear}.json`, buildSerializableState(state));
  showToast('Sessão exportada.');
}

function activateTab(tabId) {
  document.querySelectorAll('.nav-link').forEach((item) => item.classList.toggle('active', item.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === tabId));
}

function resetAppStorage() {
  const confirmed = window.confirm('Isto vai apagar a sessão guardada desta app neste browser e voltar ao estado inicial. Queres continuar?');
  if (!confirmed) return;
  clearLocalStorage();
  resetState(false);
  queuedFiles.splice(0, queuedFiles.length);
  state.queueFiles = [];
  state.recognizedFiles = [];
  if (el('fileInput')) el('fileInput').value = '';
  if (el('restoreSessionInput')) el('restoreSessionInput').value = '';
  if (el('importPricesInput')) el('importPricesInput').value = '';
  syncSettingsToInputs();
  activateTab('overview');
  render();
  showToast('Storage local apagado. Pode recomeçar do zero.');
}

async function restoreSession(file) {
  if (!file) return;
  const text = await file.text();
  const restored = JSON.parse(text);
  replaceState(restored);
  queuedFiles.splice(0, queuedFiles.length);
  syncSettingsToInputs();
  render();
  saveToLocalStorage(state);
  showToast('Sessão restaurada.');
}

function normalizeImportedPriceEntry(entry = {}) {
  const asset = String(entry.asset || entry.Asset || '').trim().toUpperCase();
  const date = String(entry.date || entry.Date || '').slice(0, 10);
  const price = parseNumber(entry.price_eur ?? entry.price ?? entry.currentPrice ?? '');
  if (!asset || !date || !price) return null;
  return {
    ...entry,
    asset,
    date,
    price_eur: price,
    source: String(entry.source || entry.Source || 'importado'),
    source_kind: String(entry.source_kind || entry.sourceKind || 'imported'),
    provider: String(entry.provider || ''),
    provider_id: String(entry.provider_id || entry.coinGeckoId || entry.coingecko_id || ''),
    provider_name: String(entry.provider_name || ''),
    nearest_date: String(entry.nearest_date || ''),
    nearest_distance_days: entry.nearest_distance_days ?? '',
    derived_from_source: String(entry.derived_from_source || ''),
    fetched_at: String(entry.fetched_at || ''),
    manually_edited: Boolean(entry.manually_edited),
  };
}

async function importPrices(file) {
  if (!file) return;
  const imported = [];

  if (file.name.toLowerCase().endsWith('.json')) {
    const text = await file.text();
    const data = JSON.parse(text);
    (Array.isArray(data) ? data : Object.values(data)).forEach((entry) => {
      const normalized = normalizeImportedPriceEntry(entry);
      if (normalized) imported.push(normalized);
    });
  } else if (file.name.toLowerCase().endsWith('.csv')) {
    const text = await file.text();
    const parsed = window.Papa.parse(text, { header: true, skipEmptyLines: true }).data || [];
    parsed.forEach((entry) => {
      const normalized = normalizeImportedPriceEntry(entry);
      if (normalized) imported.push(normalized);
    });
  }

  imported.forEach((entry) => {
    const key = buildPriceKey(entry.asset, entry.date);
    state.prices[key] = entry;
    if (entry.provider_id) state.coinGeckoIds[entry.asset] = entry.provider_id;
  });

  await reprocess({ allowAutoCoinGecko: false, silent: true });
  showToast(`Preços importados: ${imported.length}.`);
}

function render() {
  renderAll(applyReviewAction, editPrice, changeCountry, handlePriceAction);
}

function initNavigation() {
  document.querySelectorAll('.nav-link').forEach((button) => {
    button.addEventListener('click', () => activateTab(button.dataset.tab));
  });
}

function initDropzone() {
  const dropzone = el('dropzone');
  const activate = (active) => dropzone.classList.toggle('active', active);
  ['dragenter', 'dragover'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    activate(true);
  }));
  ['dragleave', 'drop'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    activate(false);
  }));
  dropzone.addEventListener('drop', (event) => queueInputFiles(event.dataTransfer.files));
  dropzone.addEventListener('click', () => el('fileInput').click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      el('fileInput').click();
    }
  });
}

function bindUI() {
  initNavigation();
  initDropzone();

  el('fileInput').addEventListener('change', (event) => queueInputFiles(event.target.files));
  el('processBtn').addEventListener('click', processFiles);
  el('clearFilesBtn').addEventListener('click', clearQueuedFiles);
  el('saveSessionBtn').addEventListener('click', saveSessionFile);
  el('resetAppBtn').addEventListener('click', resetAppStorage);
  el('resetAppBtnSecondary').addEventListener('click', resetAppStorage);
  el('restoreSessionInput').addEventListener('change', (event) => restoreSession(event.target.files[0]));
  el('importPricesInput').addEventListener('change', (event) => importPrices(event.target.files[0]));
  el('reprocessBtn').addEventListener('click', async () => {
    await reprocess({ allowAutoCoinGecko: true });
    showToast('Sessão reprocessada com os dados atuais.');
  });
  if (el('syncCoinGeckoBtn')) {
    el('syncCoinGeckoBtn').addEventListener('click', async () => {
      await syncCoinGeckoPrices({ force: true, silent: true });
      runCurrentPipeline();
      saveToLocalStorage(state);
      render();
      showToast(state.priceSync.message || 'Sincronização CoinGecko concluída.');
    });
  }

  ['historySearch', 'historyPlatformFilter', 'historyAssetFilter', 'historyTypeFilter', 'historyYearFilter', 'lotsSearch', 'lotsPlatformFilter', 'lotsAssetFilter', 'lotsStatusFilter', 'reviewSearch', 'reviewSeverityFilter', 'reviewTypeFilter'].forEach((id) => {
    document.addEventListener('change', (event) => {
      if (event.target?.id === id) render();
    });
    document.addEventListener('input', (event) => {
      if (event.target?.id === id) render();
    });
  });

  ['taxYear', 'taxRate', 'autoContinuity', 'ignoreDust', 'swapPolicy', 'coinGeckoAutoFill', 'coinGeckoApiKey'].forEach((id) => {
    if (!el(id)) return;
    el(id).addEventListener('change', () => {
      collectSettings();
      saveToLocalStorage(state);
    });
  });

  const exports = exportHelpers();
  el('exportHistoryBtn').addEventListener('click', exports.exportHistory);
  el('exportLotsBtn').addEventListener('click', exports.exportLots);
  el('exportReviewsBtn').addEventListener('click', exports.exportReviews);
  el('exportTaxableBtn').addEventListener('click', exports.exportTaxable);
  el('exportExemptBtn').addEventListener('click', exports.exportExempt);
  el('exportPricesCsvBtn').addEventListener('click', exports.exportPricesCsv);
  el('exportPricesJsonBtn').addEventListener('click', exports.exportPricesJson);
  el('exportWorkpackBtn').addEventListener('click', exportWorkpack);
}

function bootstrap() {
  const restored = loadFromLocalStorage();
  if (restored) replaceState(restored);
  syncSettingsToInputs();
  bindUI();
  render();
}

bootstrap();
