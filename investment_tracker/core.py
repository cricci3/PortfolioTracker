"""Logica di calcolo del rendimento di un investimento, basata su dati Yahoo Finance."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta

import pandas as pd
import requests
import yfinance as yf

ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")


class TickerResolutionError(Exception):
    """Sollevata quando un ISIN non produce un ticker univoco senza scelta dell'utente."""

    def __init__(self, message: str, candidates: list["TickerCandidate"] | None = None):
        super().__init__(message)
        self.candidates = candidates or []


class NoDataError(Exception):
    """Sollevata quando Yahoo Finance non restituisce dati di prezzo utilizzabili."""


class NetworkError(Exception):
    """Sollevata quando non è possibile contattare Yahoo Finance (connessione/DNS)."""


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
    history: pd.DataFrame  # colonna 'Close', indicizzata per data


def is_isin(value: str) -> bool:
    return bool(ISIN_RE.match(value.strip().upper()))


def search_ticker_by_isin(isin: str) -> list[TickerCandidate]:
    """Interroga l'endpoint di ricerca di Yahoo Finance per risolvere un ISIN in ticker."""
    url = "https://query2.finance.yahoo.com/v1/finance/search"
    params = {"q": isin, "quotesCount": 10, "newsCount": 0}
    headers = {"User-Agent": "Mozilla/5.0 (compatible; investment-tracker/1.0)"}
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException as e:
        raise NetworkError(
            "Impossibile contattare Yahoo Finance per risolvere l'ISIN. "
            "Controlla la connessione Internet (Wi-Fi/VPN/firewall) e riprova. "
            f"Dettaglio: {e}"
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
    """Risolve l'input dell'utente (ticker o ISIN) in un ticker Yahoo Finance valido.

    Se è un ISIN con più candidati e non è stato specificato `chosen_symbol`,
    solleva TickerResolutionError con la lista dei candidati da far scegliere all'utente.
    """
    value = symbol_or_isin.strip().upper()
    if not is_isin(value):
        return value

    if chosen_symbol:
        return chosen_symbol.strip().upper()

    candidates = search_ticker_by_isin(value)
    if not candidates:
        raise TickerResolutionError(
            f"Nessun ticker Yahoo Finance trovato per l'ISIN {value}. "
            "Prova a inserire direttamente il ticker Yahoo (es. VWCE.DE)."
        )
    if len(candidates) == 1:
        return candidates[0].symbol
    raise TickerResolutionError(
        f"L'ISIN {value} corrisponde a più strumenti quotati su borse diverse. "
        "Scegline uno.",
        candidates=candidates,
    )


def compute_investment_return(
    symbol_or_isin: str,
    amount: float,
    start_date: date,
    chosen_symbol: str | None = None,
) -> InvestmentResult:
    if amount <= 0:
        raise ValueError("L'importo investito deve essere maggiore di zero.")
    if start_date > date.today():
        raise ValueError("La data di inizio investimento non può essere nel futuro.")

    ticker = resolve_ticker(symbol_or_isin, chosen_symbol=chosen_symbol)

    tk = yf.Ticker(ticker)
    # end esclusivo in yfinance: aggiungo un giorno per includere oggi
    end = date.today() + timedelta(days=1)
    try:
        hist = tk.history(start=start_date, end=end, auto_adjust=False)
    except Exception as e:
        raise NetworkError(
            "Impossibile recuperare i dati storici da Yahoo Finance. "
            "Controlla la connessione Internet (Wi-Fi/VPN/firewall) e riprova. "
            f"Dettaglio: {e}"
        ) from e

    if hist.empty:
        raise NoDataError(
            f"Nessun dato storico trovato per il ticker '{ticker}' a partire dal {start_date}. "
            "Controlla il ticker/ISIN e la data (potrebbe precedere la quotazione dello strumento)."
        )

    hist = hist.sort_index()
    close = hist["Close"].dropna()
    if close.empty:
        raise NoDataError(f"Dati di prezzo vuoti per '{ticker}'.")

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
    """Accetta date nei formati YYYY-MM-DD o DD/MM/YYYY."""
    value = value.strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Formato data non riconosciuto: '{value}'. Usa YYYY-MM-DD o DD/MM/YYYY.")
