import { daysBetween, platformCountrySuggestions, platformLabel, round, transactionPriority } from './utils.js';
import { getPrice } from './prices.js';

function createReview({ type, severity, title, message, suggestion, data = {}, actions = [] }) {
  return {
    id: crypto.randomUUID(),
    type,
    severity,
    title,
    message,
    suggestion,
    data,
    actions,
    resolved: false,
    resolution: '',
  };
}



function sortTransactionsForFiscal(transactions) {
  return [...transactions].sort((a, b) => {
    const timeDiff = new Date(a.timestamp || `${a.date}T12:00:00`) - new Date(b.timestamp || `${b.date}T12:00:00`);
    if (timeDiff !== 0) return timeDiff;
    const priorityDiff = transactionPriority(a.kind) - transactionPriority(b.kind);
    if (priorityDiff !== 0) return priorityDiff;
    return (a.sourceOrder || 0) - (b.sourceOrder || 0);
  });
}

function summarizeLineage(lineage = []) {
  if (!lineage.length) return '';
  if (lineage.length <= 3) return lineage.join(' → ');
  return `${lineage.slice(0, 2).join(' → ')} → … → ${lineage.at(-1)}`;
}

function buildRecommendedEvidence({ salePlatform, lotSourceType, lineage = [], heldDays }) {
  const docs = [];
  if (salePlatform === 'kraken') {
    docs.push('Ledger CSV da Kraken com a venda');
    docs.push('Trades CSV da Kraken (se existir)');
  } else if (salePlatform === 'robinhood') {
    docs.push('Activity CSV da Robinhood com a venda');
  } else {
    docs.push('Relatório/CSV da plataforma onde ocorreu a venda');
  }

  docs.push('Comprovativo do lote de aquisição original');
  docs.push('Registo das comissões/fees da compra e da venda');

  if (String(lotSourceType || '').includes('Transferência')) {
    docs.push('Comprovativo de levantamento na plataforma de origem');
    docs.push('TX hash / identificador da transferência');
    docs.push('Comprovativo de depósito na plataforma de destino');
  }

  if (String(lotSourceType || '').toLowerCase().includes('reward')) {
    docs.push('Linha do reward no relatório da plataforma');
    docs.push('Preço de referência usado para o lote na data do reward');
  }

  if (String(lotSourceType || '').toLowerCase().includes('staking')) {
    docs.push('Relatório de staking/earn e créditos recebidos');
  }

  if (heldDays >= 365) {
    docs.push('Prova da data de aquisição para sustentar o período de detenção ≥ 365 dias');
  }

  return Array.from(new Set(docs));
}

export function processFiscal({ transactions, prices, settings, overrides = [] }) {
  const reviewItems = [];
  const auditTrail = [];
  const transferLinks = [];
  const lots = [];
  const closedLots = [];
  const taxableDisposals = [];
  const exemptDisposals = [];

  let sequence = 1;

  const activeOverrides = new Map(overrides.map((item) => [item.targetId, item]));
  const orderedTransactions = sortTransactionsForFiscal(transactions);

  function addLot(payload) {
    lots.push({
      id: `L${String(sequence++).padStart(5, '0')}`,
      platform: payload.platform,
      asset: payload.asset,
      acquisitionDate: payload.acquisitionDate,
      quantityOriginal: round(payload.quantity, 12),
      quantityRemaining: round(payload.quantity, 12),
      costBasisRemaining: round(payload.costBasis || 0, 10),
      acquisitionFeesRemaining: round(payload.acquisitionFees || 0, 10),
      status: 'Aberto',
      sourceType: payload.sourceType,
      sourceTransactionId: payload.sourceTransactionId || '',
      parentLotId: payload.parentLotId || '',
      note: payload.note || '',
      lineage: payload.lineage || [],
    });
  }

  function eligibleLots(asset, platform, date) {
    return lots
      .filter((lot) => lot.asset === asset && lot.platform === platform && lot.quantityRemaining > 1e-18 && lot.acquisitionDate <= date)
      .sort((a, b) => `${a.acquisitionDate}${a.id}`.localeCompare(`${b.acquisitionDate}${b.id}`));
  }

  function otherPlatformLots(asset, platform, date) {
    return lots
      .filter((lot) => lot.asset === asset && lot.platform !== platform && lot.quantityRemaining > 1e-18 && lot.acquisitionDate <= date)
      .sort((a, b) => `${a.acquisitionDate}${a.id}`.localeCompare(`${b.acquisitionDate}${b.id}`));
  }

  function buildAutoTransferPlan(tx) {
    const candidates = otherPlatformLots(tx.asset, tx.platform, tx.date);
    if (!candidates.length || tx.quantity <= 1e-18) return null;

    const byPlatform = new Map();
    for (const lot of candidates) {
      if (!byPlatform.has(lot.platform)) byPlatform.set(lot.platform, []);
      byPlatform.get(lot.platform).push(lot);
    }

    if (byPlatform.size !== 1) return null;

    const [[sourcePlatform, sourceLots]] = [...byPlatform.entries()];
    let remaining = tx.quantity;
    const planParts = [];

    for (const sourceLot of sourceLots) {
      if (remaining <= 1e-18) break;
      const consumed = Math.min(sourceLot.quantityRemaining, remaining);
      if (consumed <= 1e-18) continue;
      planParts.push({ sourceLot, consumed });
      remaining -= consumed;
    }

    const tolerance = Math.max(1e-8, tx.quantity * 0.001);
    if (remaining > tolerance) return null;

    return {
      sourcePlatform,
      parts: planParts,
      confidence: planParts.length === 1 ? 'high' : 'medium',
    };
  }

  function consumeLots(platform, asset, quantity, date, transaction) {
    let remaining = quantity;
    const consumption = [];
    for (const lot of eligibleLots(asset, platform, date)) {
      if (remaining <= 1e-18) break;
      const consumed = Math.min(lot.quantityRemaining, remaining);
      const ratio = consumed / lot.quantityRemaining;
      const basis = lot.costBasisRemaining * ratio;
      const fees = lot.acquisitionFeesRemaining * ratio;
      lot.quantityRemaining = round(lot.quantityRemaining - consumed, 12);
      lot.costBasisRemaining = round(lot.costBasisRemaining - basis, 10);
      lot.acquisitionFeesRemaining = round(lot.acquisitionFeesRemaining - fees, 10);
      if (lot.quantityRemaining <= 1e-18) {
        lot.status = 'Fechado';
        closedLots.push(structuredClone(lot));
      }
      consumption.push({ lotId: lot.id, quantity: consumed, acquisitionDate: lot.acquisitionDate, costBasis: basis, acquisitionFees: fees, sourceType: lot.sourceType, platform: lot.platform, lineage: lot.lineage });
      remaining -= consumed;
    }
    if (remaining > 1e-12) {
      reviewItems.push(createReview({
        type: 'Falta de lote',
        severity: 'Alta',
        title: `Faltam lotes para ${asset}`,
        message: `A venda ou saída em ${platform} não ficou totalmente coberta pelos lotes disponíveis até ${date}.`,
        suggestion: 'Rever transferências anteriores, depósitos externos ou preços em falta.',
        data: { platform, asset, quantityMissing: round(remaining, 12), date, transactionId: transaction.id },
        actions: ['mark-reviewed'],
      }));
    }
    return { consumption, uncoveredQuantity: round(Math.max(0, remaining), 12) };
  }

  for (const tx of orderedTransactions) {
    const override = activeOverrides.get(tx.id);

    if (tx.kind === 'technical_dust') {
      auditTrail.push({
        id: crypto.randomUUID(),
        title: 'Movimento técnico ignorado',
        message: 'O sistema ignorou um movimento técnico por política ativa, para evitar falsos positivos fiscais.',
        confidence: 'high',
        date: tx.date,
        transactionId: tx.id,
      });
      continue;
    }

    if (tx.kind === 'buy_fiat') {
      addLot({
        platform: tx.platform,
        asset: tx.asset,
        acquisitionDate: tx.date,
        quantity: tx.quantity,
        costBasis: tx.grossEur,
        acquisitionFees: tx.feeEur || 0,
        sourceType: 'Compra',
        sourceTransactionId: tx.id,
        note: 'Lote criado a partir de compra em fiat.',
        lineage: [`Compra ${tx.platform} ${tx.date}`],
      });
      auditTrail.push({ id: crypto.randomUUID(), title: 'Novo lote criado', message: `A compra de ${tx.asset} criou um novo lote com custo de aquisição associado.`, confidence: 'high', date: tx.date, transactionId: tx.id });
      continue;
    }

    if (tx.kind === 'reward' || tx.kind === 'staking_reward') {
      const manualPriceOverride = override?.type === 'manual-price' ? Number(override.value) : null;
      const price = manualPriceOverride || getPrice(prices, tx.asset, tx.date);
      if (!price) {
        reviewItems.push(createReview({
          type: 'Preço em falta',
          severity: 'Alta',
          title: `Falta preço para ${tx.asset}`,
          message: `Não foi possível determinar um preço EUR suficientemente credível para ${tx.asset} em ${tx.date}.`,
          suggestion: 'Introduzir um preço manual ou importar uma base de preços.',
          data: { asset: tx.asset, date: tx.date, transactionId: tx.id },
          actions: ['assign-price', 'mark-reviewed'],
        }));
      }
      addLot({
        platform: tx.platform,
        asset: tx.asset,
        acquisitionDate: tx.date,
        quantity: tx.quantity,
        costBasis: round((price || 0) * tx.quantity, 10),
        acquisitionFees: 0,
        sourceType: tx.kind === 'staking_reward' ? 'Staking reward' : 'Reward',
        sourceTransactionId: tx.id,
        note: 'Este reward foi tratado como um novo lote.',
        lineage: [`${tx.kind === 'staking_reward' ? 'Staking reward' : 'Reward'} ${tx.platform} ${tx.date}`],
      });
      auditTrail.push({ id: crypto.randomUUID(), title: 'Reward convertido em lote', message: `O movimento ${tx.kind === 'staking_reward' ? 'de staking reward' : 'de reward'} gerou um novo lote para ${tx.asset}.`, confidence: price ? 'high' : 'medium', date: tx.date, transactionId: tx.id });
      continue;
    }

    if (tx.kind === 'external_deposit') {
      let remaining = tx.quantity;
      let matched = false;
      if (settings.autoContinuity && override?.type !== 'accept-external') {
        const plan = buildAutoTransferPlan(tx);
        if (plan?.parts?.length) {
          matched = true;
          for (const { sourceLot, consumed } of plan.parts) {
            const ratio = consumed / sourceLot.quantityRemaining;
            const costBasis = sourceLot.costBasisRemaining * ratio;
            const fees = sourceLot.acquisitionFeesRemaining * ratio;
            sourceLot.quantityRemaining = round(sourceLot.quantityRemaining - consumed, 12);
            sourceLot.costBasisRemaining = round(sourceLot.costBasisRemaining - costBasis, 10);
            sourceLot.acquisitionFeesRemaining = round(sourceLot.acquisitionFeesRemaining - fees, 10);
            addLot({
              platform: tx.platform,
              asset: tx.asset,
              acquisitionDate: sourceLot.acquisitionDate,
              quantity: consumed,
              costBasis,
              acquisitionFees: fees,
              sourceType: 'Transferência reconciliada',
              sourceTransactionId: tx.id,
              parentLotId: sourceLot.id,
              note: 'Continuidade assumida entre plataformas após correspondência unívoca por ativo, plataforma e quantidade.',
              lineage: [...sourceLot.lineage, `Transferência para ${tx.platform} ${tx.date}`],
            });
            transferLinks.push({ fromLotId: sourceLot.id, fromPlatform: sourceLot.platform, toPlatform: tx.platform, asset: tx.asset, quantity: consumed, date: tx.date, mode: 'carry basis + carry data' });
            remaining -= consumed;
          }
          auditTrail.push({ id: crypto.randomUUID(), title: 'Transferência reconciliada', message: `O depósito de ${tx.asset} em ${tx.platform} foi ligado automaticamente a lotes de ${plan.sourcePlatform} por correspondência unívoca.`, confidence: plan.confidence, date: tx.date, transactionId: tx.id });
        }
      }

      if (override?.type === 'assume-transfer') {
        const sourceLotId = override.sourceLotId;
        const sourceLot = lots.find((lot) => lot.id === sourceLotId && lot.asset === tx.asset && lot.quantityRemaining > 1e-18);
        if (sourceLot) {
          const consumed = Math.min(sourceLot.quantityRemaining, remaining);
          const ratio = consumed / sourceLot.quantityRemaining;
          const costBasis = sourceLot.costBasisRemaining * ratio;
          const fees = sourceLot.acquisitionFeesRemaining * ratio;
          sourceLot.quantityRemaining = round(sourceLot.quantityRemaining - consumed, 12);
          sourceLot.costBasisRemaining = round(sourceLot.costBasisRemaining - costBasis, 10);
          sourceLot.acquisitionFeesRemaining = round(sourceLot.acquisitionFeesRemaining - fees, 10);
          addLot({
            platform: tx.platform,
            asset: tx.asset,
            acquisitionDate: sourceLot.acquisitionDate,
            quantity: consumed,
            costBasis,
            acquisitionFees: fees,
            sourceType: 'Transferência manual',
            sourceTransactionId: tx.id,
            parentLotId: sourceLot.id,
            note: 'Transferência assumida manualmente.',
            lineage: [...sourceLot.lineage, `Transferência manual para ${tx.platform} ${tx.date}`],
          });
          transferLinks.push({ fromLotId: sourceLot.id, fromPlatform: sourceLot.platform, toPlatform: tx.platform, asset: tx.asset, quantity: consumed, date: tx.date, mode: 'manual' });
          auditTrail.push({ id: crypto.randomUUID(), title: 'Transferência manual aplicada', message: `O utilizador ligou manualmente o depósito a um lote anterior.`, confidence: 'medium', date: tx.date, transactionId: tx.id });
          remaining -= consumed;
          matched = true;
        }
      }

      if (remaining > 1e-12) {
        const manualPrice = override?.type === 'manual-price' ? Number(override.value) : null;
        const price = manualPrice || getPrice(prices, tx.asset, tx.date);
        addLot({
          platform: tx.platform,
          asset: tx.asset,
          acquisitionDate: tx.date,
          quantity: remaining,
          costBasis: round((price || 0) * remaining, 10),
          acquisitionFees: 0,
          sourceType: matched ? 'Depósito parcial não reconciliado' : 'Depósito externo',
          sourceTransactionId: tx.id,
          note: matched ? 'Parte do depósito ficou fora da reconciliação automática.' : 'Depósito externo tratado como novo lote.',
          lineage: [`Depósito em ${tx.platform} ${tx.date}`],
        });

        if (!matched && override?.type !== 'accept-external') {
          reviewItems.push(createReview({
            type: 'Transferência ambígua',
            severity: 'Média',
            title: `Depósito externo em ${tx.platform}`,
            message: `Esta operação parece poder corresponder a uma transferência entre plataformas, mas a ligação não ficou suficientemente clara.`,
            suggestion: 'Pode assumir transferência, aceitar como depósito externo ou completar informação de preço.',
            data: { asset: tx.asset, quantity: round(remaining, 12), date: tx.date, platform: tx.platform, transactionId: tx.id },
            actions: ['assume-transfer', 'accept-external', 'assign-price', 'mark-reviewed'],
          }));
        }
        if (!price && override?.type !== 'accept-external') {
          reviewItems.push(createReview({
            type: 'Preço em falta',
            severity: 'Alta',
            title: `Sem preço EUR para depósito de ${tx.asset}`,
            message: 'Faltam dados para estimar o custo de aquisição deste lote externo.',
            suggestion: 'Atribuir um preço manual ou importar dados complementares.',
            data: { asset: tx.asset, date: tx.date, platform: tx.platform, transactionId: tx.id },
            actions: ['assign-price', 'mark-reviewed'],
          }));
        }
      }
      continue;
    }

    if (tx.kind === 'swap') {
      const { consumption, uncoveredQuantity } = consumeLots(tx.platform, tx.assetOut, tx.quantityOut, tx.date, tx);
      const totalQuantity = consumption.reduce((sum, part) => sum + part.quantity, 0);
      const totalBasis = consumption.reduce((sum, part) => sum + part.costBasis, 0);
      const totalFees = consumption.reduce((sum, part) => sum + part.acquisitionFees, 0);
      if (totalQuantity > 0 && tx.quantityIn > 0) {
        if (settings.swapPolicy === 'carry_data') {
          for (const part of consumption) {
            const share = part.quantity / totalQuantity;
            addLot({
              platform: tx.platform,
              asset: tx.assetIn,
              acquisitionDate: part.acquisitionDate,
              quantity: tx.quantityIn * share,
              costBasis: part.costBasis,
              acquisitionFees: part.acquisitionFees,
              sourceType: 'Swap com continuidade de data',
              sourceTransactionId: tx.id,
              parentLotId: part.lotId,
              note: 'Swap tratado com carry basis + carry data.',
              lineage: [...part.lineage, `Swap ${tx.assetOut}→${tx.assetIn} ${tx.date}`],
            });
          }
        } else {
          addLot({
            platform: tx.platform,
            asset: tx.assetIn,
            acquisitionDate: tx.date,
            quantity: tx.quantityIn,
            costBasis: totalBasis,
            acquisitionFees: totalFees,
            sourceType: 'Swap com reset de data',
            sourceTransactionId: tx.id,
            note: 'Swap tratado com carry basis + reset data.',
            lineage: [`Swap ${tx.assetOut}→${tx.assetIn} ${tx.date}`],
          });
        }
        auditTrail.push({ id: crypto.randomUUID(), title: 'Swap processado', message: `O swap ${tx.assetOut}→${tx.assetIn} foi processado segundo a política ativa.`, confidence: uncoveredQuantity ? 'medium' : 'high', date: tx.date, transactionId: tx.id });
      }
      continue;
    }

    if (tx.kind === 'sell_fiat') {
      const { consumption } = consumeLots(tx.platform, tx.asset, tx.quantity, tx.date, tx);
      const totalQuantity = consumption.reduce((sum, part) => sum + part.quantity, 0);
      for (const part of consumption) {
        const share = totalQuantity > 0 ? part.quantity / totalQuantity : 0;
        const saleValue = round(tx.grossEur * share, 10);
        const disposalFees = round((tx.feeEur || 0) * share, 10);
        const gain = round(saleValue - part.costBasis - part.acquisitionFees - disposalFees, 10);
        const heldDays = daysBetween(part.acquisitionDate, tx.date);
        const estimatedTax = heldDays < 365 ? Math.max(0, gain * (settings.taxRate / 100)) : 0;
        const recommendedEvidence = buildRecommendedEvidence({
          salePlatform: tx.platform,
          lotSourceType: part.sourceType,
          lineage: part.lineage,
          heldDays,
        });
        const line = {
          id: crypto.randomUUID(),
          platform: tx.platform,
          platformLabel: platformLabel(tx.platform),
          asset: tx.asset,
          quantity: round(part.quantity, 12),
          acquisitionDate: part.acquisitionDate,
          saleDate: tx.date,
          acquisitionValue: round(part.costBasis, 10),
          saleValue,
          expenses: round(part.acquisitionFees + disposalFees, 10),
          gainEstimate: gain,
          heldDays,
          estimatedTax: round(estimatedTax, 10),
          countrySource: platformCountrySuggestions[tx.platform] || '',
          sourceLotId: part.lotId,
          lotSourceType: part.sourceType,
          lotLineage: summarizeLineage(part.lineage),
          irsFormSuggestion: heldDays < 365 ? 'Anexo J 9.4A (sugerido)' : 'Anexo G1 Quadro 7 (sugerido)',
          recommendedEvidence,
          recommendedEvidenceText: recommendedEvidence.join(' | '),
          note: heldDays < 365 ? 'Operação potencialmente tributável' : 'Operação fora do período potencialmente tributável',
        };
        if (heldDays < 365) taxableDisposals.push(line);
        else exemptDisposals.push(line);
      }
      auditTrail.push({ id: crypto.randomUUID(), title: 'Venda processada com FIFO', message: `A venda de ${tx.asset} em ${tx.platform} foi repartida pelos lotes FIFO disponíveis.`, confidence: 'high', date: tx.date, transactionId: tx.id });
      continue;
    }
  }

  const remainingOpenLots = lots.filter((lot) => lot.quantityRemaining > 1e-18).map((lot) => ({ ...lot, quantityRemaining: round(lot.quantityRemaining, 12), costBasisRemaining: round(lot.costBasisRemaining, 10), acquisitionFeesRemaining: round(lot.acquisitionFeesRemaining, 10) }));

  return {
    lots: remainingOpenLots,
    closedLots,
    taxableDisposals,
    exemptDisposals,
    reviewItems,
    auditTrail,
    transferLinks,
  };
}
