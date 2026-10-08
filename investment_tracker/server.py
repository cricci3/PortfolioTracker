"""Local web server for the dashboard (standard library only).

Security / privacy:
- listens ONLY on 127.0.0.1, so it can't be reached from other devices on the network;
- rejects requests whose Host header isn't localhost (DNS-rebinding protection);
- every /api call requires a random token generated at each start and injected into the
  page: an external website open in the browser can neither read nor change the data;
- no external resources (CDNs, fonts, analytics): the page is served entirely from here.
"""

from __future__ import annotations

import json
import mimetypes
import re
import secrets
import threading
import webbrowser
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import market
from .core import is_isin
from .portfolio import compute_portfolio
from .storage import Asset, Contribution, Store, new_id, validate_contribution

WEB_DIR = Path(__file__).parent / "web"
TOKEN = secrets.token_urlsafe(24)
STORE = Store()
TICKER_RE = re.compile(r"[A-Z0-9.\-=^]{1,20}")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


NUM_RE = re.compile(r"-?\d*\.?\d+")


def parse_number(text: str, grouping: bool = False) -> float:
    """Parse "1000.50", "1000,50", "1,000.50", "1.000,50" or "1.000.000".

    Same rules as parseNum() in app.js. With both separators the last one is the decimal
    mark. With only one kind, repeated means thousands; a single one followed by exactly
    three digits ("1.000") means thousands when `grouping` is True (amounts). The old
    code turned "1.000" into 1.0 and rejected "1.000,50".
    """
    s = re.sub(r"[\s€$£']", "", text)
    if "," in s and "." in s:
        dec = "," if s.rfind(",") > s.rfind(".") else "."
        s = s.replace("." if dec == "," else ",", "").replace(",", ".")
    elif "," in s or "." in s:
        parts = s.split("," if "," in s else ".")
        thousands = len(parts) > 2 or (
            grouping and re.fullmatch(r"-?\d{1,3}", parts[0]) and re.fullmatch(r"\d{3}", parts[1])
        )
        s = "".join(parts) if thousands else ".".join(parts)
    if not NUM_RE.fullmatch(s):
        raise ValueError(text)
    return float(s)


def _num(value, field: str, required: bool = True) -> float | None:
    if value in (None, ""):
        if required:
            raise ApiError(400, f"'{field}' is required.")
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)  # already a number (the dashboard parses input client-side)
    try:
        return parse_number(str(value), grouping=(field == "amount"))
    except ValueError:
        raise ApiError(400, f"'{value}' is not a valid number ({field}).") from None


def _contribution_from(body: dict, keep_id: str | None = None) -> Contribution:
    d = str(body.get("date") or date.today().isoformat())
    amount = _num(body.get("amount"), "amount")
    price = _num(body.get("price"), "price", required=False)
    try:
        validate_contribution(d, amount, price)
    except ValueError as e:
        raise ApiError(400, str(e)) from None
    return Contribution(
        id=keep_id or new_id(), date=d, amount=amount, price=price, note=str(body.get("note") or "")[:200]
    )


def _check_ticker(ticker: str, since: date) -> market.InstrumentMeta:
    """Make sure Yahoo knows the ticker and has prices since `since`."""
    try:
        meta = market.instrument_meta(ticker)
        market.close_history(ticker, since)
    except Exception as e:
        raise ApiError(400, f"Could not verify '{ticker}' on Yahoo Finance: {e}") from None
    return meta


class Handler(BaseHTTPRequestHandler):
    server_version = "InvestmentTracker"

    def log_message(self, format, *args):  # don't log requests to the console
        pass

    # ------------------------------------------------------------------ helpers

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "connect-src 'self'; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data) -> None:
        self._send(status, json.dumps(data, default=str).encode(), "application/json; charset=utf-8")

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 200_000:
            raise ApiError(413, "Request too large.")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "Invalid JSON.") from None
        if not isinstance(data, dict):
            raise ApiError(400, "Invalid JSON.")
        return data

    # ----------------------------------------------------------------- dispatch

    def _handle(self, method: str) -> None:
        if not self._host_ok():
            self._send(403, b"Forbidden", "text/plain")
            return
        url = urlparse(self.path)
        path = url.path
        try:
            if path.startswith("/api/"):
                if not secrets.compare_digest(self.headers.get("X-Tracker-Token", ""), TOKEN):
                    raise ApiError(403, "Invalid token: reload the page.")
                self._api(method, path, parse_qs(url.query))
            elif method == "GET":
                self._static(path)
            else:
                raise ApiError(405, "Method not allowed.")
        except ApiError as e:
            self._json(e.status, {"error": str(e)})
        except Exception as e:  # pragma: no cover - unexpected errors
            self._json(500, {"error": f"Unexpected error: {e}"})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._handle("PUT")

    def do_DELETE(self):
        self._handle("DELETE")

    # ------------------------------------------------------------------- static

    def _static(self, path: str) -> None:
        if path in ("/", "/index.html"):
            html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
            html = html.replace("__TRACKER_TOKEN__", TOKEN)
            self._send(200, html.encode(), "text/html; charset=utf-8")
            return
        target = (WEB_DIR / path.lstrip("/")).resolve()
        if WEB_DIR.resolve() not in target.parents or not target.is_file():
            self._send(404, b"Not found", "text/plain")
            return
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    # ---------------------------------------------------------------------- api

    def _api(self, method: str, path: str, query: dict) -> None:
        parts = [p for p in path.split("/") if p][1:]  # drop the leading "api"

        if method == "GET" and parts == ["portfolio"]:
            refresh = query.get("refresh", ["0"])[0] == "1"
            self._json(200, compute_portfolio(STORE.load(), force=refresh))
            return

        if method == "GET" and parts == ["search"]:
            q = query.get("q", [""])[0].strip()
            if not q:
                self._json(200, {"results": []})
                return
            try:
                results = market.search(q)
            except Exception as e:
                raise ApiError(502, str(e)) from None
            self._json(200, {"results": [r.__dict__ for r in results], "is_isin": is_isin(q)})
            return

        if method == "POST" and parts == ["assets"]:
            self._create_asset(self._body())
            return

        if len(parts) >= 2 and parts[0] == "assets":
            pf = STORE.load()
            try:
                asset = pf.find(parts[1])
            except KeyError:
                raise ApiError(404, "Asset not found.") from None

            if len(parts) == 2:
                if method == "PUT":
                    self._update_asset(pf, asset, self._body())
                    STORE.save(pf)
                    self._json(200, {"ok": True})
                    return
                if method == "DELETE":
                    pf.assets.remove(asset)
                    STORE.save(pf)
                    self._json(200, {"ok": True})
                    return

            if parts[2:3] == ["contributions"]:
                if method == "POST" and len(parts) == 3:
                    asset.contributions.append(_contribution_from(self._body()))
                    STORE.save(pf)
                    self._json(201, {"ok": True})
                    return
                if len(parts) == 4:
                    idx = next((i for i, c in enumerate(asset.contributions) if c.id == parts[3]), None)
                    if idx is None:
                        raise ApiError(404, "Contribution not found.")
                    if method == "PUT":
                        asset.contributions[idx] = _contribution_from(self._body(), keep_id=parts[3])
                        STORE.save(pf)
                        self._json(200, {"ok": True})
                        return
                    if method == "DELETE":
                        del asset.contributions[idx]
                        if not asset.contributions:
                            pf.assets.remove(asset)
                        STORE.save(pf)
                        self._json(200, {"ok": True})
                        return

        raise ApiError(404, "Endpoint not found.")

    def _create_asset(self, body: dict) -> None:
        ticker = str(body.get("ticker", "")).strip().upper()
        if not TICKER_RE.fullmatch(ticker):
            raise ApiError(400, "Invalid ticker.")
        contrib = _contribution_from(body)
        pf = STORE.load()
        existing = next((a for a in pf.assets if a.ticker == ticker), None)
        if existing:
            existing.contributions.append(contrib)
        else:
            meta = _check_ticker(ticker, date.fromisoformat(contrib.date))
            pf.assets.append(
                Asset(
                    id=new_id(),
                    ticker=ticker,
                    name=str(body.get("name") or meta.name)[:120],
                    exchange=str(body.get("exchange") or meta.exchange)[:40],
                    currency=meta.currency,
                    input_symbol=str(body.get("input_symbol") or ticker)[:20],
                    contributions=[contrib],
                )
            )
        STORE.save(pf)
        self._json(201, {"ok": True, "merged": bool(existing)})

    def _update_asset(self, pf, asset: Asset, body: dict) -> None:
        """Edit name, ticker and/or the whole contribution list in one atomic update."""
        contribs = asset.contributions
        if "contributions" in body:
            rows = body["contributions"]
            if not isinstance(rows, list) or not rows:
                raise ApiError(400, "An asset needs at least one contribution.")
            known = {c.id for c in asset.contributions}
            contribs = [
                _contribution_from(r, keep_id=r.get("id") if r.get("id") in known else None)
                for r in rows
                if isinstance(r, dict)
            ]

        if "ticker" in body:
            ticker = str(body.get("ticker") or "").strip().upper()
            if not TICKER_RE.fullmatch(ticker):
                raise ApiError(400, "Invalid ticker.")
            if ticker != asset.ticker:
                if any(a.ticker == ticker and a.id != asset.id for a in pf.assets):
                    raise ApiError(409, f"{ticker} is already in the portfolio.")
                first = min(date.fromisoformat(c.date) for c in contribs)
                meta = _check_ticker(ticker, first)
                asset.ticker = ticker
                asset.currency = meta.currency
                asset.exchange = meta.exchange
                if not body.get("name"):
                    asset.name = meta.name

        if body.get("name"):
            asset.name = str(body["name"]).strip()[:120]
        asset.contributions = contribs


def serve(port: int = 8765, open_browser: bool = True) -> None:
    httpd = None
    for p in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        raise SystemExit(f"No free port found between {port} and {port + 19}.")

    url = f"http://127.0.0.1:{port}/"
    print(f"Investment Tracker running at {url}")
    print(f"Data: {STORE.path}")
    if market.demo_mode():
        print("DEMO mode: synthetic prices, no connection to Yahoo.")
    print("Press Ctrl+C to stop.")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
