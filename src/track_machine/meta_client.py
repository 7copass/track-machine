"""Cliente da Graph API do Meta com paginação, retry e rate limiting.

O token nunca aparece em logs nem em mensagens de erro: ele viaja no corpo
do POST/params e é removido de qualquer URL antes de ser exibido.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Iterator

import requests

from .config import Settings

log = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.facebook.com"

# Erros que valem retry: rate limit, throttle e instabilidade transitória.
RETRYABLE_CODES = {1, 2, 4, 17, 341, 613}
MAX_RETRIES = 5
BACKOFF_BASE = 2.0


class MetaAPIError(RuntimeError):
    """Erro devolvido pela Graph API."""

    def __init__(self, message: str, *, code: int | None = None,
                 subcode: int | None = None, payload: dict | None = None):
        super().__init__(message)
        self.code = code
        self.subcode = subcode
        self.payload = payload or {}


def _scrub(text: str) -> str:
    """Remove qualquer access_token de uma string antes de logar/exibir."""
    return re.sub(r"(access_token=)[^&\s\"']+", r"\1[REDACTED]", text)


class MetaClient:
    def __init__(self, settings: Settings, *, timeout: int = 90):
        self.settings = settings
        self.timeout = timeout
        self.session = requests.Session()
        self._calls = 0

    # ── baixo nível ────────────────────────────────────────────────

    def _url(self, path: str) -> str:
        path = path.lstrip("/")
        return f"{GRAPH_BASE}/{self.settings.api_version}/{path}"

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict:
        """GET autenticado, com retry exponencial em erros transitórios."""
        params = dict(params or {})
        params["access_token"] = self.settings.access_token

        last_error: Exception | None = None

        for attempt in range(MAX_RETRIES):
            try:
                self._calls += 1
                resp = self.session.get(
                    self._url(path), params=params, timeout=self.timeout
                )
            except requests.RequestException as exc:
                last_error = exc
                wait = BACKOFF_BASE ** attempt
                log.warning("Falha de rede (%s). Retry em %.0fs", type(exc).__name__, wait)
                time.sleep(wait)
                continue

            if resp.ok:
                self._log_throttle(resp)
                return resp.json()

            # Erro da API — decide entre retry e falha definitiva.
            try:
                err = resp.json().get("error", {})
            except json.JSONDecodeError:
                err = {"message": _scrub(resp.text[:400])}

            code = err.get("code")
            subcode = err.get("error_subcode")
            message = err.get("message", "erro desconhecido")

            if code in RETRYABLE_CODES and attempt < MAX_RETRIES - 1:
                wait = BACKOFF_BASE ** attempt * 5
                log.warning(
                    "Rate limit / erro transitório (code=%s). Aguardando %.0fs",
                    code, wait,
                )
                time.sleep(wait)
                continue

            raise MetaAPIError(
                _scrub(f"{message} (code={code}, subcode={subcode})"),
                code=code, subcode=subcode, payload=err,
            )

        raise MetaAPIError(f"Esgotadas {MAX_RETRIES} tentativas: {last_error}")

    def _log_throttle(self, resp: requests.Response) -> None:
        """Lê o header de uso da API e avisa quando estamos perto do limite."""
        raw = resp.headers.get("x-business-use-case-usage") or resp.headers.get(
            "x-ad-account-usage"
        )
        if not raw:
            return
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return

        for _, entries in (data.items() if isinstance(data, dict) else []):
            for entry in entries if isinstance(entries, list) else []:
                pct = max(
                    entry.get("call_count", 0),
                    entry.get("total_cputime", 0),
                    entry.get("total_time", 0),
                )
                if pct >= 75:
                    log.warning("Uso da API em %s%% do limite — desacelerando", pct)
                    time.sleep(3)

    # ── paginação ──────────────────────────────────────────────────

    def get_all(self, path: str, params: dict[str, Any] | None = None,
                *, max_pages: int = 200) -> list[dict]:
        """Percorre todas as páginas de um endpoint e devolve a lista completa."""
        rows: list[dict] = []
        page = self.get(path, params)

        for _ in range(max_pages):
            rows.extend(page.get("data", []))
            nxt = page.get("paging", {}).get("next")
            if not nxt:
                break
            try:
                resp = self.session.get(nxt, timeout=self.timeout)
                resp.raise_for_status()
                page = resp.json()
                self._calls += 1
            except requests.RequestException as exc:
                log.warning("Paginação interrompida: %s", _scrub(str(exc)))
                break

        return rows

    def iter_all(self, path: str, params: dict[str, Any] | None = None) -> Iterator[dict]:
        yield from self.get_all(path, params)

    # ── diagnóstico ────────────────────────────────────────────────

    @property
    def call_count(self) -> int:
        return self._calls

    def debug_token(self) -> dict:
        """Valida o token: escopos, expiração e app dono."""
        data = self.get("debug_token", {"input_token": self.settings.access_token})
        return data.get("data", {})

    def me(self) -> dict:
        return self.get("me", {"fields": "id,name"})
