"""Extração de dados da conta: estrutura + insights em todos os níveis."""

from __future__ import annotations

import logging
from typing import Any

from .meta_client import MetaClient

log = logging.getLogger(__name__)

# Campos de insights. Cobrem custo, entrega, engajamento, conversão e vídeo.
INSIGHT_FIELDS = [
    "date_start", "date_stop",
    "account_id", "account_name",
    "campaign_id", "campaign_name",
    "adset_id", "adset_name",
    "ad_id", "ad_name",
    "objective", "optimization_goal",
    # Custo e entrega
    "spend", "impressions", "reach", "frequency",
    "cpm", "cpc", "cpp",
    # Cliques
    "clicks", "ctr",
    "inline_link_clicks", "inline_link_click_ctr", "cost_per_inline_link_click",
    "outbound_clicks", "outbound_clicks_ctr", "cost_per_outbound_click",
    # Conversão
    "actions", "action_values",
    "cost_per_action_type",
    "purchase_roas", "website_purchase_roas",
    # Qualidade (diagnóstico do leilão)
    "quality_ranking", "engagement_rate_ranking", "conversion_rate_ranking",
    # Vídeo
    "video_play_actions",
    "video_p25_watched_actions", "video_p50_watched_actions",
    "video_p75_watched_actions", "video_p100_watched_actions",
    "video_thruplay_watched_actions",
]

# Conjuntos de breakdown. A API não aceita combinar qualquer par —
# cada entrada abaixo é uma chamada separada e válida.
BREAKDOWN_SETS: dict[str, list[str]] = {
    "demografico":   ["age", "gender"],
    "posicionamento": ["publisher_platform", "platform_position"],
    "dispositivo":   ["impression_device"],
    "regiao":        ["region"],
    "pais":          ["country"],
    "hora":          ["hourly_stats_aggregated_by_advertiser_time_zone"],
}

# Campos reduzidos para breakdowns — pedir o conjunto completo com breakdown
# estoura o limite de complexidade da API.
BREAKDOWN_FIELDS = [
    "spend", "impressions", "reach", "frequency", "clicks", "ctr",
    "cpm", "cpc", "inline_link_clicks", "actions", "action_values",
    "purchase_roas",
]


class AccountFetcher:
    def __init__(self, client: MetaClient):
        self.client = client
        self.account = client.settings.ad_account_id

    # ── estrutura da conta ─────────────────────────────────────────

    def account_info(self) -> dict:
        return self.client.get(self.account, {
            "fields": ",".join([
                "id", "name", "account_status", "currency", "timezone_name",
                "amount_spent", "balance", "spend_cap",
                "business_name", "disable_reason", "funding_source_details",
                "created_time",
            ])
        })

    def campaigns(self) -> list[dict]:
        return self.client.get_all(f"{self.account}/campaigns", {
            "fields": ",".join([
                "id", "name", "status", "effective_status", "objective",
                "buying_type", "bid_strategy", "daily_budget", "lifetime_budget",
                "budget_remaining", "created_time", "updated_time", "start_time",
                "stop_time", "special_ad_categories",
            ]),
            "limit": 200,
        })

    def adsets(self) -> list[dict]:
        return self.client.get_all(f"{self.account}/adsets", {
            "fields": ",".join([
                "id", "name", "campaign_id", "status", "effective_status",
                "optimization_goal", "billing_event", "bid_amount", "bid_strategy",
                "daily_budget", "lifetime_budget", "budget_remaining",
                "learning_stage_info", "targeting", "attribution_spec",
                "start_time", "end_time", "created_time", "destination_type",
            ]),
            "limit": 200,
        })

    def ads(self) -> list[dict]:
        return self.client.get_all(f"{self.account}/ads", {
            "fields": ",".join([
                "id", "name", "adset_id", "campaign_id", "status",
                "effective_status", "created_time", "updated_time",
                "creative{id,name,title,body,object_type,thumbnail_url,"
                "effective_object_story_id,call_to_action_type}",
            ]),
            "limit": 200,
        })

    def pixels(self) -> list[dict]:
        """Pixels da conta — base para auditar rastreamento."""
        try:
            return self.client.get_all(f"{self.account}/adspixels", {
                "fields": "id,name,last_fired_time,is_created_by_business",
            })
        except Exception as exc:  # pixel exige permissão extra
            log.warning("Não foi possível ler pixels: %s", exc)
            return []

    def custom_conversions(self) -> list[dict]:
        try:
            return self.client.get_all(f"{self.account}/customconversions", {
                "fields": "id,name,custom_event_type,rule,is_archived",
            })
        except Exception as exc:
            log.warning("Não foi possível ler conversões personalizadas: %s", exc)
            return []

    # ── insights ───────────────────────────────────────────────────

    def insights(
        self,
        level: str,
        *,
        since: str,
        until: str,
        breakdowns: list[str] | None = None,
        time_increment: int | str | None = None,
        fields: list[str] | None = None,
    ) -> list[dict]:
        """Insights num nível (account/campaign/adset/ad).

        `time_increment=1` devolve série diária; omitido, devolve o agregado
        do período inteiro.
        """
        params: dict[str, Any] = {
            "level": level,
            "time_range": f'{{"since":"{since}","until":"{until}"}}',
            "fields": ",".join(fields or INSIGHT_FIELDS),
            "limit": 500,
        }
        if breakdowns:
            params["breakdowns"] = ",".join(breakdowns)
        if time_increment:
            params["time_increment"] = time_increment

        return self.client.get_all(f"{self.account}/insights", params)

    def insights_with_breakdowns(
        self, level: str, *, since: str, until: str
    ) -> dict[str, list[dict]]:
        """Roda todos os conjuntos de breakdown e devolve indexado por nome."""
        out: dict[str, list[dict]] = {}
        for name, bd in BREAKDOWN_SETS.items():
            try:
                out[name] = self.insights(
                    level, since=since, until=until,
                    breakdowns=bd, fields=BREAKDOWN_FIELDS,
                )
                log.info("Breakdown %-14s → %d linhas", name, len(out[name]))
            except Exception as exc:
                log.warning("Breakdown %s falhou: %s", name, exc)
                out[name] = []
        return out
