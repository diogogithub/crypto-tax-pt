import { cleanAsset, formatDateOnly, parseNumber, transactionPriority } from './utils.js';

function detectParser(headers) {
  const normalized = headers.map((header) => String(header).trim().toLowerCase());
  const joined = normalized.join('|');
  if (joined.includes('activity date') && joined.includes('transaction type') && joined.includes('instrument quantity')) return 'robinhood';
  if (joined.includes('txid') && joined.includes('refid') && joined.includes('wallet') && joined.includes('balance')) return 'krakenLedgers';
  if (joined.includes('ordertxid') && joined.includes('pair') && joined.includes('ordertype')) return 'krakenTrades';
  if (joined.includes('price (usd)') && joined.includes('value (usd)') && joined.includes('quantity')) return 'krakenBalances';
  return 'unknown';
}

function parseCsvText(text) {
  return window.Papa.parse(text, { header: true, skipEmptyLines: true });
}

async function extractCsvEntries(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) {
    return [{ innerName: file.name, outerName: file.name, text: await file.text() }];
  }
  if (name.endsWith('.zip')) {
    const zip = await window.JSZip.loadAsync(file);
    const entries = [];
    for (const [innerName, entry] of Object.entries(zip.files)) {
      if (!entry.dir && innerName.toLowerCase().endsWith('.csv')) {
        entries.push({ innerName, outerName: file.name, text: await entry.async('string') });
      }
    }
    return entries;
  }
  return [];
}

export async function parseFiles(files) {
  const recognizedFiles = [];
  const raw = {
    krakenLedgers: [],
    krakenTrades: [],
    krakenBalances: [],
    robinhood: [],
  };

  for (const file of files) {
    const entries = await extractCsvEntries(file);
    if (!entries.length) {
      recognizedFiles.push({
        outerName: file.name,
        innerName: file.name,
        status: 'Não reconhecido',
        category: 'Formato não suportado',
        details: 'A aplicação só lê CSV e ZIP que contenham CSV.',
        rows: 0,
        recommended: false,
      });
      continue;
    }

    for (const entry of entries) {
      const result = parseCsvText(entry.text);
      const rows = result.data || [];
      const headers = result.meta.fields || [];
      const parser = detectParser(headers);
      const baseInfo = {
        outerName: entry.outerName,
        innerName: entry.innerName,
        rows: rows.length,
        headers,
      };

      if (parser === 'unknown') {
        recognizedFiles.push({
          ...baseInfo,
          status: 'Não reconhecido',
          category: 'Estrutura desconhecida',
          details: 'O ficheiro foi lido, mas o formato não corresponde aos parsers atuais.',
          recommended: false,
        });
        continue;
      }

      const enrichedRows = rows.map((row) => ({ ...row, __file: entry.innerName, __container: entry.outerName }));
      raw[parser].push(...enrichedRows);
      recognizedFiles.push({
        ...baseInfo,
        status: 'Usado',
        category: parser,
        details: parser === 'krakenLedgers' ? 'Base principal para reconstrução de movimentos.'
          : parser === 'krakenTrades' ? 'Útil para complementar contexto de trades.'
          : parser === 'krakenBalances' ? 'Opcional, usado como referência adicional.'
          : 'Movimentos Robinhood lidos com sucesso.',
        recommended: parser === 'krakenLedgers' || parser === 'krakenTrades',
      });
    }
  }

  return { raw, recognizedFiles };
}

export function normalizeRaw(raw, settings) {
  const transactions = [];
  const derivedPrices = [];
  let ignoredTechnical = 0;
  let sourceOrder = 1;

  for (const row of raw.robinhood) {
    const type = String(row['Transaction Type'] || '').trim();
    const date = formatDateOnly(row['Activity Date']);
    const asset = cleanAsset(row['Instrument']);
    const quantity = parseNumber(row['Instrument Quantity']);
    const unitPrice = parseNumber(row['Instrument Price']);
    const fee = parseNumber(row['Fees']);
    const debit = parseNumber(row['Debit']);
    const credit = parseNumber(row['Credit']);

    if (asset && unitPrice > 0) {
      derivedPrices.push({ asset, date, price_eur: unitPrice, source: 'ficheiro original · Robinhood' });
    }

    if (type === 'Crypto Purchase') {
      transactions.push({
        id: crypto.randomUUID(),
        date,
        timestamp: row['Activity Date'],
        platform: 'robinhood',
        asset,
        type: 'Compra em fiat',
        kind: 'buy_fiat',
        quantity,
        grossEur: quantity * unitPrice,
        feeEur: fee,
        totalEur: debit || quantity * unitPrice + fee,
        sourceOrder: sourceOrder++,
        originFile: row.__file,
        rawReference: row,
      });
    } else if (type === 'Crypto Sale') {
      transactions.push({
        id: crypto.randomUUID(),
        date,
        timestamp: row['Activity Date'],
        platform: 'robinhood',
        asset,
        type: 'Venda para fiat',
        kind: 'sell_fiat',
        quantity,
        grossEur: quantity * unitPrice,
        feeEur: fee,
        netEur: credit || quantity * unitPrice - fee,
        sourceOrder: sourceOrder++,
        originFile: row.__file,
        rawReference: row,
      });
    } else if (type === 'Crypto Reward') {
      transactions.push({
        id: crypto.randomUUID(),
        date,
        timestamp: row['Activity Date'],
        platform: 'robinhood',
        asset,
        type: 'Reward',
        kind: 'reward',
        quantity,
        referenceEur: credit || quantity * unitPrice,
        sourceOrder: sourceOrder++,
        originFile: row.__file,
        rawReference: row,
      });
    } else if (type === 'SEPA Deposit' || type === 'SEPA Withdrawal') {
      transactions.push({
        id: crypto.randomUUID(),
        date,
        timestamp: row['Activity Date'],
        platform: 'robinhood',
        asset: 'EUR',
        type: type === 'SEPA Deposit' ? 'Entrada fiat' : 'Saída fiat',
        kind: type === 'SEPA Deposit' ? 'fiat_deposit' : 'fiat_withdrawal',
        quantity: 0,
        grossEur: credit || debit,
        sourceOrder: sourceOrder++,
        originFile: row.__file,
        rawReference: row,
      });
    }
  }

  const ledgers = raw.krakenLedgers.map((row) => ({
    ...row,
    normalizedAsset: cleanAsset(row.asset),
    normalizedDate: formatDateOnly(row.time),
    normalizedAmount: parseNumber(row.amount),
    normalizedFee: parseNumber(row.fee),
  }));

  const groups = ledgers.reduce((map, row) => {
    const key = `${row.refid}|${row.time}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
    return map;
  }, new Map());

  for (const rows of groups.values()) {
    const date = rows[0].normalizedDate;
    const timestamp = rows[0].time;
    const technicalRows = rows.filter((row) => String(row.subtype || '').toLowerCase().includes('dust') || String(row.type || '').toLowerCase().includes('dust'));

    if (technicalRows.length && settings.ignoreDust) {
      ignoredTechnical += technicalRows.length;
      transactions.push({
        id: crypto.randomUUID(),
        date,
        timestamp,
        platform: 'kraken',
        asset: technicalRows[0].normalizedAsset,
        type: 'Movimento técnico',
        kind: 'technical_dust',
        quantity: Math.abs(technicalRows.reduce((sum, row) => sum + row.normalizedAmount, 0)),
        sourceOrder: sourceOrder++,
        originFile: technicalRows[0].__file,
        rawReference: technicalRows,
        note: 'Movimento técnico ignorado por política ativa.',
      });
      continue;
    }

    const deposits = rows.filter((row) => row.type === 'deposit');
    const rewards = rows.filter((row) => row.type === 'reward');
    const earnRewards = rows.filter((row) => row.type === 'earn' && row.subtype === 'reward');
    const spends = rows.filter((row) => row.type === 'spend');
    const receives = rows.filter((row) => row.type === 'receive');

    for (const reward of rewards) {
      transactions.push({
        id: crypto.randomUUID(),
        date,
        timestamp,
        platform: 'kraken',
        asset: reward.normalizedAsset,
        type: 'Reward',
        kind: 'reward',
        quantity: Math.max(0, reward.normalizedAmount - reward.normalizedFee),
        sourceOrder: sourceOrder++,
        originFile: reward.__file,
        rawReference: reward,
      });
    }

    for (const reward of earnRewards) {
      transactions.push({
        id: crypto.randomUUID(),
        date,
        timestamp,
        platform: 'kraken',
        asset: reward.normalizedAsset,
        type: 'Staking reward',
        kind: 'staking_reward',
        quantity: Math.max(0, reward.normalizedAmount - reward.normalizedFee),
        sourceOrder: sourceOrder++,
        originFile: reward.__file,
        rawReference: reward,
      });
    }

    for (const deposit of deposits) {
      if (deposit.subclass === 'fiat' || deposit.normalizedAsset === 'EUR') {
        transactions.push({
          id: crypto.randomUUID(),
          date,
          timestamp,
          platform: 'kraken',
          asset: 'EUR',
          type: 'Entrada fiat',
          kind: 'fiat_deposit',
          quantity: 0,
          grossEur: deposit.normalizedAmount,
          sourceOrder: sourceOrder++,
        originFile: deposit.__file,
          rawReference: deposit,
        });
      } else {
        transactions.push({
          id: crypto.randomUUID(),
          date,
          timestamp,
          platform: 'kraken',
          asset: deposit.normalizedAsset,
          type: 'Depósito externo',
          kind: 'external_deposit',
          quantity: deposit.normalizedAmount,
          sourceOrder: sourceOrder++,
        originFile: deposit.__file,
          rawReference: deposit,
        });
      }
    }

    const cryptoSpends = spends.filter((row) => ['crypto', 'stable_coin'].includes(row.subclass) && !String(row.subtype || '').toLowerCase().includes('dust'));
    const fiatSpends = spends.filter((row) => row.normalizedAsset === 'EUR' || row.subclass === 'fiat' || row.subclass === 'hold');
    const cryptoReceives = receives.filter((row) => ['crypto', 'stable_coin'].includes(row.subclass) && !String(row.subtype || '').toLowerCase().includes('dust'));
    const fiatReceives = receives.filter((row) => row.normalizedAsset === 'EUR' || row.subclass === 'fiat' || row.subclass === 'hold');

    if (fiatSpends.length && cryptoReceives.length) {
      const grossEur = Math.max(0, fiatSpends.reduce((sum, row) => sum + Math.abs(row.normalizedAmount), 0) - fiatSpends.reduce((sum, row) => sum + Math.abs(row.normalizedFee), 0));
      const feeEur = fiatSpends.reduce((sum, row) => sum + Math.abs(row.normalizedFee), 0);
      const quantity = cryptoReceives.reduce((sum, row) => sum + Math.abs(row.normalizedAmount), 0);
      const asset = cryptoReceives[0].normalizedAsset;
      if (quantity > 0 && grossEur > 0) derivedPrices.push({ asset, date, price_eur: grossEur / quantity, source: 'trade em fiat derivado do ledger' });
      transactions.push({
        id: crypto.randomUUID(),
        date,
        timestamp,
        platform: 'kraken',
        asset,
        type: 'Compra em fiat',
        kind: 'buy_fiat',
        quantity,
        grossEur,
        feeEur,
        totalEur: grossEur + feeEur,
        sourceOrder: sourceOrder++,
        originFile: rows[0].__file,
        rawReference: rows,
      });
    }

    if (cryptoSpends.length && fiatReceives.length) {
      const quantity = cryptoSpends.reduce((sum, row) => sum + Math.abs(row.normalizedAmount), 0);
      const grossEur = fiatReceives.reduce((sum, row) => sum + Math.abs(row.normalizedAmount), 0);
      const feeEur = fiatReceives.reduce((sum, row) => sum + Math.abs(row.normalizedFee), 0);
      const asset = cryptoSpends[0].normalizedAsset;
      if (quantity > 0 && grossEur > 0) derivedPrices.push({ asset, date, price_eur: grossEur / quantity, source: 'venda em fiat derivada do ledger' });
      transactions.push({
        id: crypto.randomUUID(),
        date,
        timestamp,
        platform: 'kraken',
        asset,
        type: 'Venda para fiat',
        kind: 'sell_fiat',
        quantity,
        grossEur,
        feeEur,
        netEur: grossEur - feeEur,
        sourceOrder: sourceOrder++,
        originFile: rows[0].__file,
        rawReference: rows,
      });
    }

    if (cryptoSpends.length && cryptoReceives.length && !fiatSpends.length && !fiatReceives.length) {
      transactions.push({
        id: crypto.randomUUID(),
        date,
        timestamp,
        platform: 'kraken',
        asset: `${cryptoSpends[0].normalizedAsset}→${cryptoReceives[0].normalizedAsset}`,
        type: 'Swap',
        kind: 'swap',
        assetOut: cryptoSpends[0].normalizedAsset,
        assetIn: cryptoReceives[0].normalizedAsset,
        quantityOut: cryptoSpends.reduce((sum, row) => sum + Math.abs(row.normalizedAmount), 0),
        quantityIn: cryptoReceives.reduce((sum, row) => sum + Math.abs(row.normalizedAmount), 0),
        sourceOrder: sourceOrder++,
        originFile: rows[0].__file,
        rawReference: rows,
      });
    }
  }

  transactions.sort((a, b) => {
    const timeDiff = new Date(a.timestamp || `${a.date}T12:00:00`) - new Date(b.timestamp || `${b.date}T12:00:00`);
    if (timeDiff !== 0) return timeDiff;
    const priorityDiff = transactionPriority(a.kind) - transactionPriority(b.kind);
    if (priorityDiff !== 0) return priorityDiff;
    return (a.sourceOrder || 0) - (b.sourceOrder || 0);
  });

  return { transactions, derivedPrices, ignoredTechnical };
}
