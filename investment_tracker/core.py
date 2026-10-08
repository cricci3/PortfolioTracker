"""Single-investment return calculation and ISIN -> ticker resolution (Yahoo Finance)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta

import pandas as pd
import requests
import yfinance as yf

ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")


class TickerResolutionError(Exception):
    """Raised when an ISIN doesn't map to a single ticker without the user choosing one."""

    def __init__(self, message: str, candidates: list["TickerCandidate"] | None = None):
        super().__init__(message)
        self.candidates = candidates or []


class NoDataError(Exception):
    """Raised when Yahoo Finance returns no usable price data."""


class NetworkError(Exception):
    """Raised when Yahoo Finance can't be reached (connection/DNS)."""


@dataclass
class TickerCandidate:
    symbol: str
    name: str
    exchange: str

    def __str__(self) -> str:
        return f"{self.symbol} — {self.name} ({self.exchange})"


@dataclass
class InvestmentResult:
    input_symbol: str
    resolved_ticker: str
    currency: str
    amount: float
    start_date_requested: date
    start_date_actual: date
    start_price: float
    end_date_actual: date
    end_price: float
    shares: float
    current_value: float
    gain: float
    return_pct: float
    history: pd.DataFrame  # 'Close' column, indexed by date


def is_isin(value: str) -> bool:
    return bool(ISIN_RE.match(value.strip().upper()))


def search_ticker_by_isin(isin: str) -> list[TickerCandidate]:
    """Query Yahoo Finance's search endpoint (works for ISINs, tickers and names)."""
    url = "https://query2.finance.yahoo.com/v1/finance/search"
    params = {"q": isin, "quotesCount": 10, "newsCount": 0}
    headers = {"User-Agent": "Mozilla/5.0 (compatible; investment-tracker/1.0)"}
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException as e:
        raise NetworkError(
            "Could not reach Yahoo Finance to look up the symbol. "
            "Check your Internet connection (Wi-Fi/VPN/firewall) and try again. "
            f"Details: {e}"
        ) from e
    quotes = data.get("quotes", [])
    candidates = [
        TickerCandidate(
            symbol=q.get("symbol", ""),
            name=q.get("shortname") or q.get("longname") or "",
            exchange=q.get("exchange", ""),
        )
        for q in quotes
        if q.get("symbol")
    ]
    return candidates


def resolve_ticker(symbol_or_isin: str, chosen_symbol: str | None = None) -> str:
    """Resolve user input (ticker or ISIN) into a valid Yahoo Finance ticker.

    If it's an ISIN with several candidates and `chosen_symbol` isn't given, raises
    TickerResolutionError with the candidate list so the user can pick one.
    """
    value = symbol_or_isin.strip().upper()
    if not is_isin(value):
        return value

    if chosen_symbol:
        return chosen_symbol.strip().upper()

    candidates = search_ticker_by_isin(value)
    if not candidates:
        raise TickerResolutionError(
            f"No Yahoo Finance ticker found for ISIN {value}. "
            "Try entering the Yahoo ticker directly (e.g. VWCE.DE)."
        )
    if len(candidates) == 1:
        return candidates[0].symbol
    raise TickerResolutionError(
        f"ISIN {value} matches several instruments listed on different exchanges. "
        "Pick one.",
        candidates=candidates,
    )


def compute_investment_return(
    symbol_or_isin: str,
    amount: float,
    start_date: date,
    chosen_symbol: str | None = None,
) -> InvestmentResult:
    if amount <= 0:
        raise ValueError("The invested amount must be greater than zero.")
    if start_date > date.today():
        raise ValueError("The start date cannot be in the future.")

    ticker = resolve_ticker(symbol_or_isin, chosen_symbol=chosen_symbol)

    tk = yf.Ticker(ticker)
    # yfinance's `end` is exclusive: add a day to include today
    end = date.today() + timedelta(days=1)
    try:
        hist = tk.history(start=start_date, end=end, auto_adjust=False)
    except Exception as e:
        raise NetworkError(
            "Could not fetch price history from Yahoo Finance. "
            "Check your Internet connection (Wi-Fi/VPN/firewall) and try again. "
            f"Details: {e}"
        ) from e

    if hist.empty:
        raise NoDataError(
            f"No price history found for ticker '{ticker}' since {start_date}. "
            "Check the ticker/ISIN and the date (it may predate the instrument's listing)."
        )

    hist = hist.sort_index()
    close = hist["Close"].dropna()
    if close.empty:
        raise NoDataError(f"Empty price data for '{ticker}'.")

    start_price = float(close.iloc[0])
    start_actual = close.index[0].date()
    end_price = float(close.iloc[-1])
    end_actual = close.index[-1].date()

    shares = amount / start_price
    current_value = shares * end_price
    gain = current_value - amount
    return_pct = (current_value / amount - 1.0) * 100.0

    currency = ""
    try:
        info = tk.fast_info
        currency = getattr(info, "currency", "") or ""
    except Exception:
        currency = ""

    return InvestmentResult(
        input_symbol=symbol_or_isin,
        resolved_ticker=ticker,
        currency=currency,
        amount=amount,
        start_date_requested=start_date,
        start_date_actual=start_actual,
        start_price=start_price,
        end_date_actual=end_actual,
        end_price=end_price,
        shares=shares,
        current_value=current_value,
        gain=gain,
        return_pct=return_pct,
        history=close.to_frame(name="Close"),
    )


def parse_date(value: str) -> date:
    """Accept dates as YYYY-MM-DD or DD/MM/YYYY."""
    value = value.strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unrecognised date format: '{value}'. Use YYYY-MM-DD or DD/MM/YYYY.")
