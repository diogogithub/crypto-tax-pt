import { state } from './state.js';
import { buildPriceReviewRows } from './prices.js';
import { classifyConfidence, classifySeverity, downloadCsv, downloadJson, el, escapeHtml, formatCurrency, uniqueSorted } from './utils.js';

function badge(label, className = 'badge-neutral') {
  return `<span class="badge ${className}">${escapeHtml(label)}</span>`;
}

function renderEmpty(hostId, message) {
  el(hostId).innerHTML = `<div class="empty-state"><p>${escapeHtml(message)}</p></div>`;
}

function tableHtml(columns, rows, detailsBuilder) {
  if (!rows.length) return '<div class="empty-state"><p>Sem dados para mostrar.</p></div>';
  const head = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('');
  const body = rows.map((row) => {
    const cells = columns.map((column) => `<td>${column.render ? column.render(row) : escapeHtml(row[column.key] ?? '')}</td>`).join('');
    const details = detailsBuilder ? `<tr><td colspan="${columns.length}">${detailsBuilder(row)}</td></tr>` : '';
    return `<tr>${cells}</tr>${details}`;
  }).join('');
  return `<div class="table-wrap"><table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderSelect(selectId, values, placeholder) {
  const select = el(selectId);
  if (!select) return;
  const previous = select.value;
  const options = uniqueSorted(values, placeholder).map((value, index) => `<option value="${index === 0 ? '' : escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  select.innerHTML = options;
  if (previous && Array.from(select.options).some((option) => option.value === previous)) select.value = previous;
}

function activeValue(id) {
  return el(id)?.value || '';
}

function filterByText(row, search) {
  if (!search) return true;
  const haystack = JSON.stringify(row).toLowerCase();
  return haystack.includes(search.toLowerCase());
}

export function syncSettingsToInputs() {
  el('taxYear').value = state.settings.taxYear;
  el('taxRate').value = state.settings.taxRate;
  el('autoContinuity').checked = state.settings.autoContinuity;
  el('ignoreDust').checked = state.settings.ignoreDust;
  el('swapPolicy').value = state.settings.swapPolicy;
  if (el('coinGeckoAutoFill')) el('coinGeckoAutoFill').checked = state.settings.coinGeckoAutoFill;
  if (el('coinGeckoApiKey')) el('coinGeckoApiKey').value = state.settings.coinGeckoApiKey || '';
}

export function renderMetrics() {
  el('metricTransactions').textContent = String(state.transactions.length);
  el('metricLots').textContent = String(state.lots.length);
  el('metricReviews').textContent = String(state.reviewItems.filter((item) => !item.resolved).length);

  const taxableNetGain = state.taxableDisposals.reduce((sum, row) => {
    return sum + Number(row.gainEstimate || 0);
  }, 0);

  const estimatedTax = Math.max(
    0,
    taxableNetGain * (Number(state.settings.taxRate || 0) / 100),
  );

  el('metricTax').textContent = formatCurrency(estimatedTax);
}

export function renderProcessingSummary() {
  if (!state.transactions.length) {
    renderEmpty('processingSummary', 'Ainda não existem dados processados.');
    return;
  }
  el('processingSummary').innerHTML = `
    <ul class="summary-list">
      <li>${state.summary.importedMovements} movimentos importados dos ficheiros.</li>
      <li>${state.summary.classifiedMovements} movimentos normalizados e classificados.</li>
      <li>${state.summary.lotsCreated} lotes criados ou reencadeados.</li>
      <li>${state.summary.reconciledTransfers} transferências entre plataformas reconciliadas.</li>
      <li>${state.summary.reviewPoints} pontos pendentes de revisão.</li>
      <li>${state.summary.missingPrices} situações com preços em falta.</li>
      <li>${state.summary.ignoredTechnical} movimentos técnicos ignorados pela política ativa.</li>
    </ul>
  `;
}

export function renderAuditTrail() {
  if (!state.auditTrail.length) {
    renderEmpty('auditTrail', 'Ainda não há decisões automáticas registadas.');
    return;
  }
  el('auditTrail').innerHTML = `<div class="audit-list">${state.auditTrail.slice(0, 24).map((item) => `
    <article class="audit-item">
      <div class="inline-meta">
        ${badge(item.confidence === 'high' ? 'Confiança alta' : item.confidence === 'medium' ? 'Confiança média' : 'Confiança baixa', classifyConfidence(item.confidence))}
        <span class="meta-tag">${escapeHtml(item.date || '')}</span>
      </div>
      <h4>${escapeHtml(item.title)}</h4>
      <p>${escapeHtml(item.message)}</p>
    </article>
  `).join('')}</div>`;
}

export function renderFileQueue() {
  if (!state.queueFiles.length) {
    renderEmpty('fileQueue', 'Sem ficheiros selecionados.');
    return;
  }
  el('fileQueue').innerHTML = `<div class="file-list">${state.queueFiles.map((file) => `
    <article class="file-item">
      <h4>${escapeHtml(file.name)}</h4>
      <div class="file-meta">
        <span class="meta-tag">${Math.round(file.size / 1024)} KB</span>
        <span class="meta-tag">${escapeHtml(file.type || 'tipo não indicado')}</span>
      </div>
    </article>
  `).join('')}</div>`;
}

export function renderRecognizedFiles() {
  if (!state.recognizedFiles.length) {
    renderEmpty('recognizedFiles', 'Depois do processamento, aqui verá o estado de cada ficheiro.');
    return;
  }
  el('recognizedFiles').innerHTML = `<div class="file-list">${state.recognizedFiles.map((item) => `
    <article class="file-item">
      <div class="inline-meta">
        ${badge(item.status, item.status === 'Usado' ? 'badge-good' : item.status === 'Não reconhecido' ? 'badge-bad' : 'badge-neutral')}
        ${item.recommended ? badge('Recomendado', 'badge-warn') : ''}
        <span class="meta-tag">${escapeHtml(item.category)}</span>
        <span class="meta-tag">${item.rows} linhas</span>
      </div>
      <h4>${escapeHtml(item.innerName)}</h4>
      <p>${escapeHtml(item.details)}</p>
      <div class="file-meta">
        <span class="meta-tag">Origem: ${escapeHtml(item.outerName)}</span>
      </div>
    </article>
  `).join('')}</div>`;
}

export function renderHistory() {
  const rows = state.transactions;
  renderSelect('historyPlatformFilter', rows.map((row) => row.platform), 'Todas as plataformas');
  renderSelect('historyAssetFilter', rows.map((row) => row.asset || row.assetOut || row.assetIn), 'Todos os ativos');
  renderSelect('historyTypeFilter', rows.map((row) => row.type), 'Todos os tipos');
  renderSelect('historyYearFilter', rows.map((row) => String(row.date).slice(0, 4)), 'Todos os anos');

  const filtered = rows.filter((row) => {
    if (!filterByText(row, activeValue('historySearch'))) return false;
    if (activeValue('historyPlatformFilter') && row.platform !== activeValue('historyPlatformFilter')) return false;
    const assetValue = row.asset || row.assetOut || row.assetIn;
    if (activeValue('historyAssetFilter') && assetValue !== activeValue('historyAssetFilter')) return false;
    if (activeValue('historyTypeFilter') && row.type !== activeValue('historyTypeFilter')) return false;
    if (activeValue('historyYearFilter') && !String(row.date).startsWith(activeValue('historyYearFilter'))) return false;
    return true;
  });

  const columns = [
    { label: 'Data', key: 'date' },
    { label: 'Plataforma', key: 'platform', render: (row) => escapeHtml(row.platform) },
    { label: 'Tipo', key: 'type' },
    { label: 'Ativo', key: 'asset', render: (row) => escapeHtml(row.asset || `${row.assetOut}→${row.assetIn}`) },
    { label: 'Quantidade', key: 'quantity', render: (row) => escapeHtml(row.quantity ?? row.quantityOut ?? '') },
    { label: 'Origem', key: 'originFile' },
  ];

  el('historyTable').innerHTML = tableHtml(columns, filtered, (row) => `
    <div class="kv-list">
      <div class="kv-row"><dt>Classificação</dt><dd>${escapeHtml(row.kind)}</dd></div>
      <div class="kv-row"><dt>Detalhe</dt><dd>${escapeHtml(row.note || 'Sem nota adicional.')}</dd></div>
      <div class="kv-row"><dt>Valores</dt><dd>Bruto: ${escapeHtml(row.grossEur ?? '')} · Fee: ${escapeHtml(row.feeEur ?? '')} · Líquido: ${escapeHtml(row.netEur ?? '')}</dd></div>
    </div>
  `);
}

export function renderLots() {
  const rows = state.lots.concat(state.closedLots.map((lot) => ({ ...lot, status: 'Fechado' })));
  renderSelect('lotsPlatformFilter', rows.map((row) => row.platform), 'Todas as plataformas');
  renderSelect('lotsAssetFilter', rows.map((row) => row.asset), 'Todos os ativos');
  renderSelect('lotsStatusFilter', rows.map((row) => row.status), 'Todos os estados');

  const filtered = rows.filter((row) => {
    if (!filterByText(row, activeValue('lotsSearch'))) return false;
    if (activeValue('lotsPlatformFilter') && row.platform !== activeValue('lotsPlatformFilter')) return false;
    if (activeValue('lotsAssetFilter') && row.asset !== activeValue('lotsAssetFilter')) return false;
    if (activeValue('lotsStatusFilter') && row.status !== activeValue('lotsStatusFilter')) return false;
    return true;
  });

  const columns = [
    { label: 'Lote', key: 'id' },
    { label: 'Estado', key: 'status', render: (row) => badge(row.status, row.status === 'Fechado' ? 'badge-neutral' : 'badge-good') },
    { label: 'Ativo', key: 'asset' },
    { label: 'Plataforma', key: 'platform' },
    { label: 'Aquisição', key: 'acquisitionDate' },
    { label: 'Qtd. remanescente', key: 'quantityRemaining', render: (row) => escapeHtml(row.quantityRemaining ?? row.quantityOriginal) },
    { label: 'Custo remanescente', key: 'costBasisRemaining', render: (row) => formatCurrency(row.costBasisRemaining ?? 0) },
  ];

  el('lotsTable').innerHTML = tableHtml(columns, filtered, (row) => `
    <div class="kv-list">
      <div class="kv-row"><dt>Origem</dt><dd>${escapeHtml(row.sourceType)}</dd></div>
      <div class="kv-row"><dt>Quantidade original</dt><dd>${escapeHtml(row.quantityOriginal)}</dd></div>
      <div class="kv-row"><dt>Parent lot</dt><dd>${escapeHtml(row.parentLotId || '—')}</dd></div>
      <div class="kv-row"><dt>Encadeamento</dt><dd>${escapeHtml((row.lineage || []).join(' → ') || '—')}</dd></div>
      <div class="kv-row"><dt>Nota</dt><dd>${escapeHtml(row.note || '—')}</dd></div>
    </div>
  `);
}

export function renderReviews(onAction) {
  const unresolved = state.reviewItems.filter((item) => !item.resolved);
  renderSelect('reviewSeverityFilter', unresolved.map((item) => item.severity), 'Todas as gravidades');
  renderSelect('reviewTypeFilter', unresolved.map((item) => item.type), 'Todos os tipos');

  const filtered = unresolved.filter((item) => {
    if (!filterByText(item, activeValue('reviewSearch'))) return false;
    if (activeValue('reviewSeverityFilter') && item.severity !== activeValue('reviewSeverityFilter')) return false;
    if (activeValue('reviewTypeFilter') && item.type !== activeValue('reviewTypeFilter')) return false;
    return true;
  });

  if (!filtered.length) {
    renderEmpty('reviewBoard', 'Não existem pontos pendentes de revisão.');
    return;
  }

  el('reviewBoard').innerHTML = filtered.map((item) => `
    <article class="review-item" data-review-id="${item.id}">
      <div class="inline-meta">
        ${badge(item.severity, classifySeverity(item.severity))}
        ${badge(item.type, 'badge-neutral')}
      </div>
      <h4>${escapeHtml(item.title)}</h4>
      <p>${escapeHtml(item.message)}</p>
      <div class="kv-list">
        ${Object.entries(item.data).map(([key, value]) => `<div class="kv-row"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
      </div>
      <p><strong>Ação sugerida:</strong> ${escapeHtml(item.suggestion)}</p>
      <div class="review-actions">
        ${item.actions.includes('assign-price') ? `<button class="btn btn-secondary" data-action="assign-price">Atribuir preço</button>` : ''}
        ${item.actions.includes('assume-transfer') ? `<button class="btn btn-secondary" data-action="assume-transfer">Assumir transferência</button>` : ''}
        ${item.actions.includes('accept-external') ? `<button class="btn btn-secondary" data-action="accept-external">Aceitar depósito externo</button>` : ''}
        ${item.actions.includes('mark-non-fiscal') ? `<button class="btn btn-secondary" data-action="mark-non-fiscal">Marcar como não fiscal</button>` : ''}
        ${item.actions.includes('mark-reviewed') ? `<button class="btn btn-ghost" data-action="mark-reviewed">Marcar como revisto</button>` : ''}
      </div>
      <div class="review-note">
        <label>Nota opcional
          <input type="text" data-input="note" placeholder="Registo interno da decisão" />
        </label>
        <label class="price-input ${item.actions.includes('assign-price') ? '' : 'hidden'}">Preço manual (EUR)
          <input type="number" step="0.00000001" min="0" data-input="price" placeholder="Ex.: 123.45" />
        </label>
      </div>
    </article>
  `).join('');

  el('reviewBoard').querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const reviewId = button.closest('[data-review-id]').dataset.reviewId;
      const root = button.closest('[data-review-id]');
      const note = root.querySelector('[data-input="note"]')?.value || '';
      const price = root.querySelector('[data-input="price"]')?.value || '';
      onAction(reviewId, button.dataset.action, { note, price });
    });
  });
}


function nearbyPriceCell(date, price, distance, source) {
  if (!date) return '<span class="muted">—</span>';
  return `
    <div class="nearby-price">
      <strong>${escapeHtml(date)}</strong>
      <span>${escapeHtml(String(distance))} dia(s) · ${escapeHtml(String(price))} EUR</span>
      <span class="muted">${escapeHtml(source || '')}</span>
    </div>
  `;
}

export function renderPrices(onPriceEdit, onPriceAction) {
  const reviewRows = buildPriceReviewRows({
    store: state.prices,
    reviewItems: state.reviewItems,
    coinGeckoIds: state.coinGeckoIds,
  });

  const syncMessage = state.priceSync?.message
    ? `<div class="callout"><strong>Última sincronização CoinGecko:</strong> ${escapeHtml(state.priceSync.message)}</div>`
    : '';

  if (!reviewRows.length) {
    el('coinGeckoPriceTable').innerHTML = `${syncMessage}<div class="empty-state"><p>Não existem linhas CoinGecko ou preços pendentes para rever.</p></div>`;
  } else {
    const reviewHtml = `
      ${syncMessage}
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Ativo</th>
              <th>Preço EUR</th>
              <th>Origem</th>
              <th>CoinGecko ID</th>
              <th>Anterior mais próximo</th>
              <th>Seguinte mais próximo</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            ${reviewRows.map((row) => `
              <tr>
                <td>
                  <div class="cell-stack">
                    <strong>${escapeHtml(row.date)}</strong>
                    <span class="muted">${row.unresolved ? 'Pendente' : 'Guardado'}</span>
                  </div>
                </td>
                <td>
                  <div class="cell-stack">
                    <strong>${escapeHtml(row.asset)}</strong>
                    <span class="muted">${escapeHtml(row.reviewTitle || row.sourceKind || '')}</span>
                  </div>
                </td>
                <td>
                  <input type="number" step="0.00000001" min="0" data-price-key="${escapeHtml(row.key)}" value="${escapeHtml(row.currentPrice)}" placeholder="Ex.: 123.45" />
                </td>
                <td>
                  <input type="text" data-source-key="${escapeHtml(row.key)}" value="${escapeHtml(row.source)}" placeholder="manual / CoinGecko / importado" />
                </td>
                <td>
                  <input type="text" data-provider-key="${escapeHtml(row.key)}" value="${escapeHtml(row.coinGeckoId)}" placeholder="bitcoin / ethereum / ..." />
                </td>
                <td>${nearbyPriceCell(row.previousDate, row.previousPrice, row.previousDistanceDays, row.previousSource)}</td>
                <td>${nearbyPriceCell(row.nextDate, row.nextPrice, row.nextDistanceDays, row.nextSource)}</td>
                <td>
                  <div class="review-actions">
                    <button class="btn btn-secondary" data-price-action="refresh-coingecko" data-price-target="${escapeHtml(row.key)}">Atualizar CoinGecko</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <p class="subtle">Pode editar o preço, a origem e o CoinGecko ID manualmente. Alterações são guardadas localmente e entram nas exportações de preços.</p>
    `;
    el('coinGeckoPriceTable').innerHTML = reviewHtml;
  }

  const rows = Object.values(state.prices).sort((a, b) => `${a.date}${a.asset}`.localeCompare(`${b.date}${b.asset}`));
  if (!rows.length) {
    renderEmpty('pricesTable', 'Ainda não existem preços históricos.');
  } else {
    const html = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Ativo</th>
              <th>Preço EUR</th>
              <th>Origem</th>
              <th>Tipo</th>
              <th>CoinGecko ID</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td>${escapeHtml(row.date)}</td>
                <td>${escapeHtml(row.asset)}</td>
                <td><input type="number" step="0.00000001" min="0" data-price-key="${escapeHtml(`${row.date}|${row.asset}`)}" value="${escapeHtml(row.price_eur)}" /></td>
                <td><input type="text" data-source-key="${escapeHtml(`${row.date}|${row.asset}`)}" value="${escapeHtml(row.source)}" /></td>
                <td>${escapeHtml(row.source_kind || row.provider || '—')}</td>
                <td><input type="text" data-provider-key="${escapeHtml(`${row.date}|${row.asset}`)}" value="${escapeHtml(row.provider_id || '')}" /></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    el('pricesTable').innerHTML = html;
  }

  document.querySelectorAll('#pricesTable input, #coinGeckoPriceTable input').forEach((input) => {
    input.addEventListener('change', () => onPriceEdit(input));
  });
  document.querySelectorAll('[data-price-action]').forEach((button) => {
    button.addEventListener('click', () => onPriceAction(button.dataset.priceAction, button.dataset.priceTarget));
  });
}


export function renderTaxTables() {
  const taxableColumns = [
    { label: 'Ativo', key: 'asset' },
    { label: 'Quantidade', key: 'quantity' },
    { label: 'Plataforma', key: 'platformLabel' },
    { label: 'Origem do lote', key: 'lotSourceType' },
    { label: 'Aquisição', key: 'acquisitionDate' },
    { label: 'Venda', key: 'saleDate' },
    { label: 'Ganho estimado', key: 'gainEstimate', render: (row) => formatCurrency(row.gainEstimate) },
    { label: 'Imposto estimado', key: 'estimatedTax', render: (row) => formatCurrency(row.estimatedTax) },
    { label: 'País fonte', key: 'countrySource', render: (row) => `<input type="text" data-country-row="${row.id}" value="${escapeHtml(row.countrySource || '')}" maxlength="2" style="width:72px" />` },
  ];
  const exemptColumns = [
    { label: 'Ativo', key: 'asset' },
    { label: 'Quantidade', key: 'quantity' },
    { label: 'Plataforma', key: 'platformLabel' },
    { label: 'Origem do lote', key: 'lotSourceType' },
    { label: 'Aquisição', key: 'acquisitionDate' },
    { label: 'Venda', key: 'saleDate' },
    { label: 'Dias', key: 'heldDays' },
    { label: 'País fonte', key: 'countrySource' },
  ];

  const detailsBuilder = (row) => `
    <div class="detail-panel">
      <div class="detail-grid">
        <div>
          <p class="detail-title">Linha sugerida</p>
          <p>${escapeHtml(row.irsFormSuggestion || '')}</p>
        </div>
        <div>
          <p class="detail-title">Plataforma associada</p>
          <p>${escapeHtml(row.platformLabel || row.platform || '')}</p>
        </div>
        <div>
          <p class="detail-title">Linha de origem do lote</p>
          <p>${escapeHtml(row.lotLineage || row.lotSourceType || 'Sem detalhe adicional')}</p>
        </div>
      </div>
      <div class="detail-proof">
        <p class="detail-title">Comprovativos recomendados para arquivo / eventual pedido da AT</p>
        <ul class="evidence-list">
          ${(row.recommendedEvidence || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>
    </div>
  `;

  el('taxableTable').innerHTML = tableHtml(taxableColumns, state.taxableDisposals, detailsBuilder);
  el('exemptTable').innerHTML = tableHtml(exemptColumns, state.exemptDisposals, detailsBuilder);

  const taxableNetGain = state.taxableDisposals.reduce((sum, row) => {
    return sum + Number(row.gainEstimate || 0);
  }, 0);

  const estimatedTax = Math.max(
    0,
    taxableNetGain * (Number(state.settings.taxRate || 0) / 100),
  );

  const summaryRows = [
    { metric: 'Linhas potencialmente tributáveis', value: state.taxableDisposals.length },
    { metric: 'Ganho estimado tributável', value: formatCurrency(taxableNetGain) },
    { metric: 'Despesas associadas', value: formatCurrency(state.taxableDisposals.reduce((sum, row) => sum + Number(row.expenses || 0), 0)) },
    { metric: 'Imposto estimado', value: formatCurrency(estimatedTax) },
    { metric: 'Linhas excluídas ≥ 365 dias', value: state.exemptDisposals.length },
  ];
  el('taxSummaryTable').innerHTML = tableHtml([
    { label: 'Métrica', key: 'metric' },
    { label: 'Valor', key: 'value' },
  ], summaryRows);
}

export function bindCountryEditors(onChange) {
  document.querySelectorAll('[data-country-row]').forEach((input) => {
    input.addEventListener('change', () => onChange(input.dataset.countryRow, input.value));
  });
}

export function renderAll(onReviewAction, onPriceEdit, onCountryChange, onPriceAction) {
  renderMetrics();
  renderProcessingSummary();
  renderAuditTrail();
  renderFileQueue();
  renderRecognizedFiles();
  renderHistory();
  renderLots();
  renderReviews(onReviewAction);
  renderPrices(onPriceEdit, onPriceAction);
  renderTaxTables();
  bindCountryEditors(onCountryChange);
}

export function exportHelpers() {
  return {
    exportHistory: () => downloadCsv(`historico_normalizado_${state.settings.taxYear}.csv`, state.transactions),
    exportLots: () => downloadCsv(`lotes_${state.settings.taxYear}.csv`, state.lots),
    exportReviews: () => downloadCsv(`revisao_necessaria_${state.settings.taxYear}.csv`, state.reviewItems),
    exportTaxable: () => downloadCsv(`irs_tributavel_${state.settings.taxYear}.csv`, state.taxableDisposals),
    exportExempt: () => downloadCsv(`irs_excluido_${state.settings.taxYear}.csv`, state.exemptDisposals),
    exportPricesCsv: () => downloadCsv('precos_historicos.csv', Object.values(state.prices)),
    exportPricesJson: () => downloadJson('precos_historicos.json', Object.values(state.prices)),
  };
}
