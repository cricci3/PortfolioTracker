"""Investment Tracker.

Usage (with uv):
    uv run investment-tracker                                   -> start the local dashboard
    uv run investment-tracker --demo                            -> dashboard with fake prices
    uv run investment-tracker <TICKER_OR_ISIN> <AMOUNT> <DATE>  -> one-off CLI calculation

Usage (without uv):
    python main.py                    (dashboard)
    python main.py <TICKER_OR_ISIN> <AMOUNT> <DATE>

Examples:
    uv run investment-tracker IE00BK5BQT80 1000 2024-01-15
    uv run investment-tracker VWCE.DE 1000 15/01/2024
"""

from __future__ import annotations

from investment_tracker.app import main

if __name__ == "__main__":
    raise SystemExit(main())
