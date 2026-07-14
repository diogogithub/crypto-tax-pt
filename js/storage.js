const STORAGE_KEY = 'crypto-irs-pt-static-session';

function toSerializableFileDescriptor(file) {
  return {
    name: String(file?.name || 'ficheiro'),
    size: Number(file?.size || 0),
    type: String(file?.type || ''),
    lastModified: Number(file?.lastModified || 0),
  };
}

export function buildSerializableState(payload) {
  return {
    ...payload,
    settings: {
      ...(payload?.settings || {}),
      // API keys remain session-only: never write them to localStorage or exports.
      coinGeckoApiKey: '',
    },
    queueFiles: Array.isArray(payload?.queueFiles) ? payload.queueFiles.map(toSerializableFileDescriptor) : [],
  };
}

export function saveToLocalStorage(payload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buildSerializableState(payload)));
  } catch {
    // Ignora falhas de storage para não interromper a app.
  }
}

export function loadFromLocalStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return buildSerializableState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearLocalStorage() {
  localStorage.removeItem(STORAGE_KEY);
}
