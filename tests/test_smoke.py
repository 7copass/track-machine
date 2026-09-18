"""Smoke test do pipeline com dados sintéticos — roda sem token."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from track_machine.analyze import Analyzer  # noqa: E402
from track_machine.metrics import normalize, summarize  # noqa: E402
from track_machine.report import build_report  # noqa: E402


def fake_ads() -> list[dict]:
    """Cenário com problemas plantados de propósito."""
    return [
        {   # saudável
            "ad_id": "1", "ad_name": "Criativo A - Depoimento",
            "campaign_name": "Conversao BR", "adset_name": "Lookalike 1%",
            "spend": "1500.00", "impressions": "120000", "reach": "60000",
            "clicks": "2400", "inline_link_clicks": "1800",
            "quality_ranking": "ABOVE_AVERAGE",
            "actions": [
                {"action_type": "landing_page_view", "value": "1620"},
                {"action_type": "offsite_conversion.fb_pixel_add_to_cart", "value": "300"},
                {"action_type": "offsite_conversion.fb_pixel_initiate_checkout", "value": "150"},
                {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "75"},
            ],
            "action_values": [
                {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "9750.00"}
            ],
        },
        {   # saturado: frequência 6.0
            "ad_id": "2", "ad_name": "Criativo B - Carrossel",
            "campaign_name": "Conversao BR", "adset_name": "Retargeting 30d",
            "spend": "2200.00", "impressions": "180000", "reach": "30000",
            "clicks": "900", "inline_link_clicks": "600",
            "quality_ranking": "BELOW_AVERAGE_20",
            "actions": [
                {"action_type": "landing_page_view", "value": "540"},
                {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "12"},
            ],
            "action_values": [
                {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "1560.00"}
            ],
        },
        {   # queima dinheiro: zero conversão
            "ad_id": "3", "ad_name": "Criativo C - Video Institucional",
            "campaign_name": "Awareness", "adset_name": "Interesses amplos",
            "spend": "800.00", "impressions": "95000", "reach": "70000",
            "clicks": "380", "inline_link_clicks": "190",
            "quality_ranking": "AVERAGE",
            "actions": [{"action_type": "landing_page_view", "value": "80"}],
            "action_values": [],
        },
    ]


def fake_diario() -> list[dict]:
    """15 dias com CPA degradando no fim — deve acionar check_tendencia."""
    linhas = []
    for i in range(15):
        piora = 1 + (i / 14) * 1.2
        conv = max(1, int(10 / piora))
        linhas.append({
            "date_start": f"2026-09-{i + 1:02d}",
            "campaign_name": "Conversao BR",
            "spend": "200.00", "impressions": "15000", "reach": "12000",
            "clicks": "300", "inline_link_clicks": "220",
            "actions": [
                {"action_type": "offsite_conversion.fb_pixel_purchase", "value": str(conv)}
            ],
            "action_values": [
                {"action_type": "offsite_conversion.fb_pixel_purchase",
                 "value": str(conv * 130)}
            ],
        })
    return linhas


def test_normalize():
    df = normalize(fake_ads())
    assert len(df) == 3

    a = df[df["ad_id"] == "1"].iloc[0]
    assert a["conversoes"] == 75
    assert a["receita"] == 9750.0
    assert abs(a["roas"] - 6.5) < 0.01, f"ROAS errado: {a['roas']}"
    assert abs(a["cpa"] - 20.0) < 0.01, f"CPA errado: {a['cpa']}"
    assert abs(a["freq_calc"] - 2.0) < 0.01

    b = df[df["ad_id"] == "2"].iloc[0]
    assert abs(b["freq_calc"] - 6.0) < 0.01, f"Freq errada: {b['freq_calc']}"

    # Divisão por zero não pode virar inf/NaN
    c = df[df["ad_id"] == "3"].iloc[0]
    assert c["cpa"] == 0.0 and c["roas"] == 0.0
    print("✓ normalize: conversões, ROAS, CPA, frequência e divisão-por-zero")


def test_summarize():
    df = normalize(fake_ads())
    g = summarize(df, "campaign_name")
    assert len(g) == 2

    conv_br = g[g["campaign_name"] == "Conversao BR"].iloc[0]
    assert conv_br["spend"] == 3700.0
    assert conv_br["conversoes"] == 87
    # CPA do agregado, não média de CPAs
    assert abs(conv_br["cpa"] - 3700 / 87) < 0.01
    print("✓ summarize: agrega brutos e recalcula derivadas")


def test_analyzer():
    df = normalize(fake_ads())
    diario = normalize(fake_diario())

    adsets = [
        {"id": "s1", "name": "Retargeting 30d", "effective_status": "ACTIVE",
         "learning_stage_info": {"status": "LEARNING_LIMITED"}},
    ]

    findings = Analyzer().run(
        ads=df, campanhas=summarize(df, "campaign_name"),
        diario=diario, breakdowns={}, adsets_raw=adsets,
    )

    titulos = " | ".join(f.titulo for f in findings)
    assert "sem nenhuma conversão" in titulos, titulos
    assert "Saturação" in titulos, titulos
    assert "aprendizado limitado" in titulos, titulos
    assert "qualidade" in titulos, titulos

    # Ordenação: críticos primeiro
    assert findings[0].severidade == "critico", findings[0].severidade
    print(f"✓ analyzer: {len(findings)} achados, ordenados por severidade")
    for f in findings:
        print(f"    {f}")


def test_report():
    df = normalize(fake_ads())
    camp = summarize(df, "campaign_name")
    findings = Analyzer().run(
        ads=df, campanhas=camp, diario=normalize(fake_diario()),
        breakdowns={}, adsets_raw=[],
    )
    md = build_report(
        conta={"id": "act_000", "name": "Conta Teste", "currency": "BRL"},
        periodo=("2026-09-01", "2026-09-15"),
        ads=df, campanhas=camp, adsets=df, breakdowns={},
        findings=findings,
    )
    assert "# Análise de Tráfego" in md
    assert "Resumo executivo" in md
    assert "R$ 4,500.00" in md or "4,500" in md
    print(f"✓ report: {len(md)} chars, markdown válido")


if __name__ == "__main__":
    test_normalize()
    test_summarize()
    test_analyzer()
    test_report()
    print("\n✅ Todos os testes passaram")
