"""Motor de diagnóstico: transforma métricas em achados acionáveis.

Cada regra devolve um Finding com severidade, evidência numérica e ação
recomendada. Os limiares são heurísticos e ficam em THRESHOLDS — ajuste
por vertical antes de tratar qualquer achado como veredito.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import pandas as pd

Severity = Literal["critico", "alto", "medio", "baixo", "info"]

SEVERITY_ORDER = {"critico": 0, "alto": 1, "medio": 2, "baixo": 3, "info": 4}

# Limiares heurísticos. Ajustar por vertical/ticket antes de usar como regra.
THRESHOLDS = {
    "freq_saturacao": 3.5,        # frequência acima disso = desgaste provável
    "freq_critica": 5.0,
    "ctr_link_baixo": 0.8,        # % — abaixo disso o criativo não engaja
    "ctr_link_bom": 1.5,
    "gasto_sem_conversao": 100.0, # R$ gasto sem 1 conversão = sinal de corte
    "concentracao_budget": 0.70,  # 1 campanha com >70% do gasto = risco
    "min_conversoes_aprendizado": 50,  # janela de 7 dias, padrão da Meta
    "tx_lpv_baixa": 70.0,         # % de cliques que viram pageview
    "roas_alvo": 2.0,
}


@dataclass
class Finding:
    titulo: str
    severidade: Severity
    evidencia: str
    acao: str
    entidades: list[str] = field(default_factory=list)
    impacto_estimado: float = 0.0   # R$ em jogo

    def __str__(self) -> str:
        return f"[{self.severidade.upper()}] {self.titulo}"


class Analyzer:
    def __init__(self, thresholds: dict | None = None):
        self.t = {**THRESHOLDS, **(thresholds or {})}
        self.findings: list[Finding] = []

    def _add(self, **kw) -> None:
        self.findings.append(Finding(**kw))

    # ── regras ─────────────────────────────────────────────────────

    def check_saturacao(self, df: pd.DataFrame) -> None:
        """Frequência alta = mesma audiência vendo o mesmo anúncio demais."""
        if df.empty or "freq_calc" not in df:
            return
        col = "adset_name" if "adset_name" in df else "campaign_name"
        if col not in df:
            return

        sat = df[df["freq_calc"] >= self.t["freq_saturacao"]].nlargest(10, "spend")
        if sat.empty:
            return

        critico = sat["freq_calc"].max() >= self.t["freq_critica"]
        gasto = float(sat["spend"].sum())
        nomes = sat[col].head(5).tolist()

        self._add(
            titulo="Saturação de audiência (frequência elevada)",
            severidade="critico" if critico else "alto",
            evidencia=(
                f"{len(sat)} conjunto(s) com frequência ≥ {self.t['freq_saturacao']:.1f} "
                f"(máx {sat['freq_calc'].max():.1f}), somando R$ {gasto:,.2f} de gasto. "
                "Frequência alta derruba CTR e infla CPM no leilão."
            ),
            acao=(
                "Trocar/rotacionar criativos nesses conjuntos, ampliar a audiência "
                "ou aplicar exclusão de quem já converteu. Se a audiência for pequena "
                "por natureza, reduzir orçamento em vez de insistir."
            ),
            entidades=nomes,
            impacto_estimado=gasto,
        )

    def check_ctr(self, df: pd.DataFrame) -> None:
        """CTR de link baixo com gasto relevante = criativo fraco."""
        if df.empty or "ctr_link" not in df or "ad_name" not in df:
            return

        relevante = df[df["spend"] >= self.t["gasto_sem_conversao"]]
        fracos = relevante[relevante["ctr_link"] < self.t["ctr_link_baixo"]]
        if fracos.empty:
            return

        gasto = float(fracos["spend"].sum())
        self._add(
            titulo="Criativos com CTR de link abaixo do aceitável",
            severidade="alto" if gasto > 500 else "medio",
            evidencia=(
                f"{len(fracos)} anúncio(s) com CTR de link < {self.t['ctr_link_baixo']}% "
                f"consumiram R$ {gasto:,.2f}. CTR baixo encarece o CPM porque o "
                "leilão penaliza anúncios com pouca interação."
            ),
            acao=(
                "Pausar os piores e testar novo ângulo de copy/criativo. "
                "Priorizar hook nos primeiros 3 segundos (vídeo) ou headline (estático)."
            ),
            entidades=fracos.nlargest(5, "spend")["ad_name"].tolist(),
            impacto_estimado=gasto,
        )

    def check_gasto_sem_conversao(self, df: pd.DataFrame) -> None:
        """Dinheiro queimado: gasto acumulado sem nenhuma conversão."""
        if df.empty or "conversoes" not in df:
            return
        col = "ad_name" if "ad_name" in df else "adset_name"
        if col not in df:
            return

        zerados = df[
            (df["conversoes"] == 0) & (df["spend"] >= self.t["gasto_sem_conversao"])
        ].nlargest(15, "spend")
        if zerados.empty:
            return

        desperdicio = float(zerados["spend"].sum())
        self._add(
            titulo="Gasto sem nenhuma conversão registrada",
            severidade="critico",
            evidencia=(
                f"{len(zerados)} item(ns) gastaram R$ {desperdicio:,.2f} sem registrar "
                "1 conversão. Isso é desperdício direto — ou falha de rastreamento."
            ),
            acao=(
                "Antes de pausar, confirmar se o pixel está disparando o evento certo. "
                "Se o rastreamento está OK, pausar e realocar o orçamento para os "
                "conjuntos com CPA dentro da meta."
            ),
            entidades=zerados[col].head(5).tolist(),
            impacto_estimado=desperdicio,
        )

    def check_concentracao(self, df: pd.DataFrame) -> None:
        """Orçamento concentrado demais = risco de ponto único de falha."""
        if df.empty or "campaign_name" not in df:
            return

        por_camp = df.groupby("campaign_name")["spend"].sum().sort_values(ascending=False)
        total = por_camp.sum()
        if total <= 0 or len(por_camp) < 2:
            return

        share = por_camp.iloc[0] / total
        if share < self.t["concentracao_budget"]:
            return

        self._add(
            titulo="Orçamento concentrado numa única campanha",
            severidade="medio",
            evidencia=(
                f"'{por_camp.index[0]}' concentra {share:.0%} do gasto "
                f"(R$ {por_camp.iloc[0]:,.2f} de R$ {total:,.2f})."
            ),
            acao=(
                "Concentração não é erro em si — se ela performa, faz sentido. "
                "O risco é operacional: qualquer queda nela derruba a conta inteira. "
                "Manter ao menos uma campanha secundária validada como plano B."
            ),
            entidades=[por_camp.index[0]],
            impacto_estimado=float(por_camp.iloc[0]),
        )

    def check_aprendizado(self, adsets: list[dict]) -> None:
        """Conjuntos presos em 'aprendizado limitado' nunca estabilizam."""
        limitados = [
            a for a in adsets
            if (a.get("learning_stage_info") or {}).get("status") == "LEARNING_LIMITED"
        ]
        if not limitados:
            return

        self._add(
            titulo="Conjuntos em aprendizado limitado",
            severidade="alto",
            evidencia=(
                f"{len(limitados)} conjunto(s) travados em LEARNING_LIMITED — "
                f"não atingem as ~{self.t['min_conversoes_aprendizado']} conversões/7 dias "
                "que o algoritmo precisa para otimizar. A entrega fica instável e cara."
            ),
            acao=(
                "Consolidar conjuntos que disputam a mesma audiência, aumentar o "
                "orçamento por conjunto, ou mudar o evento de otimização para um "
                "mais alto no funil (ex: de Compra para Checkout iniciado)."
            ),
            entidades=[a.get("name", a.get("id", "?")) for a in limitados[:5]],
        )

    def check_fragmentacao(self, adsets: list[dict], df: pd.DataFrame) -> None:
        """Conjuntos demais dividindo pouco orçamento = ninguém sai do aprendizado."""
        ativos = [a for a in adsets if a.get("effective_status") == "ACTIVE"]
        if len(ativos) < 8 or df.empty:
            return

        gasto_total = float(df["spend"].sum())
        media = gasto_total / max(len(ativos), 1)

        self._add(
            titulo="Estrutura fragmentada em conjuntos demais",
            severidade="medio",
            evidencia=(
                f"{len(ativos)} conjuntos ativos dividindo R$ {gasto_total:,.2f} "
                f"(~R$ {media:,.2f} por conjunto no período). Muitos conjuntos "
                "pequenos competem entre si no leilão e nenhum acumula dados suficientes."
            ),
            acao=(
                "Consolidar em menos conjuntos com orçamento maior. Considerar CBO "
                "(Advantage+ Campaign Budget) para o algoritmo distribuir sozinho."
            ),
        )

    def check_qualidade(self, df: pd.DataFrame) -> None:
        """Rankings de qualidade abaixo da média encarecem o leilão."""
        if df.empty or "quality_ranking" not in df:
            return

        ruins = {"BELOW_AVERAGE_10", "BELOW_AVERAGE_20", "BELOW_AVERAGE_35"}
        mask = df["quality_ranking"].isin(ruins)
        if not mask.any():
            return

        afetados = df[mask]
        gasto = float(afetados["spend"].sum())
        nomes = (afetados.nlargest(5, "spend")["ad_name"].tolist()
                 if "ad_name" in afetados else [])

        self._add(
            titulo="Anúncios com ranking de qualidade abaixo da média",
            severidade="alto",
            evidencia=(
                f"{int(mask.sum())} anúncio(s) com quality_ranking abaixo da média, "
                f"R$ {gasto:,.2f} em gasto. A Meta cobra mais caro para entregar "
                "anúncios que ela considera de baixa qualidade."
            ),
            acao=(
                "Revisar o criativo: excesso de texto na imagem, promessa exagerada "
                "ou linguagem sensacionalista derrubam esse ranking. Refazer o anúncio "
                "em vez de tentar recuperar o existente."
            ),
            entidades=nomes,
            impacto_estimado=gasto,
        )

    def check_funil(self, df: pd.DataFrame) -> None:
        """Encontra a etapa do funil onde o usuário desiste."""
        if df.empty:
            return

        clicks = float(df.get("inline_link_clicks", pd.Series([0])).sum())
        lpv = float(df.get("lpv", pd.Series([0])).sum())
        atc = float(df.get("add_to_cart", pd.Series([0])).sum())
        ic = float(df.get("initiate_checkout", pd.Series([0])).sum())
        conv = float(df.get("conversoes", pd.Series([0])).sum())

        if clicks <= 0:
            return

        # Vazamento clique → pageview: quase sempre problema técnico, não de oferta.
        if lpv > 0:
            tx = lpv / clicks * 100
            if tx < self.t["tx_lpv_baixa"]:
                perdidos = clicks - lpv
                self._add(
                    titulo="Perda entre clique e carregamento da página",
                    severidade="critico",
                    evidencia=(
                        f"Só {tx:.0f}% dos cliques viraram visualização de página "
                        f"({int(lpv):,} de {int(clicks):,}). "
                        f"{int(perdidos):,} cliques pagos não chegaram ao site."
                    ),
                    acao=(
                        "Isso quase nunca é a oferta — é velocidade de carregamento "
                        "ou falha do pixel. Testar a página no 4G, medir o LCP, e "
                        "confirmar que o PageView dispara antes de qualquer redirect."
                    ),
                )

        # Etapa com maior queda relativa dentro do funil de e-commerce.
        etapas = [("Pageview→Carrinho", lpv, atc),
                  ("Carrinho→Checkout", atc, ic),
                  ("Checkout→Compra", ic, conv)]
        quedas = [(nome, de, para, (1 - para / de) * 100)
                  for nome, de, para in etapas if de > 20]

        if quedas:
            pior = max(quedas, key=lambda x: x[3])
            if pior[3] > 60:
                self._add(
                    titulo=f"Maior vazamento do funil: {pior[0]}",
                    severidade="alto",
                    evidencia=(
                        f"{pior[3]:.0f}% de queda nessa etapa "
                        f"({int(pior[1]):,} → {int(pior[2]):,})."
                    ),
                    acao=(
                        "Essa etapa é a de maior retorno para otimizar — melhorar ela "
                        "multiplica o resultado sem aumentar 1 real de mídia."
                    ),
                )

    def check_dimensao(self, df: pd.DataFrame, dim: str, rotulo: str) -> None:
        """Compara performance entre segmentos e aponta os extremos."""
        if df.empty or dim not in df.columns:
            return

        g = df.groupby(dim, as_index=False).agg(
            spend=("spend", "sum"),
            conversoes=("conversoes", "sum"),
            impressions=("impressions", "sum"),
        )
        g = g[g["spend"] >= self.t["gasto_sem_conversao"]]
        if len(g) < 2:
            return

        g["cpa"] = g.apply(
            lambda r: r["spend"] / r["conversoes"] if r["conversoes"] > 0 else float("inf"),
            axis=1,
        )
        com_conv = g[g["conversoes"] > 0].sort_values("cpa")
        if len(com_conv) < 2:
            return

        melhor, pior = com_conv.iloc[0], com_conv.iloc[-1]
        if pior["cpa"] < melhor["cpa"] * 1.8:
            return  # diferença pequena demais para agir

        self._add(
            titulo=f"Diferença relevante de CPA por {rotulo}",
            severidade="medio",
            evidencia=(
                f"Melhor: '{melhor[dim]}' com CPA R$ {melhor['cpa']:,.2f}. "
                f"Pior: '{pior[dim]}' com CPA R$ {pior['cpa']:,.2f} "
                f"({pior['cpa'] / melhor['cpa']:.1f}x mais caro, "
                f"R$ {pior['spend']:,.2f} gastos)."
            ),
            acao=(
                f"Realocar orçamento de {rotulo} para os segmentos eficientes. "
                "Antes de excluir o pior, checar volume — segmento pequeno tem "
                "CPA instável por ruído estatístico, não por ser ruim."
            ),
            entidades=[str(melhor[dim]), str(pior[dim])],
            impacto_estimado=float(pior["spend"]),
        )

    def check_tendencia(self, diario: pd.DataFrame) -> None:
        """Compara as duas metades do período para detectar degradação."""
        if diario.empty or "date_start" not in diario:
            return

        d = diario.copy()
        d["date_start"] = pd.to_datetime(d["date_start"], errors="coerce")
        d = d.dropna(subset=["date_start"]).sort_values("date_start")
        if d["date_start"].nunique() < 8:
            return

        dias = d["date_start"].unique()
        meio = len(dias) // 2
        ini = d[d["date_start"].isin(dias[:meio])]
        fim = d[d["date_start"].isin(dias[meio:])]

        def cpa(x: pd.DataFrame) -> float:
            c = x["conversoes"].sum()
            return x["spend"].sum() / c if c > 0 else float("inf")

        cpa_ini, cpa_fim = cpa(ini), cpa(fim)
        if cpa_ini == float("inf") or cpa_fim == float("inf") or cpa_ini <= 0:
            return

        delta = (cpa_fim - cpa_ini) / cpa_ini * 100
        if delta <= 25:
            return

        self._add(
            titulo="CPA em deterioração ao longo do período",
            severidade="alto",
            evidencia=(
                f"CPA subiu {delta:.0f}% da primeira para a segunda metade do período "
                f"(R$ {cpa_ini:,.2f} → R$ {cpa_fim:,.2f}). "
                "Padrão típico de desgaste criativo ou saturação de audiência."
            ),
            acao=(
                "Cruzar com a frequência no mesmo recorte. Se ela subiu junto, "
                "é fadiga de criativo — renovar. Se ficou estável, investigar "
                "mudança de concorrência no leilão ou sazonalidade."
            ),
        )

    # ── orquestração ───────────────────────────────────────────────

    def run(
        self,
        *,
        ads: pd.DataFrame,
        campanhas: pd.DataFrame,
        diario: pd.DataFrame,
        breakdowns: dict[str, pd.DataFrame],
        adsets_raw: list[dict],
    ) -> list[Finding]:
        self.findings = []

        self.check_gasto_sem_conversao(ads)
        self.check_saturacao(ads)
        self.check_ctr(ads)
        self.check_qualidade(ads)
        self.check_concentracao(campanhas)
        self.check_aprendizado(adsets_raw)
        self.check_fragmentacao(adsets_raw, ads)
        self.check_funil(ads)
        self.check_tendencia(diario)

        dims = [
            ("demografico", "age", "faixa etária"),
            ("demografico", "gender", "gênero"),
            ("posicionamento", "platform_position", "posicionamento"),
            ("dispositivo", "impression_device", "dispositivo"),
            ("regiao", "region", "região"),
            ("hora", "hourly_stats_aggregated_by_advertiser_time_zone", "horário"),
        ]
        for chave, dim, rotulo in dims:
            bdf = breakdowns.get(chave)
            if bdf is not None and not bdf.empty:
                self.check_dimensao(bdf, dim, rotulo)

        self.findings.sort(
            key=lambda f: (SEVERITY_ORDER[f.severidade], -f.impacto_estimado)
        )
        return self.findings
