#!/usr/bin/env python3
"""Pipeline completo: extrai, normaliza, analisa e gera o relatório."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pandas as pd  # noqa: E402

from track_machine.analyze import Analyzer  # noqa: E402
from track_machine.config import ConfigError, load_settings  # noqa: E402
from track_machine.fetch import AccountFetcher  # noqa: E402
from track_machine.meta_client import MetaAPIError, MetaClient  # noqa: E402
from track_machine.metrics import normalize  # noqa: E402
from track_machine.report import build_report, save_report  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("track-machine")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Análise de tráfego pago Meta Ads")
    p.add_argument("--dias", type=int, default=30,
                   help="Janela de análise em dias (padrão: 30)")
    p.add_argument("--since", help="Data inicial YYYY-MM-DD (sobrepõe --dias)")
    p.add_argument("--until", help="Data final YYYY-MM-DD")
    p.add_argument("--sem-breakdowns", action="store_true",
                   help="Pula os breakdowns (mais rápido, menos profundo)")
    p.add_argument("--salvar-bruto", action="store_true",
                   help="Salva as respostas cruas da API em data/raw/")
    p.add_argument("--saida", help="Caminho do relatório .md")
    return p.parse_args()


def janela(args) -> tuple[str, str]:
    if args.since:
        return args.since, args.until or date.today().isoformat()
    fim = date.today() - timedelta(days=1)   # ontem: hoje vem incompleto
    return (fim - timedelta(days=args.dias - 1)).isoformat(), fim.isoformat()


def salvar_bruto(nome: str, dados) -> None:
    d = ROOT / "data" / "raw"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{nome}.json").write_text(
        json.dumps(dados, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def main() -> int:
    args = parse_args()

    try:
        settings = load_settings()
    except ConfigError as exc:
        log.error(str(exc))
        return 1

    since, until = janela(args)
    log.info("Período: %s → %s", since, until)

    client = MetaClient(settings)
    fetcher = AccountFetcher(client)

    # ── extração ───────────────────────────────────────────────────
    try:
        log.info("Lendo dados da conta...")
        conta = fetcher.account_info()
        log.info("Conta: %s (%s)", conta.get("name"), conta.get("currency"))

        campanhas_raw = fetcher.campaigns()
        adsets_raw = fetcher.adsets()
        ads_raw = fetcher.ads()
        log.info("Estrutura: %d campanhas, %d conjuntos, %d anúncios",
                 len(campanhas_raw), len(adsets_raw), len(ads_raw))

        log.info("Puxando insights por anúncio...")
        ins_ads = fetcher.insights("ad", since=since, until=until)

        log.info("Puxando insights por campanha...")
        ins_camp = fetcher.insights("campaign", since=since, until=until)

        log.info("Puxando insights por conjunto...")
        ins_adset = fetcher.insights("adset", since=since, until=until)

        log.info("Puxando série diária...")
        ins_diario = fetcher.insights("campaign", since=since, until=until,
                                      time_increment=1)

        breakdowns_raw = {}
        if not args.sem_breakdowns:
            log.info("Puxando breakdowns...")
            breakdowns_raw = fetcher.insights_with_breakdowns(
                "account", since=since, until=until
            )

    except MetaAPIError as exc:
        log.error("Falha na API: %s", exc)
        if exc.code == 190:
            log.error("Token expirado ou revogado. Gere um novo e atualize o .env")
        return 1

    log.info("Chamadas à API: %d", client.call_count)

    if args.salvar_bruto:
        for nome, dados in [
            ("conta", conta), ("campanhas", campanhas_raw),
            ("adsets", adsets_raw), ("ads", ads_raw),
            ("insights_ads", ins_ads), ("insights_diario", ins_diario),
            ("breakdowns", breakdowns_raw),
        ]:
            salvar_bruto(nome, dados)
        log.info("Dados brutos salvos em data/raw/ (fora do git)")

    # ── normalização ───────────────────────────────────────────────
    df_ads = normalize(ins_ads)
    df_camp = normalize(ins_camp)
    df_adset = normalize(ins_adset)
    df_diario = normalize(ins_diario)
    df_bd = {k: normalize(v) for k, v in breakdowns_raw.items()}

    if df_ads.empty:
        log.warning("Nenhuma entrega no período. Verifique as datas e o status da conta.")
        return 1

    log.info("Gasto no período: %.2f %s | %.0f conversões",
             df_ads["spend"].sum(), conta.get("currency", ""),
             df_ads["conversoes"].sum())

    # ── análise ────────────────────────────────────────────────────
    log.info("Rodando diagnóstico...")
    findings = Analyzer().run(
        ads=df_ads, campanhas=df_camp, diario=df_diario,
        breakdowns=df_bd, adsets_raw=adsets_raw,
    )

    for f in findings:
        log.info("  %s", f)

    # ── relatório ──────────────────────────────────────────────────
    md = build_report(
        conta=conta, periodo=(since, until),
        ads=df_ads, campanhas=df_camp, adsets=df_adset,
        breakdowns=df_bd, findings=findings,
        currency=conta.get("currency", "BRL"),
    )

    saida = Path(args.saida) if args.saida else (
        ROOT / "reports" / f"analise_{since}_a_{until}.md"
    )
    save_report(md, saida)

    # CSVs para inspeção manual
    proc = ROOT / "data" / "processed"
    proc.mkdir(parents=True, exist_ok=True)
    df_ads.to_csv(proc / "ads.csv", index=False)
    df_camp.to_csv(proc / "campanhas.csv", index=False)

    log.info("─" * 55)
    log.info("Relatório: %s", saida)
    log.info("Achados: %d (%d críticos)", len(findings),
             sum(1 for f in findings if f.severidade == "critico"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
