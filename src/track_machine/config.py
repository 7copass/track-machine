"""Carrega e valida configuração a partir do .env."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]


class ConfigError(RuntimeError):
    """Configuração ausente ou inválida."""


@dataclass(frozen=True)
class Settings:
    access_token: str
    ad_account_id: str
    api_version: str
    currency: str
    timezone: str

    @property
    def account_path(self) -> str:
        return self.ad_account_id

    def masked_token(self) -> str:
        """Token mascarado, para log seguro."""
        t = self.access_token
        if len(t) <= 12:
            return "*" * len(t)
        return f"{t[:6]}...{t[-4:]} ({len(t)} chars)"


def load_settings(env_file: Path | None = None) -> Settings:
    load_dotenv(env_file or ROOT / ".env")

    token = os.getenv("META_ACCESS_TOKEN", "").strip()
    account = os.getenv("META_AD_ACCOUNT_ID", "").strip()

    if not token:
        raise ConfigError(
            "META_ACCESS_TOKEN não definido. Copie .env.example para .env e preencha."
        )
    if not account:
        raise ConfigError(
            "META_AD_ACCOUNT_ID não definido. Formato esperado: act_1234567890"
        )
    if not account.startswith("act_"):
        account = f"act_{account.lstrip('act_')}"

    return Settings(
        access_token=token,
        ad_account_id=account,
        api_version=os.getenv("META_API_VERSION", "v21.0").strip(),
        currency=os.getenv("REPORT_CURRENCY", "BRL").strip(),
        timezone=os.getenv("TIMEZONE", "America/Sao_Paulo").strip(),
    )
