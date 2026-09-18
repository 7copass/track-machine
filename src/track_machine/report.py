"""Geração do relatório em Markdown."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pandas as pd

from .analyze import Finding

EMOJI = {"critico": "🔴", "alto": "🟠", "medio": "🟡", "baixo": "🔵", "info": "⚪"}


def _fmt_money(v: float, cur: str = "R$") -> str:
    return f"{cur} {v:,.2f}"


def _kpis(df: pd.DataFrame, cur: str) -> str:
    if df.empty:
        return "_Sem dados no período._"

    spend = float(df["spend"].sum())
    imp = float(df["impressions"].sum())
    clicks = float(df["inline_link_clicks"].sum())
    conv = float(df["conversoes"].sum())
    receita = float(df["receita"].sum())
    reach = float(df["reach"].sum())

    cpm = spend * 1000 / imp if imp else 0
    ctr = clicks * 100 / imp if imp else 0
    cpc = spend / clicks if clicks else 0
    cpa = spend / conv if conv else 0
    roas = receita / spend if spend else 0
    freq = imp / reach if reach else 0
    txc = conv * 100 / clicks if clicks else 0

    linhas = [
        "| Métrica | Valor |",
        "|---|---:|",
        f"| Investimento | {_fmt_money(spend, cur)} |",
        f"| Impressões | {imp:,.0f} |",
        f"| Alcance | {reach:,.0f} |",
        f"| Frequência | {freq:.2f} |",
        f"| CPM | {_fmt_money(cpm, cur)} |",
        f"| Cliques no link | {clicks:,.0f} |",
        f"| CTR (link) | {ctr:.2f}% |",
        f"| CPC (link) | {_fmt_money(cpc, cur)} |",
        f"| Conversões | {conv:,.0f} |",
        f"| Taxa de conversão | {txc:.2f}% |",
        f"| CPA | {_fmt_money(cpa, cur) if conv else '—'} |",
        f"| Receita | {_fmt_money(receita, cur)} |",
        f"| ROAS | {roas:.2f}x |",
    ]
    return "\n".join(linhas)


def _tabela(df: pd.DataFrame, cols: dict[str, str], n: int = 10) -> str:
    if df.empty:
        return "_Sem dados._"

    existentes = {k: v for k, v in cols.items() if k in df.columns}
    if not existentes:
        return "_Sem dados._"

    d = df.head(n)[list(existentes)].copy()

    for c in d.columns:
        if d[c].dtype.kind in "fc":
            d[c] = d[c].map(lambda x: f"{x:,.2f}")

    d.columns = list(existentes.values())
    return d.to_markdown(index=False)


def _achados(findings: list[Finding]) -> str:
    if not findings:
        return "_Nenhum problema relevante detectado pelas regras atuais._"

    blocos = []
    for i, f in enumerate(findings, 1):
        b = [f"### {i}. {EMOJI[f.severidade]} {f.titulo}", ""]
        b.append(f"**Severidade:** {f.severidade.upper()}")
        if f.impacto_estimado > 0:
            b.append(f" · **Gasto envolvido:** {_fmt_money(f.impacto_estimado)}")
        b.append("")
        b.append(f"**O que os dados mostram:** {f.evidencia}")
        b.append("")
        b.append(f"**O que fazer:** {f.acao}")
        if f.entidades:
            b.append("")
            b.append("**Onde:** " + ", ".join(f"`{e}`" for e in f.entidades))
        blocos.append("\n".join(b))

    return "\n\n---\n\n".join(blocos)


def build_report(
    *,
    conta: dict,
    periodo: tuple[str, str],
    ads: pd.DataFrame,
    campanhas: pd.DataFrame,
    adsets: pd.DataFrame,
    breakdowns: dict[str, pd.DataFrame],
    findings: list[Finding],
    currency: str = "R$",
) -> str:
    since, until = periodo
    nome = conta.get("name", conta.get("id", "conta"))
    agora = datetime.now().strftime("%d/%m/%Y %H:%M")

    criticos = sum(1 for f in findings if f.severidade == "critico")
    altos = sum(1 for f in findings if f.severidade == "alto")
    em_jogo = sum(f.impacto_estimado for f in findings
                  if f.severidade in ("critico", "alto"))

    p = [
        f"# Análise de Tráfego — {nome}",
        "",
        f"**Período:** {since} a {until}  ",
        f"**Gerado em:** {agora}  ",
        f"**Conta:** `{conta.get('id', '—')}` · Moeda: {conta.get('currency', currency)}",
        "",
        "---",
        "",
        "## Resumo executivo",
        "",
        f"- **{criticos}** achado(s) crítico(s) e **{altos}** de alta severidade",
        f"- **{_fmt_money(em_jogo, currency)}** de investimento envolvido nos achados prioritários",
        f"- **{len(campanhas)}** campanhas · **{len(adsets)}** conjuntos · **{len(ads)}** anúncios com entrega",
        "",
        "## Números do período",
        "",
        _kpis(ads, currency),
        "",
        "---",
        "",
        "## Achados e pontos de melhoria",
        "",
        "_Ordenados por severidade e por volume de investimento envolvido._",
        "",
        _achados(findings),
        "",
        "---",
        "",
        "## Campanhas",
        "",
        _tabela(campanhas, {
            "campaign_name": "Campanha", "spend": "Gasto", "impressions": "Impr.",
            "ctr_link": "CTR link %", "cpm_calc": "CPM", "conversoes": "Conv.",
            "cpa": "CPA", "roas": "ROAS",
        }),
        "",
        "## Top anúncios por investimento",
        "",
        _tabela(ads.nlargest(15, "spend") if not ads.empty else ads, {
            "ad_name": "Anúncio", "spend": "Gasto", "freq_calc": "Freq.",
            "ctr_link": "CTR link %", "cpc_link": "CPC", "conversoes": "Conv.",
            "cpa": "CPA", "roas": "ROAS",
        }, n=15),
        "",
    ]

    rotulos = {
        "demografico": ("Demografia", "age", "gender"),
        "posicionamento": ("Posicionamento", "publisher_platform", "platform_position"),
        "dispositivo": ("Dispositivo", "impression_device", None),
        "regiao": ("Região", "region", None),
        "hora": ("Horário", "hourly_stats_aggregated_by_advertiser_time_zone", None),
    }

    for chave, (titulo, d1, d2) in rotulos.items():
        bdf = breakdowns.get(chave)
        if bdf is None or bdf.empty:
            continue
        cols = {d1: titulo}
        if d2 and d2 in bdf.columns:
            cols[d2] = d2
        cols.update({
            "spend": "Gasto", "ctr_link": "CTR link %", "cpm_calc": "CPM",
            "conversoes": "Conv.", "cpa": "CPA", "roas": "ROAS",
        })
        p += [f"## Desempenho por {titulo.lower()}", "",
              _tabela(bdf.nlargest(12, "spend"), cols, n=12), ""]

    p += [
        "---",
        "",
        "## Como ler este relatório",
        "",
        "- Os limiares das regras são **heurísticos** (ver `THRESHOLDS` em `analyze.py`) "
        "e devem ser calibrados por vertical e ticket médio.",
        "- Segmentos com pouco volume têm CPA instável por ruído estatístico — "
        "verifique o volume antes de cortar qualquer um.",
        "- Conversões seguem a **janela de atribuição configurada na conta**. "
        "Comparar com o backend costuma revelar divergência; isso é esperado.",
        "",
    ]

    return "\n".join(p)


def save_report(content: str, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path
