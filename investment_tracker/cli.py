"""Command-line interface for a one-off return calculation."""

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
            "Compute the current return of an investment (ETF/stock) from an amount "
            "and a purchase date, using Yahoo Finance data."
        ),
    )
    parser.add_argument(
        "symbol",
        help="Yahoo Finance ticker (e.g. VWCE.DE) or ISIN (e.g. IE00BK5BQT80)",
    )
    parser.add_argument("amount", type=float, help="Invested amount (e.g. 1000)")
    parser.add_argument(
        "date",
        help="Purchase date, YYYY-MM-DD or DD/MM/YYYY (e.g. 2024-01-15)",
    )
    parser.add_argument(
        "--ticker",
        dest="forced_ticker",
        default=None,
        help="Force a specific Yahoo ticker when the ISIN is ambiguous",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        start_date = parse_date(args.date)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    try:
        result = compute_investment_return(
            args.symbol, args.amount, start_date, chosen_symbol=args.forced_ticker
        )
    except TickerResolutionError as e:
        print(f"Error: {e}", file=sys.stderr)
        if e.candidates:
            print("\nCandidates found (use --ticker <SYMBOL> to pick one):", file=sys.stderr)
            for c in e.candidates:
                print(f"  {c}", file=sys.stderr)
        return 1
    except (NoDataError, NetworkError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        return 1

    sign = "+" if result.gain >= 0 else ""
    cur = result.currency or ""
    print(f"Instrument:        {result.input_symbol} -> {result.resolved_ticker}")
    print(f"Requested date:    {result.start_date_requested}")
    print(f"Actual purchase date (first available trading day): {result.start_date_actual}")
    print(f"Purchase price:    {result.start_price:.4f} {cur}")
    print(f"Valuation date:    {result.end_date_actual}")
    print(f"Current price:     {result.end_price:.4f} {cur}")
    print(f"Shares bought:     {result.shares:.6f}")
    print("-" * 50)
    print(f"Amount invested:   {result.amount:,.2f}")
    print(f"Return:            {sign}{result.return_pct:.2f}%")
    print(f"Gain/Loss:         {sign}{result.gain:,.2f}")
    print(f"Current value:     {result.current_value:,.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
