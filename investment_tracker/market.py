"""Market data access (Yahoo Finance) with an in-memory cache.

All of the app's outbound traffic goes through this module: Yahoo only ever receives
tickers (e.g. VWCE.DE) and history start dates. Amounts, shares and portfolio value
never leave the computer.

With INVESTMENT_TRACKER_DEMO=1 nothing is fetched from the Internet: prices are
synthetic (useful to try the UI or develop without real data).
"""

from __future__ import annotations

import hashlib
import math
import os
import threading
import time
from dataclasses import dataclass
from datetime import date, timedelta

import pandas as pd

from .core import NetworkError, NoDataError, TickerCandidate, search_ticker_by_isin

CACHE_TTL_SECONDS = 15 * 60

# Currencies Yahoo quotes in minor units ("pence"): (real currency, divisor)
MINOR_UNITS = {"GBp": ("GBP", 100.0), "GBX": ("GBP", 100.0), "ZAc": ("ZAR", 100.0), "ILA": ("ILS", 100.0)}


def demo_mode() -> bool:
    return os.environ.get("INVESTMENT_TRACKER_DEMO", "").strip() not in ("", "0", "false")


@dataclass
class InstrumentMeta:
    ticker: str
    name: str
    exchange: str
    currency: str


_cache: dict[tuple, tuple[float, object]] = {}
_cache_lock = threading.Lock()


def _cached(key: tuple, loader, force: bool = False):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and not force and now - hit[0] < CACHE_TTL_SECONDS:
            return hit[1]
    value = loader()
    with _cache_lock:
        _cache[key] = (now, value)
    return value


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


# --------------------------------------------------------------------------- demo


def _demo_series(ticker: str, start: date) -> pd.Series:
    seed = int(hashlib.md5(ticker.encode()).hexdigest()[:8], 16)
    rng_state = seed
    days = pd.bdate_range(start, date.today())
    drift = ((seed % 13) - 3) / 100 / 252  # -3% to +9% a year
    vol = 0.006 + (seed % 7) / 1000
    price = 20 + seed % 180
    out = []
    for i, _ in enumerate(days):
        rng_state = (1103515245 * rng_state + 12345) % (2**31)
        shock = (rng_state / 2**31 - 0.5) * 2 * vol * math.sqrt(3)
        cycle = 0.0015 * math.sin(i / (40 + seed % 30))
        price *= 1 + drift + shock + cycle
        out.append(price)
    return pd.Series(out, index=days, name="Close")


DEMO_META = {
    "VWCE.DE": ("Vanguard FTSE All-World UCITS ETF Acc", "GER", "EUR"),
    "SWDA.MI": ("iShares Core MSCI World UCITS ETF", "MIL", "EUR"),
    "AAPL": ("Apple Inc.", "NMS", "USD"),
    "EIMI.MI": ("iShares Core MSCI EM IMI UCITS ETF", "MIL", "EUR"),
    "ENEL.MI": ("Enel S.p.A.", "MIL", "EUR"),
}


# ------------------------------------------------------------------------- Yahoo


def search(query: str) -> list[TickerCandidate]:
    query = query.strip()
    if not query:
        return []
    if demo_mode():
        q = query.upper()
        return [
            TickerCandidate(symbol=t, name=m[0], exchange=m[1])
            for t, m in DEMO_META.items()
            if q in t or q in m[0].upper()
        ] or [TickerCandidate(symbol=q, name=f"Demo {q}", exchange="DEMO")]
    return _cached(("search", query.upper()), lambda: search_ticker_by_isin(query))


def instrument_meta(ticker: str) -> InstrumentMeta:
    ticker = ticker.strip().upper()
    if demo_mode():
        name, exch, cur = DEMO_META.get(ticker, (f"Demo {ticker}", "DEMO", "EUR"))
        return InstrumentMeta(ticker, name, exch, cur)

    def load() -> InstrumentMeta:
        import yfinance as yf

        tk = yf.Ticker(ticker)
        currency = exchange = name = ""
        try:
            fi = tk.fast_info
            currency = getattr(fi, "currency", "") or ""
            exchange = getattr(fi, "exchange", "") or ""
        except Exception:
            pass
        try:
            info = tk.info or {}
            name = info.get("longName") or info.get("shortName") or ""
            currency = currency or info.get("currency", "")
            exchange = exchange or info.get("exchange", "")
        except Exception:
            pass
        return InstrumentMeta(ticker, name or ticker, exchange, currency)

    return _cached(("meta", ticker), load)


def close_history(ticker: str, start: date, force: bool = False) -> pd.Series:
    """Daily closing prices (naive date index) from `start` to today."""
    ticker = ticker.strip().upper()
    if demo_mode():
        return _cached(("hist", ticker, start), lambda: _demo_series(ticker, start), force)

    def load() -> pd.Series:
        import yfinance as yf

        try:
            hist = yf.Ticker(ticker).history(
                start=start, end=date.today() + timedelta(days=1), auto_adjust=False
            )
        except Exception as e:
            raise NetworkError(
                f"Could not download prices for {ticker} from Yahoo Finance. "
                f"Check your connection. Details: {e}"
            ) from e
        if hist is None or hist.empty or "Close" not in hist:
            raise NoDataError(f"No prices found for '{ticker}' since {start}.")
        close = hist["Close"].dropna().sort_index()
        idx = pd.to_datetime(close.index)
        if getattr(idx, "tz", None) is not None:
            idx = idx.tz_localize(None)
        close.index = idx.normalize()
        close = close[~close.index.duplicated(keep="last")]
        if close.empty:
            raise NoDataError(f"Empty price data for '{ticker}'.")
        return close

    return _cached(("hist", ticker, start), load, force)


def price_in_base(ticker: str, currency: str, base: str, start: date, force: bool = False) -> pd.Series:
    """Price series converted to the portfolio base currency (daily historical FX rate)."""
    close = close_history(ticker, start, force)
    cur = currency or base
    if cur in MINOR_UNITS:
        cur, div = MINOR_UNITS[cur]
        close = close / div
    if cur.upper() == base.upper():
        return close
    fx = fx_history(cur, base, start, force)
    fx = fx.reindex(close.index.union(fx.index)).sort_index().ffill().bfill().reindex(close.index)
    return close * fx


def fx_history(cur: str, base: str, start: date, force: bool = False) -> pd.Series:
    pair = f"{cur.upper()}{base.upper()}=X"
    if demo_mode():
        s = _demo_series(pair, start)
        return 0.92 * s / s.iloc[0]
    return close_history(pair, start, force)


def minor_unit_divisor(currency: str) -> float:
    return MINOR_UNITS.get(currency, ("", 1.0))[1]
