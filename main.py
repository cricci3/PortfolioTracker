"""Investment Tracker.

Uso (con uv):
    uv run investment-tracker                                 -> avvia la dashboard locale
    uv run investment-tracker <TICKER_O_ISIN> <IMPORTO> <DATA> -> calcolo da riga di comando

Uso (senza uv):
    python main.py                    (dashboard)
    python main.py <TICKER_O_ISIN> <IMPORTO> <DATA>

Esempi:
    uv run investment-tracker IE00BK5BQT80 1000 2024-01-15
    uv run investment-tracker VWCE.DE 1000 15/01/2024 --ticker VWCE.DE
"""

from __future__ import annotations

from investment_tracker.app import main

if __name__ == "__main__":
    raise SystemExit(main())
