# Investment Tracker

Dashboard **locale** per seguire il rendimento dei tuoi investimenti (ETF, azioni, ecc.)
con i prezzi di Yahoo Finance. Per ogni asset registri data di inizio e capitale, poi
aggiungi i versamenti successivi (PAC): la dashboard calcola valore attuale, guadagno in
€ e %, rendimento annualizzato e risultato degli ultimi 12 mesi.

## Avvio

```bash
uv sync
uv run investment-tracker            # apre la dashboard nel browser (http://127.0.0.1:8765)
```

Opzioni: `--port 9000`, `--no-browser`, `--demo` (prezzi finti, nessuna connessione:
utile per provare l'interfaccia). Per chiudere: `Ctrl+C` nel terminale.

Senza uv: `pip install -r requirements.txt` e poi `python main.py`.

## Come si usa

1. **Aggiungi asset** → cerca per ticker Yahoo (`VWCE.DE`), ISIN (`IE00BK5BQT80`) o nome.
   Se l'ISIN è quotato su più borse, scegli quella su cui hai comprato
   (`.MI` Borsa Italiana, `.DE` Xetra, `.AS` Amsterdam…).
2. Indica **data di inizio** e **capitale investito** in euro. Facoltativo: il **prezzo
   unitario reale** dell'eseguito (dal tuo broker). Senza prezzo si usa la chiusura del
   primo giorno di borsa dalla data indicata.
3. Su ogni card, **Aggiungi capitale** registra un nuovo versamento (es. la rata del PAC).
4. **Dettagli** mostra il grafico dell'asset e la lista dei versamenti, eliminabili uno a uno.
5. In alto a destra: aggiornamento prezzi e tema chiaro/scuro.

## Le metriche

| Metrica | Significato |
| --- | --- |
| Capitale versato | Somma dei versamenti |
| Valore attuale | Quote totali × ultimo prezzo di chiusura (convertito in EUR) |
| Guadagno / % | Valore − versato, e lo stesso diviso per il versato |
| Rendimento annuo | XIRR (money-weighted): tiene conto di *quando* hai versato. Mostrato dopo 6 mesi |
| Ultimi 12 mesi (YoY) | Risultato degli ultimi 12 mesi al netto dei versamenti fatti nel periodo (Modified Dietz). Serve almeno un anno di storico |

Strumenti in valuta estera (es. `AAPL` in USD): il capitale è in euro e le quote sono
calcolate col cambio storico del giorno del versamento, quindi il valore include anche
l'effetto cambio. Commissioni, tasse e dividendi distribuiti non sono considerati.

## Privacy

- Il server ascolta solo su `127.0.0.1`: non è raggiungibile da altri dispositivi.
- La pagina non carica nulla da Internet (niente CDN, font o analytics).
- L'unico traffico in uscita va a Yahoo Finance e contiene solo ticker e date, mai importi.
- I dati stanno **fuori dalla cartella del progetto**:
  `%APPDATA%\InvestmentTracker\portfolio.json` (Windows). Per spostarli imposta
  `INVESTMENT_TRACKER_DATA_DIR`. Per un backup basta copiare quel file.
- `.claude/settings.json` vieta a Claude Code di leggere quel file e quella cartella, e
  `CLAUDE.md` gli dice di sviluppare solo in modalità `--demo`.

## CLI (calcolo singolo)

```bash
uv run investment-tracker IE00BK5BQT80 1000 2024-01-15 --ticker VWCE.DE
```

> Nota: `numpy` è pinnato a `2.1.3` perché su questo sistema AppLocker/WDAC blocca le
> versioni più recenti.
