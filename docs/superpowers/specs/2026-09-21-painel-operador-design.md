# Painel do Operador — Design

**Data:** 2026-09-21
**Fatia:** B2 (primeira metade) — painel de operador
**Status:** aprovado em conversa, aguardando revisão do documento
**Depende de:** Fatia A (captura) e Fatia B1 (ingestão), ambas concluídas

---

## 1. Contexto

Há dado no banco e ninguém nunca olhou para ele a não ser por consulta SQL
rodada manualmente. Medido em 2026-09-21:

| | |
|---|---|
| Gasto | R$ 31.699,87 |
| Período | 2026-06-23 a 2026-09-19 |
| Anúncios | 839 |
| Linhas de insight | ~4 mil (grão base) + ~64 mil (recortes) |
| Leads capturados | 7, desde 2026-09-18 |
| Anúncios com custo por lead | **1** |

> **Os números acima são um retrato, não um contrato.** A sincronização roda
> 4x ao dia e a captura de leads é contínua — qualquer contagem exata aqui
> estará desatualizada em horas. O que não muda é a proporção: muito gasto
> histórico, pouquíssimo lead, porque a captura começou em 18/09.

Esta fatia entrega a primeira tela. O objetivo não é o produto que o
operador vende ao cliente — é o operador **enxergar o próprio dado**, e
validar visual e números antes que qualquer cliente veja.

## 2. Objetivo

Uma tela local que responda, sem SQL: **quanto foi gasto, em quais
anúncios, e quanto custou cada lead.**

## 3. Premissas — verificadas

| # | Premissa | Como foi verificada |
|---|---|---|
| P1 | O painel roda só na máquina do operador, sem deploy | Decisão do operador |
| P2 | Sem autenticação: quem alcança `localhost` é o operador | Consequência de P1 |
| P3 | Node 24 disponível | `node --version` |
| P4 | Um tenant, duas contas de anúncio, ambas `America/Belem` | Banco e Graph API |
| P5 | A esmagadora maioria dos anúncios não tem custo por lead | Consulta à view em 2026-09-21: 1 de 839 |

**Sobre P5:** não é defeito do cruzamento. A captura de leads entrou no ar
em 2026-09-18; o gasto tem 90 dias de histórico porque veio da Meta, mas
lead só existe a partir da data em que se passou a capturar. Nenhum
backfill resolve — a Meta não guarda quem mandou mensagem antes.

Isso tem consequência de interface, tratada na Seção 7.

## 4. Escopo

**Dentro:**
- Uma tela: números do período, gasto por dia, e tabela de criativos
- Seletor de período (7, 30, 90 dias)
- Botão de atualizar, acionando a sincronização manual já construída
- Carimbo de última atualização

**Fora:**
- Autenticação, deploy, e qualquer acesso que não seja `localhost`
- Painel do cliente com link por tenant — é a segunda metade da Fatia B2
- Recortes de demografia e posicionamento na tela (estão no banco, com
  64 mil linhas, mas exibi-los é decisão da Fatia D)
- Envio de conversões à Meta (Fatia C)
- Gráficos além do gasto por dia

## 5. Arquitetura

**Next.js com App Router e React Server Components.**

```
Navegador ──▶ Server Component ──▶ Supabase (service_role)
              roda no servidor      RLS contornado, de propósito
```

**Nenhuma consulta sai do navegador.** A chave de serviço vive no processo
do Next.js, lida de `.env.local`, e nunca entra no bundle.

Isso resolve três coisas de uma vez: sem autenticação (é a máquina do
operador), sem RLS (operador vê tudo, por definição), e sem risco de chave
vazada no cliente.

**Por que Next.js e não algo mais leve:** o caminho para a Vercel depois é
zero trabalho. Vite subiria mais rápido agora e viraria reescrita quando o
painel do cliente chegar.

**O que muda quando virar painel de cliente:** troca-se `service_role` por
um JWT com `tenant_id`, e o RLS que a Fatia A construiu volta a ser a
proteção. Telas e consultas seguem iguais.

## 6. A tela

Uma só. Resistir a espalhar é o que a faz ficar pronta.

```
┌─────────────────────────────────────────────────────────┐
│  TRACK MACHINE          [ 7d · 30d · 90d ]   ↻ 17:18    │
├─────────────────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │
│  │ GASTO   │ │ LEADS   │ │  CPL    │ │ ANÚNCIOS│        │
│  │R$ 31.699│ │    7    │ │ R$ 4,66 │ │   839   │        │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘        │
│                                                          │
│  ┌── Gasto por dia ─────────────────────────────────┐   │
│  │        ▁▂▅█▆▃▂▁▂▄██▅▃▁▂▃▅▇█▆▄▂                   │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ANÚNCIOS                        ordenar: gasto ▾       │
│  ─────────────────────────────────────────────────────  │
│  ad01              VAGA         R$ 18,64   4   R$ 4,66  │
│  AD06 - IMG        DIVULGAÇÃO   R$ 340,00  0      —     │
└─────────────────────────────────────────────────────────┘
```

Visual seguindo o design system fornecido pelo operador: fundo escuro, azul
como cor de destaque, cards densos, tabela de linhas discretas.

**O botão de atualizar** chama a sincronização manual da Fatia B1, que já
tem trava de 5 minutos por tenant. Quando a trava recusar, a tela mostra
quanto falta em vez de fingir que atualizou.

## 7. O problema do CPL ausente

Quase nenhum anúncio tem custo por lead (P5 — 1 de 839 na medição de
21/09). Uma tabela com centenas de traços na coluna mais importante parece
sistema quebrado.

**Duas decisões para isso não acontecer:**

**A coluna mostra o motivo, não um traço.** Anúncio sem lead no período
aparece com `0 leads` em cinza. "Este anúncio gastou R$ 340 e não trouxe
ninguém" é informação de alto valor — é justamente o que o operador precisa
ver — e não um buraco no dado.

**Um aviso no topo enquanto o histórico de leads for curto:** *"captura de
leads ativa desde 18/09 — custo por lead disponível a partir dessa data"*.
Ele desaparece sozinho quando houver 30 dias de lead acumulado.

### O CPL misturado, que é pior que o ausente

As duas decisões acima cobrem o CPL **ausente** na tabela. Elas não cobrem o
CPL **presente e errado** no card — e esse é o problema maior, porque um
buraco na tela se reconhece e um número plausível não.

Medido em 23/09/2026, com o card somando o período inteiro:

| | |
|---|---|
| gasto em 90 dias ÷ 29 leads | **R$ 1.084,80** |
| gasto desde 18/09 ÷ 29 leads | **R$ 11,16** |

Apenas **1,0%** do gasto é de quando já havia captura. O card errava por 97x,
e quem olhasse concluiria que as campanhas são um desastre.

**O numerador do CPL é o gasto da janela de captura, nunca o do período.**
E como isso faz o card discordar dos dois vizinhos — Gasto e Leads, que
mostram o período inteiro — **o card exibe a própria conta**: `R$ 323,86 ÷ 29
· desde 18/09`. Sem isso o operador refaz a divisão de cabeça, não fecha, e
passa a desconfiar dos três cartões. Quando o período pedido já começa depois
do início da captura, os dois gastos são o mesmo e a ressalva some.

**A âncora é um proxy, e isso precisa estar escrito.** O banco não registra o
dia em que a captura foi ligada; registra o primeiro lead. Se a captura
tivesse subido dias antes do primeiro lead chegar, o gasto desses dias ficaria
fora do numerador e o CPL sairia **otimista**. Hoje as duas datas coincidem
(18/09), então o proxy serve — no dia em que deixarem de coincidir, o viés
passa a existir sem nada na tela indicando.

Sem isso, o operador abre a tela, vê centenas de linhas sem CPL, e a primeira
hipótese é que o cruzamento quebrou — quando o que está acontecendo é que o
dado está começando.

## 8. Consultas

Três, todas em Server Component, todas sobre `desempenho_por_anuncio`.

```sql
-- Cards do topo
select
  sum(gasto_centavos)                         as gasto,
  sum(leads)                                  as leads,
  count(distinct ad_id)                       as anuncios,
  case when sum(leads) > 0
       then sum(gasto_centavos) / sum(leads)
  end                                         as cpl_medio
from desempenho_por_anuncio
where dia >= current_date - $1;

-- Gasto por dia
select dia, sum(gasto_centavos) as gasto
from desempenho_por_anuncio
where dia >= current_date - $1
group by dia order by dia;

-- Tabela
select ad_id, ad_name, campaign_name, destination_type,
       sum(gasto_centavos) as gasto,
       sum(leads)          as leads,
       case when sum(leads) > 0
            then sum(gasto_centavos) / sum(leads)
       end                 as cpl
from desempenho_por_anuncio
where dia >= current_date - $1
group by 1, 2, 3, 4
order by gasto desc;
```

**O CPL agregado é recalculado sobre os totais, nunca a média dos CPLs.**
Somar médias produz número errado — a mesma regra que vale desde o primeiro
dia do projeto.

### A tabela agrupa por nome de criativo, não por `ad_id`

A consulta acima devolve uma linha por `ad_id`. **A tela não mostra essas
linhas diretamente**: agrupa por `ad_name` antes de renderizar.

Medido na base, com os 840 anúncios do período já enriquecidos:

| chave | linhas | quantas ficam ambíguas |
|---|---|---|
| `ad_id` | 840 | nenhuma, mas o rótulo é ilegível |
| nome | 249 | 0 |
| nome + conta | — | 742 de 840 |
| nome + campanha + conjunto | — | 291 de 840 |

`AD03 - IMG - INFOR` aparece **17 vezes na mesma conta**, em campanhas e
conjuntos diferentes — é o mesmo criativo reusado, que é a prática normal
na Meta. Nenhuma combinação de rótulos legíveis separa os 840 anúncios: só
o `ad_id`, que não diz nada a um humano.

Agrupar por nome não esconde nada, porque a coluna **Vezes** mostra quantos
objetos de anúncio entraram em cada linha. E responde a pergunta que o
operador faz de verdade — *esse criativo funciona?* — em vez de *esse
objeto de anúncio funciona?*.

Duas regras do agrupamento que existem porque o contrário seria
silenciosamente errado:

- **Anúncio sem nome fica sozinho, na chave do próprio `ad_id`.** Anúncio
  novo aparece nos insights antes do enriquecimento rodar; agrupar os nulos
  juntos somaria gastos de anúncios sem relação nenhuma.
- **O grupo gera lead se qualquer membro gerar.** O mesmo criativo pode ter
  rodado numa campanha de mensagem e numa de visita ao perfil; esconder o
  número atrás de um traço apagaria lead que existe.

**`destination_type` decide qual métrica faz sentido por linha:** campanha
de mensagem mostra custo por lead; campanha de visita ao perfil não tem lead
e não deve exibir CPL nenhum.

## 9. Segurança

O painel é `localhost` sem autenticação. Isso é aceitável **porque não está
exposto** — e deixa de ser no instante em que alguém rodar `next dev -H
0.0.0.0` ou publicar.

Três guardas:

1. **A chave de serviço mora em `.env.local`**, que entra no `.gitignore`
   junto com os outros arquivos de segredo do projeto.
2. **Nenhuma consulta no cliente.** Server Components apenas; se algum dia
   uma consulta precisar ir para o navegador, ela exige JWT e RLS.
3. **Um aviso no README** dizendo que este painel não tem autenticação e
   não deve ser publicado como está.

## 10. Testes

Painel de leitura não pede a bateria do backend. Duas coisas merecem teste:

| Teste | Por quê |
|---|---|
| Formatação de dinheiro | `gasto_centavos` é inteiro; dividir errado na exibição é bug que só aparece na frente do cliente |
| CPL agregado bate com o SQL | Se o card divergir da tabela, ninguém confia em nenhum dos dois |
| Período filtra o que deve | Trocar 7d/30d/90d precisa mudar os três blocos juntos |

O resto é visual, e visual se confere olhando.

## 11. Riscos conhecidos

| Risco | Mitigação |
|---|---|
| Chave de serviço vazar no bundle | Server Components apenas; a chave nunca é referenciada em código de cliente |
| Painel publicado sem autenticação | Aviso no README; a segunda metade da Fatia B2 traz o JWT |
| Tabela com centenas de linhas ficar lenta | Agregação no banco, não no cliente; paginação entra se incomodar |
| Operador achar que o CPL vazio é bug | Aviso da Seção 7 |

## 12. Questões em aberto

| # | Questão | Decide quando |
|---|---|---|
| B2-Q1 | Exibir os recortes de demografia e posicionamento — 64 mil linhas no banco, nenhuma na tela | Fatia D, quando os insights definirem o que vale mostrar |
| B2-Q2 | Paginação ou busca na tabela de criativos | Se o volume incomodar na prática |
| B2-Q3 | Comparação com o período anterior nos cards | Quando houver 60 dias de lead acumulado; hoje não há o que comparar |

## 13. Critérios de conclusão

- `npm run dev` sobe o painel em `localhost:3000`
- Os quatro cards batem com a consulta SQL direta, rodada no mesmo instante
- A tabela lista os criativos do período, ordenados por gasto, sem duas linhas
  com o mesmo rótulo
- Anúncio sem lead aparece com `0 leads`, não com traço
- Trocar o período muda os três blocos juntos
- O botão de atualizar dispara a sincronização e mostra a trava quando ela recusar
- O aviso sobre o início da captura aparece
- A chave de serviço não aparece em nenhum arquivo do bundle do cliente
