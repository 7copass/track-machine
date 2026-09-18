# Track Machine

Análise de tráfego pago Meta Ads: puxa os dados direto da Graph API, normaliza,
roda um diagnóstico automático e gera relatório com insights e pontos de melhoria
priorizados.

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env
```

Preencha o `.env`:

| Variável | O que é |
|---|---|
| `META_ACCESS_TOKEN` | Token com escopo `ads_read` |
| `META_AD_ACCOUNT_ID` | ID da conta, com prefixo `act_` |
| `META_API_VERSION` | Versão da Graph API (padrão `v21.0`) |

> **O `.env` está no `.gitignore` e nunca vai pro repositório.**
> O token também é removido de qualquer log ou mensagem de erro antes de ser exibido.

### Gerando o token

**Recomendado — System User (não expira):**
Business Manager → Configurações do Negócio → Usuários do sistema → Gerar token
→ selecionar o app → marcar `ads_read` e `business_management`.

**Rápido — Graph API Explorer (expira em ~1-2h):**
[developers.facebook.com/tools/explorer](https://developers.facebook.com/tools/explorer)

## Uso

```bash
python scripts/check_token.py
```

Valida token, escopos, expiração e acesso à conta. **Rode isto primeiro** — evita
descobrir no meio da extração que faltava permissão.

```bash
python scripts/run_analysis.py --dias 30
```

Opções:

| Flag | Efeito |
|---|---|
| `--dias N` | Janela de análise (padrão 30) |
| `--since / --until` | Datas explícitas `YYYY-MM-DD` |
| `--sem-breakdowns` | Pula os cortes por segmento — mais rápido |
| `--salvar-bruto` | Salva as respostas cruas em `data/raw/` |
| `--saida` | Caminho do relatório |

O relatório sai em `reports/analise_<inicio>_a_<fim>.md`, e os dados normalizados
em `data/processed/*.csv`.

## O que a análise cobre

**Métricas** — gasto, impressões, alcance, frequência, CPM, CTR (total e de link),
CPC, conversões, CPA, ROAS, ticket médio, taxa de conversão e funil completo
(pageview → carrinho → checkout → compra).

**Cortes** — faixa etária, gênero, posicionamento, dispositivo, região, país e
horário.

**Diagnóstico automático** (`src/track_machine/analyze.py`):

| Regra | Detecta |
|---|---|
| Gasto sem conversão | Verba queimada — ou falha de rastreamento |
| Saturação | Frequência alta derrubando CTR e inflando CPM |
| CTR baixo | Criativo que não engaja e encarece o leilão |
| Ranking de qualidade | Anúncios que a Meta penaliza na entrega |
| Aprendizado limitado | Conjuntos que nunca estabilizam |
| Fragmentação | Conjuntos demais competindo entre si |
| Concentração de verba | Risco de ponto único de falha |
| Vazamento de funil | Em que etapa o usuário desiste |
| Tendência de CPA | Degradação ao longo do período |
| CPA por segmento | Onde realocar orçamento |

Cada achado sai com severidade, evidência numérica, ação recomendada e o
investimento envolvido.

## Estrutura

```
src/track_machine/
  config.py        carrega e valida o .env
  meta_client.py   Graph API: paginação, retry, rate limit, scrub de token
  fetch.py         extração de estrutura e insights
  metrics.py       normaliza actions aninhadas e recalcula derivadas
  analyze.py       regras de diagnóstico
  report.py        relatório em Markdown
scripts/
  check_token.py   validação pré-voo
  run_analysis.py  pipeline completo
tests/
  test_smoke.py    pipeline end-to-end com dados sintéticos
```

## Testes

```bash
python tests/test_smoke.py
```

Roda sem token, com dados sintéticos que têm problemas plantados de propósito —
confere que as regras disparam e que os cálculos batem.

## Ressalvas

- Os limiares em `THRESHOLDS` (`analyze.py`) são **heurísticos**. Calibre por
  vertical e ticket médio antes de tratar qualquer achado como veredito.
- Segmentos com pouco volume têm CPA instável por ruído estatístico. Confira o
  volume antes de cortar.
- As conversões seguem a **janela de atribuição da conta**. Divergência em
  relação ao backend é esperada, não bug.
- Métricas derivadas são recalculadas a partir dos números brutos, não lidas
  prontas da API — somar médias produz resultado errado na agregação.
