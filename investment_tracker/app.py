"""Entry point unico.

    investment-tracker                      -> avvia la dashboard locale nel browser
    investment-tracker --demo               -> dashboard con prezzi sintetici (offline)
    investment-tracker --port 9000 --no-browser
    investment-tracker <TICKER_O_ISIN> <IMPORTO> <DATA>   -> calcolo singolo da CLI
"""

from __future__ import annotations

import argparse
import os
import sys

DASHBOARD_FLAGS = {"--port", "--no-browser", "--demo", "-h", "--help"}


def _dashboard(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="investment-tracker", description="Dashboard locale degli investimenti.")
    parser.add_argument("--port", type=int, default=8765, help="porta locale (default 8765)")
    parser.add_argument("--no-browser", action="store_true", help="non aprire il browser automaticamente")
    parser.add_argument("--demo", action="store_true", help="prezzi sintetici, nessuna connessione a Yahoo")
    args = parser.parse_args(argv)
    if args.demo:
        os.environ["INVESTMENT_TRACKER_DEMO"] = "1"
        # in demo i dati vanno in un file separato, per non sporcare il portafoglio reale
        os.environ.setdefault(
            "INVESTMENT_TRACKER_DATA_DIR",
            os.path.join(os.path.expanduser("~"), ".investment-tracker-demo"),
        )

    from .server import serve

    serve(port=args.port, open_browser=not args.no_browser)
    return 0


def main() -> int:
    argv = sys.argv[1:]
    if not argv or argv[0] in DASHBOARD_FLAGS:
        return _dashboard(argv)

    from .cli import main as cli_main

    return cli_main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
