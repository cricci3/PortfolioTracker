# Investment Tracker — notes for Claude Code

A personal Python app that tracks the returns of my investments using Yahoo Finance
prices. It runs **locally only**: a web dashboard served by Python on `127.0.0.1`.

## Rule #1: data privacy

- The real portfolio data (amounts, dates, shares) lives **outside the repo**, in
  `%APPDATA%\InvestmentTracker\portfolio.json` (or `INVESTMENT_TRACKER_DATA_DIR`).
- **Never read, open, print, copy or search that file or its folder**, not even for
  debugging, and don't start the real dashboard "to look at the data". The block rules are
  in `.claude/settings.json`, but treat this as an instruction too.
- To develop and test ALWAYS use demo mode: `uv run investment-tracker --demo`
  (synthetic prices, no network, data in `~/.investment-tracker-demo/`), or create a
  `Store` in a temporary folder inside tests.
- Don't add dependencies that send data elsewhere: no CDNs, Google Fonts, analytics,
  telemetry or cloud services. The frontend must work offline (apart from Yahoo prices).
  Yahoo only receives tickers and history start dates, never amounts.
- The server must stay bound to `127.0.0.1` and keep the Host-header check and the
  `X-Tracker-Token` token.

## Commands

```bash
uv sync                                   # install dependencies
uv run investment-tracker --demo          # demo dashboard (use this for development)
uv run investment-tracker                 # real dashboard (the user runs this, not Claude)
uv run investment-tracker VWCE.DE 1000 2024-01-15   # one-off calculation from the CLI
```

## Layout

- `investment_tracker/app.py` — entry point: no args / `--demo` / `--port` start the dashboard, otherwise the CLI.
- `investment_tracker/server.py` — `http.server` (stdlib only): JSON API + static files, local security.
  API: `GET /api/portfolio`, `GET /api/search`, `POST /api/assets`, `PUT|DELETE /api/assets/<id>`
  (PUT accepts `name`, `ticker`, and the full `contributions` list), `POST /api/assets/<id>/contributions`,
  `PUT|DELETE /api/assets/<id>/contributions/<cid>`.
- `investment_tracker/portfolio.py` — calculations: shares per contribution, total return, XIRR, YoY (Modified Dietz).
- `investment_tracker/market.py` — Yahoo access (yfinance), 15-minute cache, currency conversion, demo mode.
- `investment_tracker/storage.py` — data model (`Portfolio` → `Asset` → `Contribution`) and atomic JSON saves.
- `investment_tracker/core.py` — ISIN→ticker resolution and the one-off calculation used by the CLI.
- `investment_tracker/web/` — `index.html`, `app.css`, `app.js` (vanilla JS, hand-made SVG charts, light/dark theme).

## Conventions

- Code, comments, UI and error messages in **English**. Number/date formatting uses the `en-GB` locale.
- Amounts are in the base currency (EUR); prices in foreign currencies are converted with Yahoo's historical
  FX rate (`USDEUR=X`, etc.). Minor-unit currencies (`GBp`, `ZAc`, `ILA`) are divided by 100.
- No new compiled dependencies: AppLocker/WDAC blocks some DLLs on this machine (hence `numpy==2.1.3`).
  Prefer the standard library.
- Frontend: no frameworks and no build step. Colors only via the CSS variables in `:root` (light) and the dark blocks.
- After UI changes, check demo mode in both light and dark themes, and at mobile width.
