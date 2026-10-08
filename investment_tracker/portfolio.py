"""Per-asset and whole-portfolio metrics.

Conventions:
- Contribution amounts are in the portfolio base currency (EUR by default).
- Shares bought by each contribution = amount / price (in base currency) on the first
  trading day >= the contribution date, or the actual price entered by the user.
- Total return = (current value - invested capital) / invested capital.
- Annualized return = XIRR (money-weighted): accounts for when the money went in.
- YoY = result over the last 12 months using Modified Dietz, so contributions made
  during the year (e.g. a monthly savings plan) are not mistaken for gains.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import pandas as pd

from . import market
from .storage import Asset, Portfolio

MAX_POINTS = 360
MIN_DAYS_FOR_ANNUALIZED = 180


def _downsample(s: pd.Series, max_points: int = MAX_POINTS) -> pd.Series:
    if len(s) <= max_points:
        return s
    step = len(s) / max_points
    idx = sorted({int(i * step) for i in range(max_points)} | {len(s) - 1})
    return s.iloc[idx]


def xirr(cashflows: list[tuple[date, float]]) -> float | None:
    """Annual internal rate of return for irregular cash flows (robust bisection)."""
    if len(cashflows) < 2:
        return None
    t0 = min(d for d, _ in cashflows)
    flows = [((d - t0).days / 365.25, v) for d, v in cashflows]

    def npv(r: float) -> float:
        return sum(v / (1 + r) ** t for t, v in flows)

    lo, hi = -0.9999, 10.0
    f_lo, f_hi = npv(lo), npv(hi)
    if f_lo * f_hi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = npv(mid)
        if abs(f_mid) < 1e-7:
            break
        if f_lo * f_mid < 0:
            hi, f_hi = mid, f_mid
        else:
            lo, f_lo = mid, f_mid
    return (lo + hi) / 2


def _value_on(series: pd.Series, d: pd.Timestamp) -> float | None:
    s = series[series.index <= d]
    return float(s.iloc[-1]) if not s.empty else None


def compute_asset(asset: Asset, base: str, force: bool = False) -> dict:
    out: dict = {
        "id": asset.id,
        "ticker": asset.ticker,
        "name": asset.name,
        "exchange": asset.exchange,
        "currency": asset.currency,
        "input_symbol": asset.input_symbol,
        "contributions": [],
        "error": None,
    }
    contribs = sorted(asset.contributions, key=lambda c: c.date)
    if not contribs:
        out["error"] = "No contributions recorded."
        return out

    today = date.today()
    first = date.fromisoformat(contribs[0].date)
    fetch_start = min(first, today - timedelta(days=380)) - timedelta(days=10)

    try:
        price = market.price_in_base(asset.ticker, asset.currency, base, fetch_start, force)
        raw = market.close_history(asset.ticker, fetch_start, force)
    except Exception as e:  # network/data errors stay confined to this asset
        out["error"] = str(e)
        return out

    # daily conversion factor instrument currency -> base (for manually entered prices)
    conv = (price / raw.reindex(price.index)).ffill()

    shares_by_day = pd.Series(0.0, index=price.index)
    invested_by_day = pd.Series(0.0, index=price.index)
    total_shares = total_invested = 0.0
    flows: list[tuple[date, float]] = []

    for c in contribs:
        d = pd.Timestamp(c.date)
        after = price[price.index >= d]
        if after.empty:  # contribution dated today before the market closes: use last price
            exec_day, px = price.index[-1], float(price.iloc[-1])
        else:
            exec_day, px = after.index[0], float(after.iloc[0])
        if c.price:
            px = float(c.price) * float(conv.loc[exec_day])
        sh = c.amount / px
        total_shares += sh
        total_invested += c.amount
        shares_by_day.loc[shares_by_day.index >= exec_day] += sh
        invested_by_day.loc[invested_by_day.index >= exec_day] += c.amount
        flows.append((date.fromisoformat(c.date), -c.amount))
        out["contributions"].append(
            {
                "id": c.id,
                "date": c.date,
                "amount": c.amount,
                "price_input": c.price,
                "exec_date": exec_day.date().isoformat(),
                "exec_price": px,
                "shares": sh,
                "value_now": sh * float(price.iloc[-1]),
                "note": c.note,
            }
        )

    value_series = shares_by_day * price
    last_day = price.index[-1]
    last_price = float(price.iloc[-1])
    value = total_shares * last_price
    gain = value - total_invested

    flows.append((last_day.date(), value))
    held_days = (last_day.date() - first).days
    irr = xirr(flows) if held_days >= MIN_DAYS_FOR_ANNUALIZED else None

    # --- YoY (last 12 months, Modified Dietz) ---------------------------------
    yoy = None
    one_year_ago = last_day - pd.Timedelta(days=365)
    if pd.Timestamp(first) <= one_year_ago:
        v0 = _value_on(value_series, one_year_ago) or 0.0
        recent = [c for c in contribs if pd.Timestamp(c.date) > one_year_ago]
        net_in = sum(c.amount for c in recent)
        weighted = sum(
            c.amount * (last_day - pd.Timestamp(c.date)).days / 365 for c in recent
        )
        yoy_gain = value - v0 - net_in
        denom = v0 + weighted
        yoy = {
            "gain": yoy_gain,
            "pct": (yoy_gain / denom * 100) if denom > 0 else None,
            "start_value": v0,
            "contributed": net_in,
        }

    # 12-month price change of the instrument itself (independent of contributions)
    p1y = _value_on(price, one_year_ago)
    instrument_12m = (last_price / p1y - 1) * 100 if p1y else None
    prev = float(price.iloc[-2]) if len(price) > 1 else last_price
    day_change = (last_price / prev - 1) * 100 if prev else 0.0

    in_range = value_series[value_series.index >= pd.Timestamp(first)]
    ds_val = _downsample(in_range)
    ds_inv = invested_by_day.reindex(ds_val.index)

    out["_full_value"] = in_range
    out["_full_invested"] = invested_by_day[invested_by_day.index >= pd.Timestamp(first)]
    out.update(
        {
            "invested": total_invested,
            "value": value,
            "gain": gain,
            "return_pct": (gain / total_invested * 100) if total_invested else 0.0,
            "annualized_pct": irr * 100 if irr is not None else None,
            "yoy": yoy,
            "instrument_12m_pct": instrument_12m,
            "day_change_pct": day_change,
            "shares": total_shares,
            "last_price_base": last_price,
            "last_price": float(raw.iloc[-1]),
            "last_date": last_day.date().isoformat(),
            "first_date": first.isoformat(),
            "held_days": held_days,
            "series": {
                "dates": [d.date().isoformat() for d in ds_val.index],
                "value": [round(float(v), 2) for v in ds_val.values],
                "invested": [round(float(v), 2) for v in ds_inv.values],
            },
        }
    )
    return out


def compute_portfolio(pf: Portfolio, force: bool = False) -> dict:
    if force:
        market.clear_cache()
    with ThreadPoolExecutor(max_workers=6) as ex:
        assets = list(ex.map(lambda a: compute_asset(a, pf.base_currency, force), pf.assets))

    ok = [a for a in assets if not a.get("error")]
    invested = sum(a["invested"] for a in ok)
    value = sum(a["value"] for a in ok)
    gain = value - invested

    # aggregate series: sum of values per date (ffill over days missing between exchanges)
    total = None
    if ok:
        vals = [a["_full_value"] for a in ok]
        invs = [a["_full_invested"] for a in ok]
        all_idx = sorted(set().union(*[s.index for s in vals]))
        v = sum(s.reindex(all_idx).ffill().fillna(0) for s in vals)
        i = sum(s.reindex(all_idx).ffill().fillna(0) for s in invs)
        v = _downsample(v)
        i = i.reindex(v.index)
        total = {
            "dates": [d.date().isoformat() for d in v.index],
            "value": [round(float(x), 2) for x in v.values],
            "invested": [round(float(x), 2) for x in i.values],
        }

    # portfolio-wide XIRR
    flows = [
        (date.fromisoformat(c["date"]), -c["amount"]) for a in ok for c in a["contributions"]
    ]
    irr = None
    if flows:
        last = max(date.fromisoformat(a["last_date"]) for a in ok)
        if (last - min(d for d, _ in flows)).days >= MIN_DAYS_FOR_ANNUALIZED:
            irr = xirr(flows + [(last, value)])

    yoy_assets = [a for a in ok if a.get("yoy")]
    yoy_gain = sum(a["yoy"]["gain"] for a in yoy_assets) if yoy_assets else None
    yoy_base = sum(
        a["yoy"]["start_value"] + a["yoy"]["contributed"] / 2 for a in yoy_assets
    )

    for a in assets:
        a.pop("_full_value", None)
        a.pop("_full_invested", None)

    return {
        "base_currency": pf.base_currency,
        "demo": market.demo_mode(),
        "summary": {
            "invested": invested,
            "value": value,
            "gain": gain,
            "return_pct": (gain / invested * 100) if invested else 0.0,
            "annualized_pct": irr * 100 if irr is not None else None,
            "yoy_gain": yoy_gain,
            "yoy_pct": (yoy_gain / yoy_base * 100) if yoy_gain is not None and yoy_base > 0 else None,
            "asset_count": len(assets),
            "error_count": len(assets) - len(ok),
        },
        "series": total,
        "assets": assets,
    }
