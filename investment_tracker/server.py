"""Server web locale della dashboard (solo libreria standard).

Sicurezza / privacy:
- ascolta SOLO su 127.0.0.1: non è raggiungibile da altri dispositivi della rete;
- rifiuta richieste con Host diverso da localhost (protezione DNS-rebinding);
- ogni chiamata /api richiede un token casuale generato a ogni avvio e inserito nella
  pagina: un sito esterno aperto nel browser non può leggere né modificare i dati;
- nessuna risorsa esterna (CDN, font, analytics): la pagina è interamente servita da qui.
"""

from __future__ import annotations

import json
import mimetypes
import re
import secrets
import threading
import webbrowser
from datetime import date
from http import HTTPStatus
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


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _num(value, field: str, required: bool = True) -> float | None:
    if value in (None, ""):
        if required:
            raise ApiError(400, f"Campo '{field}' obbligatorio.")
        return None
    try:
        return float(str(value).replace(",", "."))
    except ValueError:
        raise ApiError(400, f"'{value}' non è un numero valido ({field}).") from None


def _contribution_from(body: dict) -> Contribution:
    d = str(body.get("date") or date.today().isoformat())
    amount = _num(body.get("amount"), "importo")
    price = _num(body.get("price"), "prezzo", required=False)
    try:
        validate_contribution(d, amount, price)
    except ValueError as e:
        raise ApiError(400, str(e)) from None
    return Contribution(id=new_id(), date=d, amount=amount, price=price, note=str(body.get("note", ""))[:200])


class Handler(BaseHTTPRequestHandler):
    server_version = "InvestmentTracker"

    def log_message(self, format, *args):  # niente log delle richieste in console
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
        if n > 100_000:
            raise ApiError(413, "Richiesta troppo grande.")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "JSON non valido.") from None

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
                    raise ApiError(403, "Token non valido: ricarica la pagina.")
                self._api(method, path, parse_qs(url.query))
            elif method == "GET":
                self._static(path)
            else:
                raise ApiError(405, "Metodo non consentito.")
        except ApiError as e:
            self._json(e.status, {"error": str(e)})
        except Exception as e:  # pragma: no cover - errori imprevisti
            self._json(500, {"error": f"Errore imprevisto: {e}"})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_DELETE(self):
        self._handle("DELETE")

    def do_PUT(self):
        self._handle("PUT")

    # ------------------------------------------------------------------- static

    def _static(self, path: str) -> None:
        if path in ("/", "/index.html"):
            html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
            html = html.replace("__TRACKER_TOKEN__", TOKEN)
            self._send(200, html.encode(), "text/html; charset=utf-8")
            return
        name = path.lstrip("/")
        target = (WEB_DIR / name).resolve()
        if WEB_DIR.resolve() not in target.parents or not target.is_file():
            self._send(404, b"Not found", "text/plain")
            return
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    # ---------------------------------------------------------------------- api

    def _api(self, method: str, path: str, query: dict) -> None:
        parts = [p for p in path.split("/") if p][1:]  # senza "api"

        if method == "GET" and parts == ["portfolio"]:
            refresh = query.get("refresh", ["0"])[0] == "1"
            self._json(200, compute_portfolio(STORE.load(), force=refresh))
            return

        if method == "GET" and parts == ["search"]:
            q = query.get("q", [""])[0].strip()
            if len(q) < 1:
                self._json(200, {"results": []})
                return
            try:
                results = market.search(q)
            except Exception as e:
                raise ApiError(502, str(e)) from None
            self._json(200, {"results": [r.__dict__ for r in results], "is_isin": is_isin(q)})
            return

        if method == "POST" and parts == ["assets"]:
            body = self._body()
            ticker = str(body.get("ticker", "")).strip().upper()
            if not re.fullmatch(r"[A-Z0-9.\-=^]{1,20}", ticker):
                raise ApiError(400, "Ticker non valido.")
            contrib = _contribution_from(body)
            pf = STORE.load()
            existing = next((a for a in pf.assets if a.ticker == ticker), None)
            if existing:
                existing.contributions.append(contrib)
            else:
                try:
                    meta = market.instrument_meta(ticker)
                    market.close_history(ticker, date.fromisoformat(contrib.date))
                except Exception as e:
                    raise ApiError(400, f"Impossibile verificare '{ticker}' su Yahoo Finance: {e}") from None
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
            return

        if len(parts) >= 2 and parts[0] == "assets":
            pf = STORE.load()
            try:
                asset = pf.find(parts[1])
            except KeyError:
                raise ApiError(404, "Asset non trovato.") from None

            if method == "DELETE" and len(parts) == 2:
                pf.assets.remove(asset)
                STORE.save(pf)
                self._json(200, {"ok": True})
                return

            if method == "PUT" and len(parts) == 2:  # rinomina
                body = self._body()
                if body.get("name"):
                    asset.name = str(body["name"])[:120]
                STORE.save(pf)
                self._json(200, {"ok": True})
                return

            if parts[2:3] == ["contributions"]:
                if method == "POST" and len(parts) == 3:
                    asset.contributions.append(_contribution_from(self._body()))
                    STORE.save(pf)
                    self._json(201, {"ok": True})
                    return
                if method == "DELETE" and len(parts) == 4:
                    before = len(asset.contributions)
                    asset.contributions = [c for c in asset.contributions if c.id != parts[3]]
                    if len(asset.contributions) == before:
                        raise ApiError(404, "Versamento non trovato.")
                    if not asset.contributions:
                        pf.assets.remove(asset)
                    STORE.save(pf)
                    self._json(200, {"ok": True})
                    return

        raise ApiError(404, "Endpoint non trovato.")


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
        raise SystemExit("Nessuna porta libera trovata tra 8765 e 8784.")

    url = f"http://127.0.0.1:{port}/"
    print(f"Investment Tracker in esecuzione su {url}")
    print(f"Dati: {STORE.path}")
    if market.demo_mode():
        print("Modalità DEMO: prezzi sintetici, nessuna connessione a Yahoo.")
    print("Premi Ctrl+C per chiudere.")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nChiuso.")
    finally:
        httpd.server_close()
