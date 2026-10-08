"""Local persistence of the portfolio (a JSON file kept outside the project folder).

The file lives in a per-user data folder, NOT in the repository:
  - Windows: %APPDATA%\\InvestmentTracker\\portfolio.json
  - macOS:   ~/Library/Application Support/InvestmentTracker/portfolio.json
  - Linux:   ~/.local/share/investment-tracker/portfolio.json

Override the location with the INVESTMENT_TRACKER_DATA_DIR environment variable.
Keeping it outside the project prevents it from ending up in git or being read by
tools that work on the code folder (Claude Code included).
"""

from __future__ import annotations

import json
import os
import sys
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import date
from pathlib import Path

DATA_FILENAME = "portfolio.json"
SCHEMA_VERSION = 1


def data_dir() -> Path:
    override = os.environ.get("INVESTMENT_TRACKER_DATA_DIR")
    if override:
        return Path(override).expanduser()
    if sys.platform.startswith("win"):
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "InvestmentTracker"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "InvestmentTracker"
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "investment-tracker"


@dataclass
class Contribution:
    """A single deposit into an asset (initial purchase or a recurring plan instalment)."""

    id: str
    date: str  # ISO YYYY-MM-DD
    amount: float  # in the portfolio base currency (e.g. EUR)
    price: float | None = None  # actual unit price paid, in the instrument currency (optional)
    note: str = ""


@dataclass
class Asset:
    id: str
    ticker: str  # resolved Yahoo Finance ticker (e.g. VWCE.DE)
    name: str = ""
    exchange: str = ""
    currency: str = ""  # instrument quote currency (from Yahoo)
    input_symbol: str = ""  # what the user typed (ticker or ISIN)
    contributions: list[Contribution] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict) -> "Asset":
        contribs = [Contribution(**c) for c in d.get("contributions", [])]
        return cls(
            id=d["id"],
            ticker=d["ticker"],
            name=d.get("name", ""),
            exchange=d.get("exchange", ""),
            currency=d.get("currency", ""),
            input_symbol=d.get("input_symbol", ""),
            contributions=contribs,
        )


@dataclass
class Portfolio:
    base_currency: str = "EUR"
    assets: list[Asset] = field(default_factory=list)

    def find(self, asset_id: str) -> Asset:
        for a in self.assets:
            if a.id == asset_id:
                return a
        raise KeyError(asset_id)


def new_id() -> str:
    return uuid.uuid4().hex[:12]


class Store:
    """Thread-safe, atomic read/write of the portfolio file."""

    def __init__(self, path: Path | None = None):
        self.path = path or (data_dir() / DATA_FILENAME)
        self._lock = threading.RLock()

    def load(self) -> Portfolio:
        with self._lock:
            if not self.path.exists():
                return Portfolio()
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return Portfolio(
                base_currency=raw.get("base_currency", "EUR"),
                assets=[Asset.from_dict(a) for a in raw.get("assets", [])],
            )

    def save(self, portfolio: Portfolio) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"schema": SCHEMA_VERSION, **asdict(portfolio)}
            tmp = self.path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self.path)  # atomic write: never leaves a half-written file


def validate_contribution(date_str: str, amount: float, price: float | None) -> None:
    try:
        d = date.fromisoformat(date_str)
    except ValueError:
        raise ValueError(f"Invalid date: '{date_str}'.") from None
    if d > date.today():
        raise ValueError("The date cannot be in the future.")
    if amount <= 0:
        raise ValueError("The amount must be greater than zero.")
    if price is not None and price <= 0:
        raise ValueError("The unit price must be greater than zero.")
