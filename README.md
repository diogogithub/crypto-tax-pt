# Crypto IRS PT

A local-first browser application for organising crypto-asset transaction
records, reconstructing FIFO lots, identifying ambiguous events, and exporting
working figures for the Portuguese IRS process.

This is an evidence-organising tool, not tax advice or an official Autoridade
Tributária application. Portuguese tax rules and reporting instructions can
change; validate the result against current official guidance and a qualified
professional before filing.

## Privacy model

Imported exchange files and calculated records stay in the browser. Working
state is saved automatically in that browser's `localStorage` until the user
selects reset or clears site data; downloaded session/workpack files are
created only on request. CoinGecko requests disclose an asset identifier and date to that service. An optional
CoinGecko API key is held only in page memory and is deliberately removed from
browser persistence and exported workpacks.

## Run locally

```sh
python3 -m http.server 8000
```

Open <http://127.0.0.1:8000>. The application currently loads Papa Parse and
JSZip from jsDelivr, so CSV/ZIP imports need network access unless those
dependencies are vendored for an offline deployment.

## Supported workflow

- Kraken ledger/trade/balance CSV or ZIP imports;
- Robinhood activity CSV or ZIP imports;
- FIFO lot reconstruction and transfer-continuity review;
- price imports and optional CoinGecko lookups;
- explicit review queues for incomplete evidence;
- CSV/JSON work exports.

The application makes assumptions visible instead of silently converting an
ambiguous event into a tax conclusion. Keep source statements and review every
flagged item.

## Tests

```sh
npm test
```

These dependency-free Node tests cover number/date helpers, price lookup, and
the rule that API keys are excluded from persisted/exported state.

## Licence

MIT. See `LICENSE`. Third-party browser libraries retain their own licences.
