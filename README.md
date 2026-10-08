# Investment Tracker

A **local** dashboard to track the returns of your investments (ETFs, stocks, etc.)
using Yahoo Finance prices. For each asset you record a start date and an amount, then
add later contributions (e.g. a monthly savings plan). The dashboard computes current
value, gain in € and %, annualized return and the result over the last 12 months.

## Running it

```bash
uv sync
uv run investment-tracker            # opens the dashboard in your browser (http://127.0.0.1:8765)
```

Options: `--port 9000`, `--no-browser`, `--demo` (fake prices, no connection: handy to
try the interface). To stop it press `Ctrl+C` in the terminal.

Without uv: `pip install -r requirements.txt`, then `python main.py`.

## How to use it

1. **Add asset** → search by Yahoo ticker (`VWCE.DE`), ISIN (`IE00BK5BQT80`) or name.
   If the ISIN is listed on several exchanges, pick the one you bought on
   (`.MI` Borsa Italiana, `.DE` Xetra, `.AS` Amsterdam…).
2. Enter the **start date** and the **amount invested** in euros. Optional: the **actual
   unit price** you paid (from your broker). Without it, the closing price of the first
   trading day on or after that date is used.
3. On each card, **Add capital** records a new contribution (e.g. this month's instalment).
4. **Edit** lets you rename the asset, change its ticker, and change the date, amount,
   price or note of any contribution. You can also add or remove contributions there, or
   delete the whole asset.
5. **Details** shows the asset's chart and every contribution with its own return. The
   pencil icon on a row opens the editor on that contribution.
6. Top right: refresh prices and switch between light and dark theme.

Amounts can be typed either way: `1000.50`, `1,000.50` or `1.000,50` all work.

## Metrics

| Metric | Meaning |
| --- | --- |
| Invested capital | Sum of all contributions |
| Current value | Total shares × latest closing price (converted to EUR) |
| Gain / % | Value − invested, and the same divided by invested |
| Annual return | XIRR (money-weighted): accounts for *when* you put money in. Shown after 6 months |
| Last 12 months (YoY) | Result over the last 12 months net of contributions made in that period (Modified Dietz). Needs at least one year of history |

Instruments in a foreign currency (e.g. `AAPL` in USD): the amount is in euros and shares
are computed using the exchange rate on the contribution date, so the value also reflects
currency moves. Fees, taxes and paid-out dividends are not taken into account.

## Privacy

- The server only listens on `127.0.0.1`: other devices can't reach it.
- The page loads nothing from the Internet (no CDNs, fonts or analytics).
- The only outbound traffic goes to Yahoo Finance and contains tickers and dates, never amounts.
- Your data lives **outside the project folder**:
  `%APPDATA%\InvestmentTracker\portfolio.json` (Windows). To move it, set
  `INVESTMENT_TRACKER_DATA_DIR`. To back it up, just copy that file.
- `.claude/settings.json` forbids Claude Code from reading that file and folder, and
  `CLAUDE.md` tells it to develop in `--demo` mode only.

## CLI (one-off calculation)

```bash
uv run investment-tracker IE00BK5BQT80 1000 2024-01-15 --ticker VWCE.DE
```

> Note: `numpy` is pinned to `2.1.3` because AppLocker/WDAC blocks newer versions on
> this machine.
