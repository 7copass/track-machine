"""Normalização de insights e cálculo de métricas derivadas.

A Graph API devolve conversões como lista aninhada de {action_type, value}.
Aqui isso vira coluna plana e as métricas de eficiência são recalculadas a
partir dos números brutos — nunca lidas prontas da API, que arredonda.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

# Eventos de conversão que interessam, na ordem do funil.
FUNNEL = [
    ("landing_page_view",                       "lpv"),
    ("offsite_conversion.fb_pixel_view_content", "view_content"),
    ("offsite_conversion.fb_pixel_add_to_cart",  "add_to_cart"),
    ("offsite_conversion.fb_pixel_initiate_checkout", "initiate_checkout"),
    ("offsite_conversion.fb_pixel_add_payment_info",  "add_payment_info"),
    ("offsite_conversion.fb_pixel_lead",         "lead"),
    ("lead",                                     "lead_generic"),
    ("offsite_conversion.fb_pixel_complete_registration", "registration"),
    ("offsite_conversion.fb_pixel_purchase",     "purchase"),
    ("purchase",                                 "purchase_generic"),
    ("omni_purchase",                            "purchase_omni"),
    ("onsite_conversion.messaging_conversation_started_7d", "msg_started"),
    ("link_click",                               "link_click"),
    ("video_view",                               "video_view"),
    ("post_engagement",                          "post_engagement"),
]

NUMERIC = [
    "spend", "impressions", "reach", "frequency", "clicks",
    "inline_link_clicks", "cpm", "cpc", "ctr", "inline_link_click_ctr",
]


def _actions_to_dict(raw: Any) -> dict[str, float]:
    """Converte [{action_type, value}, ...] em {action_type: valor}."""
    if not isinstance(raw, list):
        return {}
    out: dict[str, float] = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        key = item.get("action_type")
        try:
            out[key] = float(item.get("value", 0) or 0)
        except (TypeError, ValueError):
            continue
    return out


def _first_roas(raw: Any) -> float:
    """purchase_roas vem como lista; devolve o primeiro valor numérico."""
    if isinstance(raw, list) and raw:
        try:
            return float(raw[0].get("value", 0) or 0)
        except (TypeError, ValueError, AttributeError):
            return 0.0
    return 0.0


def normalize(rows: list[dict]) -> pd.DataFrame:
    """Transforma a resposta crua da API num DataFrame analisável."""
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)

    for col in NUMERIC:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)
        else:
            df[col] = 0.0

    # Explode actions / action_values em colunas nomeadas.
    actions = df["actions"].apply(_actions_to_dict) if "actions" in df else None
    values = df["action_values"].apply(_actions_to_dict) if "action_values" in df else None

    for api_key, short in FUNNEL:
        df[short] = actions.apply(lambda d, k=api_key: d.get(k, 0.0)) if actions is not None else 0.0
        if values is not None:
            df[f"{short}_value"] = values.apply(lambda d, k=api_key: d.get(k, 0.0))

    # Consolida variantes de compra (pixel / omni / genérico) numa só coluna.
    purchase_cols = [c for c in ("purchase", "purchase_generic", "purchase_omni") if c in df]
    df["conversoes"] = df[purchase_cols].max(axis=1) if purchase_cols else 0.0

    value_cols = [f"{c}_value" for c in purchase_cols if f"{c}_value" in df]
    df["receita"] = df[value_cols].max(axis=1) if value_cols else 0.0

    # Leads consolidados (contas de geração de lead usam chaves diferentes).
    lead_cols = [c for c in ("lead", "lead_generic", "registration") if c in df]
    df["leads"] = df[lead_cols].max(axis=1) if lead_cols else 0.0

    if "purchase_roas" in df.columns:
        df["roas_api"] = df["purchase_roas"].apply(_first_roas)

    return _derive(df)


def _safe_div(a: pd.Series, b: pd.Series) -> pd.Series:
    """Divisão que devolve 0 em vez de inf/NaN quando o denominador é zero.

    Mantém tudo em float o tempo todo: usar pd.NA como sentinela cria coluna
    de dtype object e o downcast implícito do pandas gera FutureWarning.
    """
    a = pd.to_numeric(a, errors="coerce").astype("float64")
    b = pd.to_numeric(b, errors="coerce").astype("float64")
    out = a.divide(b)
    return out.replace([float("inf"), float("-inf")], 0.0).fillna(0.0)


def _derive(df: pd.DataFrame) -> pd.DataFrame:
    """Recalcula métricas de eficiência a partir dos números brutos."""
    spend = df["spend"]

    df["cpm_calc"] = _safe_div(spend * 1000, df["impressions"])
    df["ctr_calc"] = _safe_div(df["clicks"] * 100, df["impressions"])
    df["ctr_link"] = _safe_div(df["inline_link_clicks"] * 100, df["impressions"])
    df["cpc_link"] = _safe_div(spend, df["inline_link_clicks"])
    df["freq_calc"] = _safe_div(df["impressions"], df["reach"])

    # Conversão
    df["cpa"] = _safe_div(spend, df["conversoes"])
    df["roas"] = _safe_div(df["receita"], spend)
    df["ticket_medio"] = _safe_div(df["receita"], df["conversoes"])
    df["tx_conversao"] = _safe_div(df["conversoes"] * 100, df["inline_link_clicks"])

    df["cpl"] = _safe_div(spend, df["leads"])

    # Etapas do funil — onde o dinheiro vaza
    if "lpv" in df:
        df["tx_lpv"] = _safe_div(df["lpv"] * 100, df["inline_link_clicks"])
        df["cp_lpv"] = _safe_div(spend, df["lpv"])
    if "add_to_cart" in df:
        df["tx_atc"] = _safe_div(df["add_to_cart"] * 100, df["lpv"])
    if "initiate_checkout" in df:
        df["tx_checkout"] = _safe_div(df["initiate_checkout"] * 100, df["add_to_cart"])
        df["tx_fechamento"] = _safe_div(df["conversoes"] * 100, df["initiate_checkout"])

    return df


def summarize(df: pd.DataFrame, by: str) -> pd.DataFrame:
    """Agrega por uma dimensão e recalcula as derivadas sobre o total.

    Somar médias produz número errado; por isso agregamos os brutos e só
    então recalculamos CPM, CTR, CPA e ROAS.
    """
    if df.empty or by not in df.columns:
        return pd.DataFrame()

    base = {
        "spend": "sum", "impressions": "sum", "reach": "sum",
        "clicks": "sum", "inline_link_clicks": "sum",
        "conversoes": "sum", "receita": "sum", "leads": "sum",
    }
    agg = {k: v for k, v in base.items() if k in df.columns}
    out = df.groupby(by, as_index=False).agg(agg)

    return _derive(out).sort_values("spend", ascending=False)
