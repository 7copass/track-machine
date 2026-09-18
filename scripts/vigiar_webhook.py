#!/usr/bin/env python3
"""Vigia o webhook do Evolution até chegar um lead de anúncio.

Emite uma linha por acontecimento — cada linha vira uma notificação:
  · tráfego passando pelo webhook (prova que a ligação está viva)
  · touchpoint novo (o que estamos esperando)

Encerra quando o primeiro touchpoint com ctwa_clid entrar.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_pgtap import carregar_env, executar  # noqa: E402

INTERVALO = 30


def consultar(sql: str):
    ok, r = executar(sql)
    return r if ok and isinstance(r, list) else None


def main() -> int:
    carregar_env()

    ultimo_visto = None
    vistos: set[str] = set()
    silencios = 0

    while True:
        inst = consultar("""
            select nome_instancia, estado, ultimo_evento_em::text as visto
              from evolution_instances
        """)

        if inst:
            visto = inst[0]["visto"]
            if ultimo_visto is None:
                ultimo_visto = visto
            elif visto != ultimo_visto:
                print(f"TRAFEGO: mensagem passou pelo webhook as {visto[11:19]} "
                      f"(instancia {inst[0]['nome_instancia']} viva)", flush=True)
                ultimo_visto = visto
                silencios = 0

        tps = consultar("""
            select wa_message_id, phone_e164, ad_id, platform,
                   ctwa_clid is not null as tem_clid
              from ad_touchpoints
             order by criado_em desc limit 5
        """)

        if tps:
            for t in tps:
                if t["wa_message_id"] in vistos:
                    continue
                vistos.add(t["wa_message_id"])
                if t["tem_clid"]:
                    print(f"LEAD DE ANUNCIO: {t['phone_e164']} veio do anuncio "
                          f"{t['ad_id']} ({t['platform']}) — ctwa_clid capturado",
                          flush=True)
                    return 0
                print(f"TOUCHPOINT sem clid: {t['phone_e164']} "
                      f"anuncio {t['ad_id']}", flush=True)

        silencios += 1
        # Marco a cada 10 minutos, para silencio total nao parecer
        # monitor morto — a diferenca entre "nada chegou" e "parei de olhar"
        if silencios % 20 == 0:
            print(f"(sem novidade ha {silencios * INTERVALO // 60} min; "
                  f"vigilancia ativa)", flush=True)

        time.sleep(INTERVALO)


if __name__ == "__main__":
    raise SystemExit(main())
