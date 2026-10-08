# Investment Tracker — note per Claude Code

App Python personale che calcola il rendimento dei miei investimenti con i prezzi di
Yahoo Finance. Gira **solo in locale**: dashboard web servita da Python su `127.0.0.1`.

## Regola n.1: privacy dei dati

- I dati reali del portafoglio (importi, date, quote) vivono **fuori dal repo**, in
  `%APPDATA%\InvestmentTracker\portfolio.json` (o in `INVESTMENT_TRACKER_DATA_DIR`).
- **Non leggere, aprire, stampare, copiare o cercare quel file né la sua cartella**, nemmeno
  per fare debug, e non avviare la dashboard reale per "vedere i dati". Le regole di blocco
  sono in `.claude/settings.json`, ma vale anche come istruzione.
- Per sviluppare e testare usa SEMPRE la modalità demo: `uv run investment-tracker --demo`
  (prezzi sintetici, nessuna rete, dati in `~/.investment-tracker-demo/`), oppure crea un
  `Store` in una cartella temporanea dentro i test.
- Non aggiungere dipendenze che inviano dati all'esterno: niente CDN, Google Fonts, analytics,
  telemetria, servizi cloud. Il frontend deve funzionare offline (a parte i prezzi da Yahoo).
  Verso Yahoo vanno solo ticker e date di inizio storico, mai importi.
- Il server deve restare legato a `127.0.0.1` e mantenere il controllo dell'Host header e del
  token `X-Tracker-Token`.

## Comandi

```bash
uv sync                                   # installa dipendenze
uv run investment-tracker --demo          # dashboard demo (usa questa per sviluppare)
uv run investment-tracker                 # dashboard reale (la lancia l'utente, non Claude)
uv run investment-tracker VWCE.DE 1000 2024-01-15   # calcolo singolo da CLI
```

## Struttura

- `investment_tracker/app.py` — entry point: senza argomenti/`--demo`/`--port` avvia la dashboard, altrimenti CLI.
- `investment_tracker/server.py` — `http.server` (solo stdlib): API JSON + file statici, sicurezza locale.
- `investment_tracker/portfolio.py` — calcoli: quote per versamento, rendimento totale, XIRR, YoY (Modified Dietz).
- `investment_tracker/market.py` — accesso a Yahoo (yfinance), cache 15 min, conversione valute, modalità demo.
- `investment_tracker/storage.py` — modello dati (`Portfolio` → `Asset` → `Contribution`) e salvataggio JSON atomico.
- `investment_tracker/core.py` — risoluzione ISIN→ticker e calcolo singolo usato dalla CLI.
- `investment_tracker/web/` — `index.html`, `app.css`, `app.js` (vanilla JS, grafici SVG fatti a mano, tema chiaro/scuro).
- `investment_tracker/gui.py` — vecchia GUI tkinter, dismessa (si può eliminare).

## Convenzioni

- Codice, commenti, UI e messaggi d'errore in **italiano**.
- Importi nella valuta base (EUR); i prezzi in valuta estera sono convertiti col cambio storico Yahoo (`USDEUR=X`, ecc.).
  Le valute in centesimi (`GBp`, `ZAc`, `ILA`) sono divise per 100.
- Nessuna dipendenza compilata nuova: su questa macchina AppLocker/WDAC blocca alcune DLL (per questo `numpy==2.1.3`).
  Preferisci la libreria standard.
- Frontend: niente framework né build step. Colori solo tramite le variabili CSS in `:root` (chiaro) e nei blocchi dark.
- Dopo modifiche alla UI, verifica in modalità demo sia il tema chiaro sia quello scuro, e la larghezza mobile.
