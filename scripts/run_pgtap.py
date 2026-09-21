#!/usr/bin/env python3
"""Roda uma suíte pgTAP no Supabase remoto sem deixar resíduo.

A API de query do Supabase commita cada chamada, então não dá para usar
begin/rollback. A saída é: rodar a suíte inteira dentro de um bloco que
coleta os resultados e termina levantando exceção. A exceção desfaz tudo
que o teste criou, e a mensagem dela carrega o relatório de volta.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]


def carregar_env() -> None:
    for linha in (RAIZ / ".env").read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if linha and not linha.startswith("#") and "=" in linha:
            k, v = linha.split("=", 1)
            # setdefault deixaria uma variavel ja exportada no shell
            # vencer o .env em silencio — e apontar para o projeto errado.
            valor = v.strip()
            # Tira aspas: `supabase projects api-keys -o env` devolve o
            # valor entre aspas, e sem isso elas entram no proprio segredo.
            # O sintoma e "Invalid API key" com a chave certa no arquivo.
            if len(valor) >= 2 and valor[0] == valor[-1] and valor[0] in "\"'":
                valor = valor[1:-1]
            os.environ[k.strip()] = valor


def executar(sql: str) -> tuple[bool, object]:
    ref = os.environ["SUPABASE_PROJECT_REF"]
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['SUPABASE_ACCESS_TOKEN']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        return True, json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return False, json.load(e).get("message", str(e))


def envolver(corpo_do_teste: str) -> str:
    """Envolve a suíte num bloco que reporta e depois desfaz tudo."""
    return f"""
do $runner$
declare
  linha   text;
  relato  text := '';
begin
  for linha in
    {corpo_do_teste}
  loop
    relato := relato || linha || chr(10);
  end loop;

  -- A excecao e o mecanismo de rollback: desfaz as fixtures do teste e
  -- devolve o relatorio pela mensagem de erro.
  raise exception E'PGTAP_RELATORIO\\n%', relato;
end
$runner$;
"""


def avaliar(linhas: list[str]) -> list[str]:
    """Decide se a suíte passou de verdade.

    Procurar só por "not ok" não basta: uma suíte que morre no meio emite
    as asserções que deu tempo de rodar, o pgTAP acrescenta um diagnóstico
    com "#", e a leitura ingênua enxerga isso como verde. Falso-verde é
    pior que falha, porque ninguém vai investigar.
    """
    problemas: list[str] = []

    falhas = [l for l in linhas if l.startswith("not ok")]
    if falhas:
        problemas.append(f"{len(falhas)} asserção(ões) falharam")

    # O pgTAP avisa quando o número de testes não bate com o plano
    for l in linhas:
        if "Looks like you planned" in l or "Looks like you failed" in l:
            problemas.append(f"pgTAP reclamou: {l.lstrip('# ').strip()}")

    # Plano ausente: sem "1..N" não há como saber se rodou tudo
    plano = next((l for l in linhas if re.fullmatch(r"1\.\.\d+", l.strip())), None)
    if not plano:
        problemas.append("sem linha de plano (1..N) — a suíte não declarou quantos testes esperava")
        return problemas

    # Confere a contagem, independente do que o pgTAP disse
    esperados = int(plano.strip().split("..")[1])
    rodados = len([l for l in linhas if re.match(r"(not )?ok \d+", l)])
    if rodados != esperados:
        problemas.append(f"plano previa {esperados} teste(s), rodaram {rodados}")

    return problemas


def main() -> int:
    carregar_env()

    if len(sys.argv) < 2:
        print("uso: run_pgtap.py <arquivo.sql> [...]")
        return 2

    falhou_algum = False

    for caminho in sys.argv[1:]:
        arquivo = Path(caminho)
        corpo = arquivo.read_text(encoding="utf-8").strip()

        ok, resposta = executar(envolver(corpo))

        # O caminho de sucesso É o erro: a excecao proposital.
        texto = resposta if isinstance(resposta, str) else json.dumps(resposta)

        if "PGTAP_RELATORIO" not in texto:
            print(f"\n✗ {arquivo.name}: nao rodou")
            print(f"  {texto[:400]}")
            falhou_algum = True
            continue

        relato = texto.split("PGTAP_RELATORIO", 1)[1]
        relato = relato.replace("\\n", "\n").strip()

        linhas = [l for l in relato.splitlines() if l.strip()]
        problemas = avaliar(linhas)

        print(f"\n{'✗' if problemas else '✓'} {arquivo.name}")
        for l in linhas:
            print(f"    {l}")
        for p in problemas:
            print(f"    ⚠ {p}")

        if problemas:
            falhou_algum = True

    print()
    print("RESULTADO:", "FALHOU" if falhou_algum else "TUDO PASSOU")
    return 1 if falhou_algum else 0


if __name__ == "__main__":
    raise SystemExit(main())
