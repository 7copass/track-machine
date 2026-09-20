# Ingestão de Métricas da Meta — Design

**Data:** 2026-09-20
**Fatia:** B1 — primeira metade da Fatia B
**Status:** aprovado em conversa, aguardando revisão do documento
**Depende de:** Fatia A (`2026-09-18-captura-atribuicao-design.md`), concluída

---

## 1. Contexto

A Fatia A entregou a captura: todo lead que chega por um anúncio
Click-to-WhatsApp vira uma linha em `ad_touchpoints`, com `ctwa_clid`,
`ad_id` e a campanha resolvida. Seis leads reais já estão no banco.

O que falta para isso virar produto é o outro lado da conta: **quanto
custou**. Sem o gasto, o painel diria "4 leads no anúncio ad01" — e a
pergunta seguinte do cliente, inevitável, é quanto aquilo custou. Um painel
que não responde isso é relatório de volume, que o Gerenciador de Anúncios
já dá de graça.

## 2. Objetivo

Trazer gasto, entrega e engajamento da Marketing API para o banco, no grão
certo e com atualização confiável, de modo que **custo por lead por anúncio
por dia** seja uma consulta simples.

## 3. Premissas — todas verificadas na conta real

| # | Premissa | Como foi verificada |
|---|---|---|
| P1 | Token de System User, não expira, com `ads_read` e `business_management` | `debug_token` em 2026-09-20 |
| P2 | Conta `act_269873128000933` (TET_PROF), ativa, BRL, fuso `America/Belem` | Graph API |
| P3 | **`destination_type` é o que separa mensagem de seguidores, não `objective`** | 84 campanhas e 200 conjuntos lidos da conta |
| P4 | 97% da conta é campanha de mensagem (191 de 200 conjuntos) | idem |
| P5 | A Meta reescreve dados passados por dias após o fato | comportamento conhecido da plataforma |

**Sobre P3 — corrige uma suposição que vinha sendo carregada.** Campanha de
mensagem e de seguidores aparecem *ambas* como `OUTCOME_ENGAGEMENT`.
Classificar pelo objetivo misturaria as duas no mesmo relatório. O que
separa é o `destination_type` do conjunto:

| `destination_type` | `optimization_goal` | Conjuntos | Métrica que faz sentido |
|---|---|---|---|
| `WHATSAPP` | `CONVERSATIONS` | 191 | Custo por lead |
| `MESSAGING_INSTAGRAM_DIRECT_WHATSAPP` | `CONVERSATIONS` | 2 | Custo por lead |
| `INSTAGRAM_PROFILE` | `PROFILE_VISIT` | 4 | Custo por visita ao perfil |
| `UNDEFINED` | `THRUPLAY` | 3 | Custo por ThruPlay |

## 4. Escopo

**Dentro:**
- Extração de insights no grão anúncio × dia, com recortes de posicionamento
  e demografia
- Cache em Postgres com upsert de janela móvel
- Sincronização recorrente 4x/dia, carga histórica de 90 dias, e atualização
  manual sob demanda
- Cruzamento com `ad_touchpoints` produzindo custo por lead
- Registro de execuções com carimbo de última atualização

**Fora (Fatia B2 e seguintes):**
- Qualquer interface — o painel é B2
- Autenticação do cliente no painel (Q2 da spec da Fatia A)
- Envio de conversões à Meta (Fatia C)
- Recomendações automáticas (Fatia D)
- Recortes de região, horário e dispositivo — o schema os aceita sem
  migração, mas não são coletados agora

## 5. Arquitetura

Uma restrição decide o desenho: **Edge Function tem limite de tempo de
execução.** A sincronização recorrente cabe folgado; a carga histórica de 90
dias, não.

```
RECORRENTE 4x/dia      pg_cron ──▶ Edge Function sync-meta-insights
  janela: 7 dias                     3 chamadas, segundos

BOTÃO ATUALIZAR        operador ─▶ mesma função, com trava de 5 min
  janela: 7 dias

CARGA HISTÓRICA        Deno CLI, rodado no onboarding do cliente
  janela: 90 dias                    sem limite de tempo, com retomada
```

Os três caminhos usam **os mesmos módulos**. Muda quem dispara e qual a
janela.

**Por que a carga histórica roda da máquina do operador:** o onboarding já é
manual — criar o App, pegar o token, conectar a conta. Um comando a mais
nesse roteiro é natural, e evita construir uma máquina de retomada em fatias
para uma operação que acontece uma vez por cliente.

**Sobre o scaffold Python existente** (`src/track_machine/`, 1.220 linhas):
não será reaproveitado. Manteria duas linguagens fazendo o mesmo trabalho e
obrigaria a lógica a existir duplicada — uma vez em Python para o backfill,
outra em TypeScript para a Edge Function. A lógica é portada para
TypeScript num módulo só, usado pelos três caminhos. O Python fica como
referência.

## 6. Modelo de dados

### 6.1 Grão base

```sql
create table meta_insights_diario (
  tenant_id       uuid not null references tenants(id) on delete cascade,
  ad_id           text not null,
  dia             date not null,

  gasto_centavos  bigint not null default 0,
  impressoes      bigint not null default 0,
  alcance         bigint not null default 0,
  cliques         bigint not null default 0,
  cliques_link    bigint not null default 0,

  -- Conversas iniciadas, visitas ao perfil, thruplay: cada objetivo tem a
  -- sua ação, e uma coluna por tipo viraria dezenas de colunas quase
  -- sempre nulas.
  --
  -- A Meta devolve `actions` como array de {action_type, value}; aqui vira
  -- objeto achatado, com o tipo como chave:
  --   {"onsite_conversion.messaging_conversation_started_7d": 12,
  --    "link_click": 340}
  -- Achatar na entrada permite consultar por `acoes->>'link_click'` em vez
  -- de varrer array a cada consulta do painel.
  acoes           jsonb not null default '{}'::jsonb,

  atualizado_em   timestamptz not null default now(),
  primary key (tenant_id, ad_id, dia)
);
```

### 6.2 Recortes

```sql
create table meta_insights_recorte (
  tenant_id       uuid not null references tenants(id) on delete cascade,
  ad_id           text not null,
  dia             date not null,
  tipo_recorte    text not null
                  check (tipo_recorte in ('posicionamento','demografia')),
  chave           jsonb not null,

  gasto_centavos  bigint not null default 0,
  impressoes      bigint not null default 0,
  alcance         bigint not null default 0,
  cliques         bigint not null default 0,
  acoes           jsonb not null default '{}'::jsonb,

  atualizado_em   timestamptz not null default now(),
  primary key (tenant_id, ad_id, dia, tipo_recorte, chave)
);

create index on meta_insights_recorte using gin (chave);
```

`chave` guarda `{"platform":"instagram","position":"story"}` ou
`{"idade":"25-34","genero":"female"}`.

**Por que jsonb e não colunas fixas.** Com `idade text, genero text,
plataforma text, posicao text`, cada recorte novo (região, horário,
dispositivo) seria migração e mudança de chave primária. Com jsonb,
acrescentar recorte é passar a gravar outra chave. O custo é consulta mais
verbosa, resolvido pelo índice GIN.

**Por que tabela separada do grão base.** Juntos, 97% das linhas seriam de
recorte, e a consulta mais frequente do painel — gasto por anúncio —
precisaria filtrar sobre a tabela grande.

### 6.3 Execuções

```sql
create table sync_runs (
  id              bigserial primary key,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  tipo            text not null
                  check (tipo in ('recorrente','manual','backfill')),
  janela_inicio   date not null,
  janela_fim      date not null,

  iniciado_em     timestamptz not null default now(),
  terminado_em    timestamptz,
  linhas_gravadas int not null default 0,

  status          text not null default 'rodando'
                  check (status in ('rodando','ok','falhou')),
  erro            text
);

create index on sync_runs (tenant_id, tipo, iniciado_em desc);
```

A tabela foi prometida na Seção 6.3 da spec da Fatia A e nunca chegou a ser
criada, porque nenhuma tarefa daquela fatia precisava dela. Nasce aqui.

**`sync_runs` não é log — é o carimbo.** É dela que sai o "atualizado às
14:32" da tela, e é ela que transforma "o painel está estranho" em "a
sincronização das 12h falhou por token expirado".

### 6.4 Colunas novas em tabelas existentes

```sql
alter table ad_metadata_cache
  add column destination_type  text,
  add column optimization_goal text;
```

É o que permite mostrar a métrica certa para cada tipo de campanha (P3).

```sql
alter table ad_accounts
  add column timezone text not null default 'America/Sao_Paulo';
```

Sem esta coluna o fuso ficaria chumbado na view, e a Seção 8 explica por que
isso produz CPL diário errado. É preenchida na criação da conta a partir do
`timezone_name` que a própria Graph API devolve — a TET_PROF é
`America/Belem`, que **não** é o padrão brasileiro mais comum. Usar um
default sem conferir seria justamente o erro que a Seção 8 descreve.

### 6.5 Regra de dinheiro

Valores monetários em **centavos, `bigint`** — mesma regra da Fatia A. A
Meta devolve string decimal; a conversão acontece na entrada, e nenhum
ponto flutuante entra no caminho.

## 7. Sincronização

```
1. Lê as contas do tenant          ad_accounts → token_ref → ambiente
2. Monta a janela                  recorrente/manual: hoje-7 … hoje
                                   backfill:          hoje-90 … hoje
3. Três chamadas por conta         base, posicionamento, demografia
4. Normaliza                       decimal → centavos, actions → jsonb
5. Upsert                          on conflict (chave) do update
6. Registra em sync_runs           carimbo, linhas, status
```

**O upsert é o que faz a janela móvel funcionar.** Como a Meta reescreve o
passado (P5), a mesma linha de um dia será gravada várias vezes ao longo de
uma semana, com valores diferentes. A chave primária composta garante
correção no lugar, não duplicação.

**A trava do botão vive no banco.** Antes de rodar manualmente, a função
consulta o último `sync_runs` de tipo `manual` daquela conta; se foi há
menos de 5 minutos, recusa e devolve quanto falta. Ficar no banco importa
porque Edge Function não tem memória entre invocações — uma trava em
variável seria zerada a cada chamada.

**Por que o botão é só do operador.** Rate limit da Meta é por app e por
conta. Se vários clientes clicarem repetidamente, a cota estoura e **as
sincronizações agendadas passam a falhar junto** — o botão que existia para
dar dado fresco impediria qualquer dado de chegar. O botão resolve um
problema do operador (ver o efeito de um ajuste que acabou de fazer), não do
cliente, para quem dado de 6 horas atrás leva à mesma decisão que dado de 6
minutos.

**A carga histórica retoma de onde parou.** Ela processa os 90 dias em
blocos de 7 e grava **uma linha de `sync_runs` por bloco**, não uma por
execução — é isso que dá o ponto de retomada. Rodar de novo pula os blocos
que já têm linha com `status = 'ok'`. Sem isso, falhar aos 80 dias custaria
refazer tudo.

Consequência para quem lê a tabela: um backfill de 90 dias produz ~13
linhas de tipo `backfill`, enquanto uma sincronização recorrente produz
uma. O carimbo de "atualizado às" da tela usa a mais recente de tipo
`recorrente` ou `manual`, ignorando as de `backfill`.

## 8. Cruzamento: custo por lead

> **A armadilha é o fuso horário.** A Meta reporta no fuso da conta —
> `America/Belem`, UTC−3. O `received_at` de `ad_touchpoints` está em UTC.
> Um lead que chegou às 22h de Belém é 01h UTC **do dia seguinte**.
>
> Agrupar leads por data UTC e cruzar com gasto por data de Belém joga todo
> lead entre 21h e meia-noite para o dia errado. O CPL diário fica errado e
> o mensal fecha certo — o que é pior, porque esconde o problema.

```sql
create view desempenho_por_anuncio
with (security_invoker = true)
as
select
  i.tenant_id, i.ad_id, i.dia,
  c.ad_name, c.campaign_name, c.adset_name, c.destination_type,
  i.gasto_centavos, i.impressoes, i.alcance, i.cliques_link,
  coalesce(l.leads, 0) as leads,
  case when coalesce(l.leads, 0) > 0
       then i.gasto_centavos / l.leads
  end as cpl_centavos
from meta_insights_diario i
  left join ad_metadata_cache c
    on c.ad_id = i.ad_id and c.tenant_id = i.tenant_id
  left join lateral (
    select count(*) as leads
      from ad_touchpoints t
      join ad_accounts a on a.tenant_id = t.tenant_id
     where t.tenant_id = i.tenant_id
       and t.ad_id     = i.ad_id
       and (t.received_at at time zone a.timezone)::date = i.dia
  ) l on true;
```

O `lateral` existe para que o fuso venha de `ad_accounts` por linha, em vez
de ser uma constante no corpo da view. Com um literal, cadastrar o primeiro
cliente de outro fuso exigiria recriar a view — e, pior, ninguém perceberia
até os números saírem errados.

**`cpl_centavos` é nulo quando não há lead, nunca infinito.** Anúncio que
gastou e não trouxe ninguém aparece como gasto registrado e zero leads —
informação, não erro.

**`left join` a partir do gasto**, porque anúncio com gasto e sem lead é
justamente o que o cliente precisa ver.

**O fuso sai de `ad_accounts.timezone`, não fica fixo no código.**
`America/Belem` é o da TET_PROF; outro cliente pode ter outro.

> Registrado para depois: o payload do Evolution traz
> `conversionDelaySeconds` — o intervalo entre o clique no anúncio e a
> mensagem (4 e 11 segundos nos payloads capturados). Permite reconstruir a
> hora do clique. Não é usado agora porque a diferença é de segundos e não
> muda o dia; fica anotado caso apareça caso de atraso longo.

## 9. Segurança e multi-tenancy

RLS habilitado nas três tabelas novas, com a mesma política das existentes:
`tenant_id = current_tenant_id()` para `authenticated`, nada para `anon`.
As Edge Functions usam `service_role`.

`security_invoker = true` na view é obrigatório. Sem ele a view roda com o
privilégio de quem a criou e devolve dado de todos os tenants, contornando o
RLS das tabelas por baixo. Na Fatia A isso foi verificado por mutação: com a
flag desligada, um tenant recebia a jornada inteira de outro.

Tokens continuam no ambiente das funções; as tabelas guardam só o nome da
variável.

## 10. Testes

| Teste | Cobre |
|---|---|
| Conversão decimal → centavos | `"1234.56"` vira `123456`, sem float no caminho |
| Normalização de `actions` | array aninhado vira jsonb consultável |
| **Upsert da janela móvel** | mesma linha gravada 2x com valores diferentes corrige, não duplica |
| **Fuso na virada do dia** | lead às 22h de Belém cai no dia certo |
| CPL sem lead | nulo, não infinito nem divisão por zero |
| CPL com lead | R$ 340 e 4 leads dá R$ 85,00 |
| Isolamento RLS nas 3 tabelas | verificado por mutação |
| `security_invoker` na view | verificado por mutação |
| Trava do botão | segunda chamada em menos de 5 min é recusada |
| Retomada do backfill | interromper e rodar de novo continua, não recomeça |
| Token expirado | registra falha em `sync_runs` com motivo, não fica silencioso |

**O teste de fuso é o mais importante.** É o erro que passa despercebido por
meses, porque o total do mês fecha certo.

Testes de banco seguem o formato do runner (`scripts/run_pgtap.py`) e as
cinco Restrições Globais já estabelecidas no plano da Fatia A — incluindo
que asserção só enxerga fixture se receber SQL como texto.

## 11. Riscos conhecidos

| Risco | Mitigação |
|---|---|
| Rate limit da Meta estourado | Botão manual só do operador, com trava de 5 min |
| Versão da Graph API sai de suporte | Versão é parâmetro, vinda do ambiente; falha registrada em `sync_runs` |
| Token revogado | Falha explícita em `sync_runs` com motivo, não silêncio |
| Volume de linhas cresce | ~28 mil/mês/cliente; revisar particionamento acima de ~5 milhões |
| Meta muda formato de resposta | Mapeamento centralizado num módulo, com teste |
| Fuso configurado errado no tenant | Sai de `ad_accounts`, preenchido na criação a partir da própria API |

## 12. Questões em aberto

| # | Questão | Decide quando |
|---|---|---|
| B1-Q1 | Recortes de região, horário e dispositivo — o schema aceita, mas coletar multiplica volume por ~7 | Quando a Fatia D definir quais insights valem |
| B1-Q2 | Reconciliação mensal de 28 dias para fechamento contábil, além da janela de 7 | Se o cliente exigir que o painel bata com a fatura da Meta |
| B1-Q3 | Contas com moeda diferente de BRL — o schema guarda centavos sem moeda | Ao cadastrar o primeiro cliente fora do Brasil |

## 13. Critérios de conclusão

- A carga histórica de 90 dias roda inteira para a conta TET_PROF e pode ser
  interrompida e retomada
- A sincronização recorrente roda 4x/dia e corrige valores já gravados
- `desempenho_por_anuncio` devolve custo por lead correto para os 6 leads já
  capturados, com o dia certo no fuso da conta
- Anúncio com gasto e sem lead aparece com CPL nulo, não infinito
- O botão manual recusa a segunda chamada dentro de 5 minutos
- A suíte passa, incluindo os testes de isolamento verificados por mutação
