export const el = (id) => document.getElementById(id);

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[match]));
}

export function parseNumber(value) {
  if (value === null || value === undefined) return 0;
  let raw = String(value).trim();
  if (!raw || raw === '-' || raw.toLowerCase() === 'nan') return 0;
  raw = raw.replace(/€|\s/g, '');
  if (raw.includes(',') && raw.includes('.')) {
    if (raw.lastIndexOf(',') > raw.lastIndexOf('.')) raw = raw.replace(/\./g, '').replace(',', '.');
    else raw = raw.replace(/,/g, '');
  } else if (raw.includes(',')) {
    raw = raw.replace(',', '.');
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function round(value, decimals = 2) {
  return Number(Number(value || 0).toFixed(decimals));
}

export function formatCurrency(value) {
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));
}

export function formatDateOnly(value) {
  return String(value || '').slice(0, 10);
}

export function cleanAsset(value) {
  return String(value || '').replace('.HOLD', '').trim().toUpperCase();
}

export function toDate(value) {
  if (!value) return new Date('1970-01-01T00:00:00Z');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T12:00:00`);
  return new Date(String(value).replace(' ', 'T'));
}

export function daysBetween(start, end) {
  const difference = toDate(end) - toDate(start);
  return Math.floor(difference / (1000 * 60 * 60 * 24));
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename, data) {
  downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}

export function downloadCsv(filename, rows) {
  if (!rows.length) return false;
  const headers = Array.from(rows.reduce((set, row) => {
    Object.keys(row).forEach((key) => set.add(key));
    return set;
  }, new Set()));
  const escaped = (value) => {
    const stringValue = String(value ?? '');
    return /[",\n]/.test(stringValue) ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
  };
  const csv = [headers.join(',')].concat(rows.map((row) => headers.map((header) => escaped(row[header])).join(','))).join('\n');
  downloadBlob(filename, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  return true;
}

export function showToast(message) {
  const host = el('toastHost');
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

export function uniqueSorted(values, emptyLabel = 'Todos') {
  return [emptyLabel].concat(Array.from(new Set(values.filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b))));
}

export function classifyConfidence(level) {
  if (level === 'high') return 'badge-good';
  if (level === 'medium') return 'badge-warn';
  if (level === 'low') return 'badge-bad';
  return 'badge-neutral';
}

export function classifySeverity(level) {
  if (level === 'Alta') return 'badge-bad';
  if (level === 'Média') return 'badge-warn';
  if (level === 'Baixa') return 'badge-good';
  return 'badge-neutral';
}


export function transactionPriority(kind) {
  const priorities = {
    fiat_deposit: 10,
    buy_fiat: 20,
    reward: 30,
    staking_reward: 31,
    external_deposit: 40,
    swap: 60,
    sell_fiat: 70,
    fiat_withdrawal: 80,
    technical_dust: 90,
  };
  return priorities[kind] ?? 50;
}

export function platformLabel(platform) {
  if (platform === 'kraken') return 'Kraken';
  if (platform === 'robinhood') return 'Robinhood';
  return String(platform || 'Desconhecida');
}

export const platformCountrySuggestions = {
  kraken: 'IE',
  robinhood: 'LT',
  unknown: '',
};
