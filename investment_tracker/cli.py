"""Interfaccia a riga di comando per il calcolo del rendimento di un investimento."""

from __future__ import annotations

import argparse
import sys

from .core import (
    NetworkError,
    NoDataError,
    TickerResolutionError,
    compute_investment_return,
    parse_date,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="investment-tracker",
        description=(
            "Calcola il rendimento attuale di un investimento (ETF/azione) "
            "a partire da un importo e una data di acquisto, usando i dati di Yahoo Finance."
        ),
    )
    parser.add_argument(
        "symbol",
        help="Ticker Yahoo Finance (es. VWCE.DE) oppure ISIN (es. IE00BK5BQT80)",
    )
    parser.add_argument("amount", type=float, help="Importo investito (es. 1000)")
    parser.add_argument(
        "date",
        help="Data di acquisto, formato YYYY-MM-DD o DD/MM/YYYY (es. 2024-01-15)",
    )
    parser.add_argument(
        "--ticker",
        dest="forced_ticker",
        default=None,
        help="Forza un ticker Yahoo specifico se l'ISIN è ambiguo",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        start_date = parse_date(args.date)
    except ValueError as e:
        print(f"Errore: {e}", file=sys.stderr)
        return 1

    try:
        result = compute_investment_return(
            args.symbol, args.amount, start_date, chosen_symbol=args.forced_ticker
        )
    except TickerResolutionError as e:
        print(f"Errore: {e}", file=sys.stderr)
        if e.candidates:
            print("\nCandidati trovati (usa --ticker <SIMBOLO> per sceglierne uno):", file=sys.stderr)
            for c in e.candidates:
                print(f"  {c}", file=sys.stderr)
        return 1
    except NoDataError as e:
        print(f"Errore: {e}", file=sys.stderr)
        return 1
    except NetworkError as e:
        print(f"Errore: {e}", file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"Errore: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Errore imprevisto: {e}", file=sys.stderr)
        return 1

    sign = "+" if result.gain >= 0 else ""
    cur = result.currency or ""
    print(f"Strumento:         {result.input_symbol} -> {result.resolved_ticker}")
    print(f"Data richiesta:    {result.start_date_requested}")
    print(f"Data di acquisto effettiva (primo giorno di borsa disponibile): {result.start_date_actual}")
    print(f"Prezzo di acquisto:  {result.start_price:.4f} {cur}")
    print(f"Data valorizzazione: {result.end_date_actual}")
    print(f"Prezzo attuale:      {result.end_price:.4f} {cur}")
    print(f"Quote acquistate:    {result.shares:.6f}")
    print("-" * 50)
    print(f"Importo investito:   {result.amount:,.2f}")
    print(f"Rendimento:          {sign}{result.return_pct:.2f}%")
    print(f"Guadagno/Perdita:    {sign}{result.gain:,.2f}")
    print(f"Valore attuale:      {result.current_value:,.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
