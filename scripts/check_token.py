#!/usr/bin/env python3
"""Valida o token antes de rodar a análise completa.

Confere escopos, expiração e acesso à conta. Rode isto primeiro — economiza
tempo quando o token está sem permissão ou expirado.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from track_machine.config import ConfigError, load_settings   # noqa: E402
from track_machine.meta_client import MetaAPIError, MetaClient  # noqa: E402

OBRIGATORIOS = {"ads_read"}
RECOMENDADOS = {"business_management", "ads_management"}


def main() -> int:
    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"✗ {exc}")
        return 1

    print(f"Token:  {settings.masked_token()}")
    print(f"Conta:  {settings.ad_account_id}")
    print(f"API:    {settings.api_version}\n")

    client = MetaClient(settings)

    # 1. Token válido?
    try:
        info = client.debug_token()
    except MetaAPIError as exc:
        print(f"✗ Token inválido ou sem permissão: {exc}")
        return 1

    if not info.get("is_valid"):
        print(f"✗ Token inválido. Motivo: {info.get('error', {}).get('message', '—')}")
        return 1
    print("✓ Token válido")

    # 2. Expiração
    exp = info.get("expires_at", 0)
    if exp == 0:
        print("✓ Não expira (System User token)")
    else:
        dt = datetime.fromtimestamp(exp, tz=timezone.utc)
        restante = dt - datetime.now(tz=timezone.utc)
        horas = restante.total_seconds() / 3600
        if horas < 0:
            print(f"✗ Token EXPIRADO em {dt:%d/%m/%Y %H:%M} UTC")
            return 1
        marca = "✓" if horas > 2 else "⚠"
        print(f"{marca} Expira em {horas:.1f}h ({dt:%d/%m/%Y %H:%M} UTC)")

    # 3. Escopos
    escopos = set(info.get("scopes", []))
    faltando = OBRIGATORIOS - escopos
    if faltando:
        print(f"✗ Faltam escopos obrigatórios: {', '.join(sorted(faltando))}")
        return 1
    print(f"✓ Escopos: {', '.join(sorted(escopos)) or '—'}")

    ausentes = RECOMENDADOS - escopos
    if ausentes:
        print(f"⚠ Recomendados ausentes (alguns dados ficam de fora): "
              f"{', '.join(sorted(ausentes))}")

    # 4. Acesso real à conta
    try:
        conta = client.get(settings.ad_account_id, {
            "fields": "id,name,account_status,currency,timezone_name,amount_spent"
        })
    except MetaAPIError as exc:
        print(f"\n✗ Sem acesso à conta {settings.ad_account_id}: {exc}")
        print("  Verifique se o usuário do token tem permissão nessa conta.")
        return 1

    status = {1: "ATIVA", 2: "DESATIVADA", 3: "NÃO CONFIRMADA",
              7: "EM ANÁLISE", 9: "PERÍODO DE GRAÇA", 101: "FECHADA"}
    st = conta.get("account_status")

    print(f"\n✓ Acesso confirmado")
    print(f"  Nome:   {conta.get('name')}")
    print(f"  Status: {status.get(st, st)}")
    print(f"  Moeda:  {conta.get('currency')}")
    print(f"  Fuso:   {conta.get('timezone_name')}")
    print(f"  Gasto acumulado: {float(conta.get('amount_spent', 0)) / 100:,.2f}")

    print(f"\n✓ Tudo pronto. Rode: python scripts/run_analysis.py --dias 30")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
