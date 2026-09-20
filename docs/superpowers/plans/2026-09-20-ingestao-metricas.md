# Ingestão de Métricas da Meta — Plano de Implementação

> **Para executores agênticos:** SUB-SKILL OBRIGATÓRIA: use
> `superpowers:subagent-driven-development` (recomendado) ou
> `superpowers:executing-plans` para implementar tarefa a tarefa.
> Os passos usam checkbox (`- [ ]`) para acompanhamento.

**Objetivo:** Trazer gasto, entrega e engajamento da Marketing API para o
banco, de modo que **custo por lead por anúncio por dia** seja uma consulta
simples — cruzando com os touchpoints que a Fatia A já captura.

**Arquitetura:** Três caminhos usando os mesmos módulos — `pg_cron` chamando
uma Edge Function para a janela recorrente de 7 dias, um CLI Deno para a
carga histórica de 90 dias que não cabe no limite de execução da função, e
um botão manual restrito ao operador com trava de 5 minutos no banco.

**Stack:** Supabase (Postgres 17), Deno 2.5, TypeScript, pgTAP,
`scripts/run_pgtap.py`.

**Spec:** `docs/superpowers/specs/2026-09-20-ingestao-metricas-design.md`

## Restrições Globais

Herdadas da Fatia A e válidas aqui. Os requisitos de cada tarefa as incluem
implicitamente.

- **RLS habilitado em toda tabela com `tenant_id`.** Sem exceção.
- **`security_invoker = true` em toda view.** Sem isso a view roda com o
  privilégio de quem a criou e devolve dado de todos os tenants, contornando
  o RLS das tabelas por baixo.
- **Dinheiro sempre em centavos, tipo `bigint`.** Nunca `float`, `real` ou
  `double precision`. A Meta devolve string decimal; a conversão acontece na
  entrada.
- **Migrations nomeadas** `YYYYMMDDHHMMSS_descricao.sql`, com timestamp
  **maior que todas as já aplicadas** — a última é `20260918000900`.
- **Sem Docker nesta máquina.** Migrations vão ao projeto remoto com
  `supabase db push --linked --include-all --yes`; testes rodam com
  `python3 scripts/run_pgtap.py <arquivo>`.
- **Toda suíte pgTAP é UMA expressão** `select tap from (select 1 as ord,
  unnest(array[...]) ...)`, sem `begin`/`rollback`.
- **Asserção só enxerga fixture se receber SQL como texto.** `results_eq`,
  `is_empty`, `lives_ok` e `throws_ok` executam via `EXECUTE` e abrem
  consulta nova. `is()` e `ok()` com subconsulta inline leem o snapshot de
  **antes** das fixtures e devolvem resultado errado em silêncio.
- **O rollback do runner desfaz DDL também.** Use isso para verificar por
  mutação que uma asserção de isolamento tem dente: desligue o RLS dentro da
  própria suíte, veja o teste ficar vermelho, e o banco continua intacto.
- **Módulo em `_shared/` não lê o ambiente.** Quem lê é a função que roda na
  plataforma. É o que mantém os módulos testáveis sem permissão.
- **Falha nunca é silenciosa.** Todo caminho de erro registra o motivo, no
  padrão de `ultimaFalha` em `meta.ts` e `chatwoot.ts`.
- **Commits em português**, imperativo, explicando o porquê e não o quê.

## Estrutura de Arquivos

```
supabase/
  migrations/
    20260920000100_insights_schema.sql        3 tabelas, 2 alters, RLS
    20260920000200_desempenho_view.sql        a view do custo por lead
    20260920000300_agendamento_insights.sql   pg_cron 4x/dia
  functions/
    _shared/
      meta_insights.ts    busca insights na Graph API (3 recortes)
      insights_norm.ts    decimal→centavos, actions→jsonb
      insights_store.ts   upsert + sync_runs + trava do botão
    sync-meta-insights/
      index.ts            recorrente e manual
  tests/database/
    08_insights_schema.test.sql
    09_desempenho.test.sql       ← o teste de fuso mora aqui
scripts/
  backfill_insights.ts           CLI Deno, 90 dias com retomada
tests/
  unit/
    insights_norm_test.ts
    meta_insights_test.ts
    insights_store_test.ts
```

Os três módulos em `_shared/` separam **buscar**, **traduzir** e **gravar**.
É a mesma divisão que na Fatia A deixou `ad_reply.ts` e `phone.ts`
testáveis sem rede nem banco — e foi o que permitiu achar por teste os bugs
que os payloads reais depois confirmaram.

---

### Tarefa 1: Schema da ingestão

**Arquivos:**
- Criar: `supabase/migrations/20260920000100_insights_schema.sql`
- Teste: `supabase/tests/database/08_insights_schema.test.sql`

**Interfaces:**
- Consome: `tenants`, `ad_accounts`, `ad_metadata_cache`, `current_tenant_id()`
  (Fatia A).
- Produz: tabelas `meta_insights_diario`, `meta_insights_recorte`,
  `sync_runs`; colunas `ad_accounts.timezone`,
  `ad_metadata_cache.destination_type` e `.optimization_goal`.

- [ ] **Passo 1: Escrever o teste que falha**

Criar `supabase/tests/database/08_insights_schema.test.sql`:

```sql
-- Formato exigido pelo runner: a suite inteira e UMA consulta. Fixtures
-- entram por lives_ok, "set local" vira set_config dentro de diag(), e
-- finish() vem por union all com order by ord.
select tap from (
  select 1 as ord, unnest(array[
    extensions.plan(12),

    extensions.lives_ok(
      $$insert into tenants (id, nome, slug) values
          ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a'),
          ('22222222-2222-2222-2222-222222222222', 'Cliente B', 'cliente-b')$$,
      'fixtures: dois tenants'
    ),

    -- O fuso e por conta, nao chumbado. A TET_PROF e America/Belem, que
    -- NAO e o padrao brasileiro mais comum — usar default sem conferir
    -- produz o CPL diario errado que a spec descreve na secao 8.
    extensions.lives_ok(
      $$insert into ad_accounts (tenant_id, act_id, nome, timezone) values
          ('11111111-1111-1111-1111-111111111111', 'act_1', 'A', 'America/Belem'),
          ('22222222-2222-2222-2222-222222222222', 'act_2', 'B', 'America/Sao_Paulo')$$,
      'fixtures: cada conta com o proprio fuso'
    ),
    extensions.results_eq(
      $$select timezone from ad_accounts where act_id = 'act_1'$$,
      array['America/Belem'::text],
      'o fuso e guardado por conta'
    ),

    -- Grao base
    extensions.lives_ok(
      $$insert into meta_insights_diario
          (tenant_id, ad_id, dia, gasto_centavos, impressoes, acoes)
        values ('11111111-1111-1111-1111-111111111111', 'ad_1',
                '2026-09-18', 34000, 12000,
                '{"link_click": 340}'::jsonb)$$,
      'grava o grao base'
    ),

    -- A janela movel reescreve: a Meta corrige o passado por dias, entao
    -- a MESMA linha chega varias vezes com valores diferentes. Sem o
    -- upsert, cada sincronizacao duplicaria o gasto do mesmo dia.
    extensions.lives_ok(
      $$insert into meta_insights_diario
          (tenant_id, ad_id, dia, gasto_centavos, impressoes, acoes)
        values ('11111111-1111-1111-1111-111111111111', 'ad_1',
                '2026-09-18', 35500, 12400, '{"link_click": 351}'::jsonb)
        on conflict (tenant_id, ad_id, dia) do update
          set gasto_centavos = excluded.gasto_centavos,
              impressoes     = excluded.impressoes,
              acoes          = excluded.acoes,
              atualizado_em  = now()$$,
      'reescrita do mesmo dia nao estoura'
    ),
    extensions.results_eq(
      $$select gasto_centavos from meta_insights_diario
         where ad_id = 'ad_1' and dia = '2026-09-18'$$,
      array[35500::bigint],
      'a reescrita corrige no lugar, nao duplica'
    ),
    extensions.results_eq(
      $$select count(*)::int from meta_insights_diario where ad_id = 'ad_1'$$,
      array[1],
      'continua existindo uma linha so para aquele dia'
    ),

    -- Recorte: a chave e jsonb para aceitar recorte novo sem migracao
    extensions.lives_ok(
      $$insert into meta_insights_recorte
          (tenant_id, ad_id, dia, tipo_recorte, chave, gasto_centavos)
        values
          ('11111111-1111-1111-1111-111111111111', 'ad_1', '2026-09-18',
           'posicionamento',
           '{"platform":"instagram","position":"story"}'::jsonb, 12000),
          ('11111111-1111-1111-1111-111111111111', 'ad_1', '2026-09-18',
           'demografia',
           '{"idade":"25-34","genero":"female"}'::jsonb, 9000)$$,
      'grava recortes de tipos diferentes no mesmo dia'
    ),

    -- Isolamento
    extensions.diag(set_config('role', 'authenticated', true)),
    extensions.diag(set_config(
      'request.jwt.claims',
      '{"tenant_id":"22222222-2222-2222-2222-222222222222"}', true)),
    extensions.is_empty(
      $$select * from meta_insights_diario$$,
      'tenant B nao alcanca o insight do tenant A'
    ),
    extensions.is_empty(
      $$select * from meta_insights_recorte
         where chave->>'platform' = 'instagram'$$,
      'tenant B nao alcanca o recorte do tenant A nem filtrando por ele'
    ),

    -- As duas de cima provam que o tenant B e barrado. Sozinhas, elas
    -- passariam com a policy escrita como `using (false)`, com a policy
    -- ausente, ou com current_tenant_id() quebrado — e o sintoma em
    -- producao seria painel vazio, nao erro. As duas de baixo fecham a
    -- outra metade: o tenant A PRECISA ler o que e dele.
    extensions.diag(set_config(
      'request.jwt.claims',
      '{"tenant_id":"11111111-1111-1111-1111-111111111111"}', true)),
    extensions.results_eq(
      $$select gasto_centavos from meta_insights_diario$$,
      array[35500::bigint],
      'tenant A le o proprio insight'
    ),
    extensions.results_eq(
      $$select count(*)::int from meta_insights_recorte$$,
      array[2],
      'tenant A le os proprios recortes'
    )
  ]) as tap
  union all
  select 2, * from extensions.finish()
) t order by ord
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
python3 scripts/run_pgtap.py supabase/tests/database/08_insights_schema.test.sql
```

Esperado: FALHA com `column "timezone" of relation "ad_accounts" does not exist`.

- [ ] **Passo 3: Escrever a migration**

Criar `supabase/migrations/20260920000100_insights_schema.sql`:

```sql
-- Fuso por conta. Sem esta coluna ele ficaria chumbado na view de
-- desempenho, e a secao 8 da spec explica por que isso produz CPL diario
-- errado com fechamento mensal certo — que e pior, porque esconde.
alter table ad_accounts
  add column timezone text not null default 'America/Sao_Paulo';

-- Campanha de mensagem e de seguidores aparecem AMBAS como
-- OUTCOME_ENGAGEMENT. Quem separa e o destination_type do conjunto.
-- Verificado na conta real: 191 conjuntos WHATSAPP contra 4
-- INSTAGRAM_PROFILE, todos sob o mesmo objetivo.
alter table ad_metadata_cache
  add column destination_type  text,
  add column optimization_goal text;

create table meta_insights_diario (
  tenant_id       uuid not null references tenants(id) on delete cascade,
  ad_id           text not null,
  dia             date not null,

  gasto_centavos  bigint not null default 0,
  impressoes      bigint not null default 0,
  alcance         bigint not null default 0,
  cliques         bigint not null default 0,
  cliques_link    bigint not null default 0,

  -- A Meta devolve `actions` como array de {action_type, value}; aqui vira
  -- objeto achatado com o tipo como chave:
  --   {"onsite_conversion.messaging_conversation_started_7d": 12}
  -- Achatar na entrada permite consultar por acoes->>'x' em vez de varrer
  -- array a cada consulta do painel.
  acoes           jsonb not null default '{}'::jsonb,

  atualizado_em   timestamptz not null default now(),
  primary key (tenant_id, ad_id, dia)
);

create index on meta_insights_diario (tenant_id, dia desc);

create table meta_insights_recorte (
  tenant_id       uuid not null references tenants(id) on delete cascade,
  ad_id           text not null,
  dia             date not null,
  tipo_recorte    text not null
                  check (tipo_recorte in ('posicionamento','demografia')),

  -- jsonb e nao colunas fixas: com `idade text, genero text, plataforma
  -- text...`, cada recorte novo (regiao, horario, dispositivo) seria
  -- migration E mudanca de chave primaria. Assim e so passar a gravar
  -- outra chave.
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
create index on meta_insights_recorte (tenant_id, dia desc, tipo_recorte);

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

alter table meta_insights_diario  enable row level security;
alter table meta_insights_recorte enable row level security;
alter table sync_runs             enable row level security;

create policy tenant_le_os_proprios_insights on meta_insights_diario
  for select to authenticated
  using (tenant_id = current_tenant_id());

create policy tenant_le_os_proprios_recortes on meta_insights_recorte
  for select to authenticated
  using (tenant_id = current_tenant_id());

create policy tenant_le_as_proprias_execucoes on sync_runs
  for select to authenticated
  using (tenant_id = current_tenant_id());
```

- [ ] **Passo 4: Aplicar e confirmar que passa**

```bash
set -a && . ./.env && set +a
supabase db push --linked --include-all --yes
python3 scripts/run_pgtap.py supabase/tests/database/08_insights_schema.test.sql
```

Esperado: 12 asserções passando.

- [ ] **Passo 5: Verificar por mutação que o isolamento tem dente**

Copie a suíte para o scratchpad, acrescente
`alter table meta_insights_diario disable row level security;` logo após as
fixtures, e rode. As duas asserções de isolamento devem ficar `not ok`. O
rollback por exceção do runner desfaz o DDL, então o banco não muda.

Se elas continuarem verdes com o RLS desligado, o teste não prova nada e
precisa ser reescrito.

**Faça também a mutação oposta:** troque as duas policies por
`using (false)` e confirme que as asserções `tenant A le o proprio insight`
e `tenant A le os proprios recortes` ficam vermelhas.

Provar só que o tenant B é barrado não basta: uma policy fechada demais
passaria nesse teste e apareceria em produção como painel vazio — que o
cliente relata como "o sistema não está funcionando", não como erro.

- [ ] **Passo 6: Commit**

```bash
git add supabase/
git commit -m "Schema da ingestao de metricas da Meta

O fuso vira coluna de ad_accounts em vez de constante: a conta real e
America/Belem, que nao e o padrao brasileiro mais comum, e um default
sem conferir produziria CPL diario errado com fechamento mensal certo
— pior que errar os dois, porque esconde.

destination_type entra em ad_metadata_cache porque campanha de
mensagem e de seguidores aparecem ambas como OUTCOME_ENGAGEMENT.
Classificar pelo objetivo misturaria as duas no mesmo relatorio.

A chave do recorte e jsonb para que recorte novo seja so outra chave
gravada, nao migration com mudanca de chave primaria."
```

---

### Tarefa 2: View de desempenho e a armadilha do fuso

**Arquivos:**
- Criar: `supabase/migrations/20260920000200_desempenho_view.sql`
- Teste: `supabase/tests/database/09_desempenho.test.sql`

**Interfaces:**
- Consome: `meta_insights_diario`, `ad_metadata_cache`, `ad_accounts.timezone`
  (Tarefa 1); `ad_touchpoints` (Fatia A).
- Produz: view `desempenho_por_anuncio` com colunas `tenant_id`, `ad_id`,
  `dia`, `ad_name`, `campaign_name`, `adset_name`, `destination_type`,
  `gasto_centavos`, `impressoes`, `alcance`, `cliques_link`, `leads`,
  `cpl_centavos`.

**Esta é a tarefa mais importante do plano.** O erro que ela previne passa
despercebido por meses porque o total do mês fecha certo.

- [ ] **Passo 1: Escrever o teste que falha**

Criar `supabase/tests/database/09_desempenho.test.sql`:

```sql
-- Formato exigido pelo runner: a suite inteira e UMA consulta.
select tap from (
  select 1 as ord, unnest(array[
    extensions.plan(11),

    extensions.lives_ok(
      $$insert into tenants (id, nome, slug) values
          ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a')$$,
      'fixtures: um tenant'
    ),
    extensions.lives_ok(
      $$insert into ad_accounts (tenant_id, act_id, nome, timezone)
        values ('11111111-1111-1111-1111-111111111111', 'act_1', 'A',
                'America/Belem')$$,
      'fixtures: conta em America/Belem (UTC-3)'
    ),
    extensions.lives_ok(
      $$insert into ad_metadata_cache
          (tenant_id, ad_id, ad_name, adset_name, campaign_name,
           destination_type, act_id)
        values ('11111111-1111-1111-1111-111111111111', 'ad_1', 'Criativo A',
                'CJ01', 'VAGA', 'WHATSAPP', 'act_1'),
               ('11111111-1111-1111-1111-111111111111', 'ad_zero', 'Criativo Z',
                'CJ02', 'VAGA', 'WHATSAPP', 'act_1')$$,
      'fixtures: dois anuncios com nome'
    ),
    extensions.lives_ok(
      $$insert into meta_insights_diario
          (tenant_id, ad_id, dia, gasto_centavos)
        values ('11111111-1111-1111-1111-111111111111', 'ad_1',
                '2026-09-18', 34000),
               ('11111111-1111-1111-1111-111111111111', 'ad_zero',
                '2026-09-18', 15000)$$,
      'fixtures: gasto em dois anuncios'
    ),

    -- A ARMADILHA: 2026-09-19 00:30 UTC e 2026-09-18 21:30 em Belem.
    -- Agrupado por data UTC este lead cairia em 19/09 e o CPL dos DOIS
    -- dias sairia errado — com o total do mes fechando certo, que e o que
    -- faz o erro sobreviver meses sem ninguem notar.
    extensions.lives_ok(
      $$insert into ad_touchpoints
          (tenant_id, wa_message_id, phone_e164, phone_match_key,
           ad_id, source_channel, received_at, raw_payload)
        values
          ('11111111-1111-1111-1111-111111111111', 'M1', '+5593900000001',
           '559390000001', 'ad_1', 'evolution',
           '2026-09-18 14:00:00+00', '{}'::jsonb),
          ('11111111-1111-1111-1111-111111111111', 'M2', '+5593900000002',
           '559390000002', 'ad_1', 'evolution',
           '2026-09-18 18:00:00+00', '{}'::jsonb),
          ('11111111-1111-1111-1111-111111111111', 'M3', '+5593900000003',
           '559390000003', 'ad_1', 'evolution',
           '2026-09-18 22:00:00+00', '{}'::jsonb),
          ('11111111-1111-1111-1111-111111111111', 'M4', '+5593900000004',
           '559390000004', 'ad_1', 'evolution',
           '2026-09-19 00:30:00+00', '{}'::jsonb)$$,
      'fixtures: quatro leads, um deles depois da meia-noite UTC'
    ),

    extensions.results_eq(
      $$select leads from desempenho_por_anuncio
         where ad_id = 'ad_1' and dia = '2026-09-18'$$,
      array[4::bigint],
      'o lead de 00:30 UTC conta no dia 18, que e o dia dele em Belem'
    ),
    extensions.results_eq(
      $$select cpl_centavos from desempenho_por_anuncio
         where ad_id = 'ad_1' and dia = '2026-09-18'$$,
      array[8500::bigint],
      'CPL: R$ 340,00 divididos por 4 leads dao R$ 85,00'
    ),

    -- Anuncio que gastou e nao trouxe ninguem PRECISA aparecer: e
    -- justamente o que o cliente deve olhar. E o CPL vem nulo, nao
    -- infinito nem erro de divisao.
    extensions.results_eq(
      $$select coalesce(leads, -1) from desempenho_por_anuncio
         where ad_id = 'ad_zero'$$,
      array[0::bigint],
      'anuncio sem lead aparece com zero, nao some da lista'
    ),
    extensions.results_eq(
      $$select cpl_centavos from desempenho_por_anuncio
         where ad_id = 'ad_zero'$$,
      array[null::bigint],
      'CPL sem lead e nulo, nunca infinito'
    ),

    -- Varias contas por cliente e o caso que o operador descreveu desde o
    -- inicio. Sem resolver o fuso pela conta DO ANUNCIO, cada lead seria
    -- contado uma vez por conta do tenant e o CPL cairia pela metade.
    extensions.lives_ok(
      $$insert into ad_accounts (tenant_id, act_id, nome, timezone)
        values ('11111111-1111-1111-1111-111111111111', 'act_2', 'Segunda',
                'America/Sao_Paulo')$$,
      'fixture: uma segunda conta no mesmo tenant'
    ),
    extensions.results_eq(
      $$select leads from desempenho_por_anuncio
         where ad_id = 'ad_1' and dia = '2026-09-18'$$,
      array[4::bigint],
      'a segunda conta do tenant nao duplica a contagem de leads'
    )
  ]) as tap
  union all
  select 2, * from extensions.finish()
) t order by ord
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
python3 scripts/run_pgtap.py supabase/tests/database/09_desempenho.test.sql
```

Esperado: FALHA com `relation "desempenho_por_anuncio" does not exist`.

- [ ] **Passo 3: Escrever a migration**

Criar `supabase/migrations/20260920000200_desempenho_view.sql`:

```sql
-- O anuncio precisa saber de qual conta ele veio.
--
-- Sem isso, a view resolveria o fuso juntando ad_touchpoints com
-- ad_accounts apenas por tenant — e um tenant com DUAS contas de anuncio
-- contaria cada lead duas vezes, cortando o CPL pela metade. Verificado
-- por teste: um lead, duas contas, count devolve 2.
--
-- Varias contas por cliente nao e hipotese: e o caso que o operador
-- descreveu desde o inicio.
alter table ad_metadata_cache
  add column act_id text;

/**
 * Custo por lead por anuncio por dia.
 *
 * O fuso vem da CONTA DO ANUNCIO, resolvida por ad_metadata_cache.act_id,
 * e nao de "alguma conta do tenant".
 *
 * A Meta reporta no fuso da conta e received_at esta em UTC: um lead das
 * 22h em Belem e 01h UTC do dia seguinte. Agrupar por data UTC joga todo
 * lead entre 21h e meia-noite para o dia errado — o CPL diario sai errado
 * e o mensal fecha certo, que e pior porque esconde o problema.
 *
 * O coalesce cobre o anuncio que ainda nao foi enriquecido quando o gasto
 * chegou: mantem a linha visivel em vez de some-la, e o enriquecimento
 * corrige no ciclo seguinte.
 */
create view desempenho_por_anuncio
with (security_invoker = true)
as
select
  i.tenant_id,
  i.ad_id,
  i.dia,
  c.ad_name,
  c.campaign_name,
  c.adset_name,
  c.destination_type,
  i.gasto_centavos,
  i.impressoes,
  i.alcance,
  i.cliques_link,
  l.leads,
  case when l.leads > 0
       then i.gasto_centavos / l.leads
  end as cpl_centavos
from meta_insights_diario i
  left join ad_metadata_cache c
    on  c.ad_id     = i.ad_id
    and c.tenant_id = i.tenant_id
  left join ad_accounts a
    on  a.tenant_id = i.tenant_id
    and a.act_id    = c.act_id
  left join lateral (
    select count(*) as leads
      from ad_touchpoints t
     where t.tenant_id = i.tenant_id
       and t.ad_id     = i.ad_id
       and (t.received_at
            at time zone coalesce(a.timezone, 'America/Sao_Paulo'))::date = i.dia
  ) l on true;
```

- [ ] **Passo 4: Aplicar e confirmar que passa**

```bash
set -a && . ./.env && set +a
supabase db push --linked --include-all --yes
python3 scripts/run_pgtap.py supabase/tests/database/09_desempenho.test.sql
```

Esperado: 11 asserções passando.

- [ ] **Passo 5: Verificar por mutação que o teste de fuso tem dente**

Copie a suíte para o scratchpad e troque, na definição da view, o
`a.timezone` por `'UTC'`. A asserção `o lead de 00:30 UTC conta no dia 18`
deve ficar `not ok`, mostrando 3 em vez de 4.

Faça o mesmo com `security_invoker = false` e confirme que o isolamento
quebra. Com o rollback do runner, nenhuma das duas mutações toca o banco.

- [ ] **Passo 6: Conferir contra os leads reais já capturados**

```bash
set -a && . ./.env && set +a
python3 -c "
import sys; sys.path.insert(0,'scripts')
from run_pgtap import carregar_env, executar
carregar_env()
ok, r = executar('''select ad_id, dia, leads, gasto_centavos, cpl_centavos
  from desempenho_por_anuncio order by dia desc limit 10''')
for x in (r or []): print(x)
"
```

A conta tem 6 leads reais capturados. Eles ainda não terão gasto associado
(a ingestão é a Tarefa 5), então a view devolverá zero linhas — a view parte
do gasto. Isso é o comportamento correto, não uma falha: confirme que não
estoura e siga.

- [ ] **Passo 7: Commit**

```bash
git add supabase/
git commit -m "View de custo por lead, com o fuso vindo da conta

A Meta reporta no fuso da conta e received_at esta em UTC. Um lead das
22h em Belem e 01h UTC do dia seguinte: agrupado por data UTC ele cai
no dia errado, o CPL diario sai errado e o mensal fecha certo — que e
pior, porque o erro sobrevive meses sem ninguem notar.

O fuso vem por lateral de ad_accounts, nao como literal: com literal,
o primeiro cliente de outro fuso exigiria recriar a view, e ninguem
perceberia ate os numeros sairem errados.

CPL e nulo quando nao ha lead, nunca infinito, e o join parte do gasto
para que anuncio que gastou sem trazer ninguem apareca — e justamente
o que o cliente precisa ver."
```

---

### Tarefa 3: Normalização dos valores da Meta

**Arquivos:**
- Criar: `supabase/functions/_shared/insights_norm.ts`
- Teste: `tests/unit/insights_norm_test.ts`

**Interfaces:**
- Consome: nada. Módulo puro, sem I/O.
- Produz: `paraCentavos(valor: unknown): number`,
  `acoesParaObjeto(raw: unknown): Record<string, number>`,
  `type LinhaInsight = { ad_id: string; dia: string; gasto_centavos: number;
  impressoes: number; alcance: number; cliques: number; cliques_link: number;
  acoes: Record<string, number> }`,
  `normalizarLinha(bruto: Record<string, unknown>): LinhaInsight | null`.

- [ ] **Passo 1: Escrever os testes que falham**

Criar `tests/unit/insights_norm_test.ts`:

```typescript
import { assertEquals } from "jsr:@std/assert";
import {
  acoesParaObjeto,
  normalizarLinha,
  paraCentavos,
} from "../../supabase/functions/_shared/insights_norm.ts";

// ─── Dinheiro: nunca float ──────────────────────────────────────

Deno.test("converte decimal em string para centavos", () => {
  // A Meta devolve gasto como string decimal: "1234.56"
  assertEquals(paraCentavos("1234.56"), 123456);
  assertEquals(paraCentavos("0.01"), 1);
  assertEquals(paraCentavos("340"), 34000);
});

Deno.test("nao perde centavo por erro de ponto flutuante", () => {
  // 0.1 + 0.2 nao da 0.3 em float. Multiplicar por 100 e arredondar
  // parece seguro mas erra: 19.99 * 100 vira 1998.9999999999998.
  assertEquals(paraCentavos("19.99"), 1999);
  assertEquals(paraCentavos("0.29"), 29);
  assertEquals(paraCentavos("8.20"), 820);
});

Deno.test("aceita numero alem de string", () => {
  assertEquals(paraCentavos(1234.56), 123456);
});

Deno.test("devolve zero para ausente ou invalido", () => {
  assertEquals(paraCentavos(null), 0);
  assertEquals(paraCentavos(undefined), 0);
  assertEquals(paraCentavos(""), 0);
  assertEquals(paraCentavos("nao e numero"), 0);
});

// ─── Ações: array aninhado vira objeto achatado ─────────────────

Deno.test("achata o array de actions em objeto", () => {
  const raw = [
    { action_type: "link_click", value: "340" },
    { action_type: "onsite_conversion.messaging_conversation_started_7d",
      value: "12" },
  ];
  assertEquals(acoesParaObjeto(raw), {
    link_click: 340,
    "onsite_conversion.messaging_conversation_started_7d": 12,
  });
});

Deno.test("devolve objeto vazio quando nao ha actions", () => {
  assertEquals(acoesParaObjeto(undefined), {});
  assertEquals(acoesParaObjeto([]), {});
  assertEquals(acoesParaObjeto("nao e array"), {});
});

Deno.test("ignora entrada malformada sem descartar as boas", () => {
  const raw = [
    { action_type: "link_click", value: "340" },
    { sem_tipo: true },
    { action_type: "video_view", value: "nao numero" },
  ];
  assertEquals(acoesParaObjeto(raw), { link_click: 340 });
});

// ─── Linha completa ─────────────────────────────────────────────

Deno.test("normaliza uma linha de insight da Meta", () => {
  const bruto = {
    ad_id: "120247603194380108",
    date_start: "2026-09-18",
    date_stop: "2026-09-18",
    spend: "340.00",
    impressions: "12000",
    reach: "8400",
    clicks: "512",
    inline_link_clicks: "340",
    actions: [{ action_type: "link_click", value: "340" }],
  };
  assertEquals(normalizarLinha(bruto), {
    ad_id: "120247603194380108",
    dia: "2026-09-18",
    gasto_centavos: 34000,
    impressoes: 12000,
    alcance: 8400,
    cliques: 512,
    cliques_link: 340,
    acoes: { link_click: 340 },
  });
});

Deno.test("devolve null sem ad_id ou sem data", () => {
  // Sem os dois nao ha chave primaria possivel. Devolver null em vez de
  // gravar linha incompleta evita lixo que so aparece na consulta.
  assertEquals(normalizarLinha({ spend: "10" }), null);
  assertEquals(normalizarLinha({ ad_id: "1" }), null);
  assertEquals(normalizarLinha({ date_start: "2026-09-18" }), null);
});

Deno.test("preenche com zero o que a Meta omite", () => {
  // Anuncio sem clique nenhum vem sem o campo, nao com zero.
  const r = normalizarLinha({
    ad_id: "1", date_start: "2026-09-18", spend: "10.00",
  });
  assertEquals(r!.cliques, 0);
  assertEquals(r!.alcance, 0);
  assertEquals(r!.acoes, {});
});
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
deno test tests/unit/insights_norm_test.ts
```

Esperado: FALHA com `Cannot find module`.

- [ ] **Passo 3: Implementar**

Criar `supabase/functions/_shared/insights_norm.ts`:

```typescript
/**
 * Tradução dos valores da Marketing API para o formato do banco.
 *
 * Módulo puro: sem rede, sem banco, sem ambiente. É o que permite testar
 * todas as armadilhas de formato sem subir nada.
 */

export type LinhaInsight = {
  ad_id: string;
  dia: string;
  gasto_centavos: number;
  impressoes: number;
  alcance: number;
  cliques: number;
  cliques_link: number;
  acoes: Record<string, number>;
};

/**
 * Converte o valor monetário da Meta para centavos inteiros.
 *
 * A conversão é feita sobre a string, não multiplicando o float por 100:
 * `19.99 * 100` em ponto flutuante dá `1998.9999999999998`, e arredondar
 * isso funciona na maioria dos casos e erra em alguns — o pior tipo de bug
 * em número que o cliente confere.
 */
export function paraCentavos(valor: unknown): number {
  if (valor === null || valor === undefined) return 0;

  const texto = String(valor).trim();
  if (!/^-?\d+(\.\d+)?$/.test(texto)) return 0;

  const [inteira, decimal = ""] = texto.split(".");
  const centavos = (decimal + "00").slice(0, 2);
  const sinal = inteira.startsWith("-") ? -1 : 1;

  return sinal * (Math.abs(parseInt(inteira, 10)) * 100 + parseInt(centavos, 10));
}

function paraInteiro(valor: unknown): number {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Achata o array `actions` da Meta em objeto com o tipo como chave.
 *
 * Guardar o array cru obrigaria toda consulta do painel a varrê-lo; como
 * objeto, `acoes->>'link_click'` resolve com índice.
 */
export function acoesParaObjeto(raw: unknown): Record<string, number> {
  if (!Array.isArray(raw)) return {};

  const saida: Record<string, number> = {};
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const tipo = (item as Record<string, unknown>)["action_type"];
    const valor = Number((item as Record<string, unknown>)["value"]);
    if (typeof tipo !== "string" || !Number.isFinite(valor)) continue;
    saida[tipo] = valor;
  }
  return saida;
}

/** Traduz uma linha da API, ou `null` se ela não tiver chave possível. */
export function normalizarLinha(
  bruto: Record<string, unknown>,
): LinhaInsight | null {
  const adId = bruto["ad_id"];
  const dia = bruto["date_start"];

  // Sem os dois não há chave primária. Gravar linha incompleta produziria
  // lixo que só aparece muito depois, na consulta do painel.
  if (typeof adId !== "string" || typeof dia !== "string") return null;

  return {
    ad_id: adId,
    dia,
    gasto_centavos: paraCentavos(bruto["spend"]),
    impressoes: paraInteiro(bruto["impressions"]),
    alcance: paraInteiro(bruto["reach"]),
    cliques: paraInteiro(bruto["clicks"]),
    cliques_link: paraInteiro(bruto["inline_link_clicks"]),
    acoes: acoesParaObjeto(bruto["actions"]),
  };
}
```

- [ ] **Passo 4: Rodar e confirmar que passa**

```bash
deno test tests/unit/insights_norm_test.ts
```

Esperado: 10 testes passando.

- [ ] **Passo 5: Commit**

```bash
git add supabase/functions/_shared/insights_norm.ts tests/unit/insights_norm_test.ts
git commit -m "Normaliza valores da Meta sem passar por ponto flutuante

A conversao para centavos e feita sobre a string, nao multiplicando o
float por 100: 19.99 * 100 em ponto flutuante da 1998.9999999999998, e
arredondar isso acerta na maioria dos casos e erra em alguns — o pior
tipo de bug em numero que o cliente confere contra a fatura.

O array de actions vira objeto achatado porque guardar o array cru
obrigaria toda consulta do painel a varre-lo.

Linha sem ad_id ou sem data devolve null em vez de ser gravada: sem os
dois nao ha chave primaria, e linha incompleta viraria lixo que so
aparece muito depois."
```

---

### Tarefa 4: Cliente de insights da Graph API

**Arquivos:**
- Criar: `supabase/functions/_shared/meta_insights.ts`
- Teste: `tests/unit/meta_insights_test.ts`

**Interfaces:**
- Consome: `LinhaInsight`, `normalizarLinha`, `paraCentavos`,
  `acoesParaObjeto` (Tarefa 3).
- Produz: `type Recorte = "base" | "posicionamento" | "demografia"`,
  `type LinhaRecorte = { ad_id: string; dia: string; chave:
  Record<string, string>; gasto_centavos: number; impressoes: number;
  alcance: number; cliques: number; acoes: Record<string, number> }`,
  `buscarInsights(opts: { token: string; actId: string; desde: string;
  ate: string; recorte: Recorte; versao?: string }):
  Promise<{ base: LinhaInsight[]; recortes: LinhaRecorte[] } | null>`,
  `ultimaFalha: FalhaInsights`.

- [ ] **Passo 1: Escrever os testes que falham**

Criar `tests/unit/meta_insights_test.ts`:

```typescript
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import {
  buscarInsights,
  ultimaFalha,
} from "../../supabase/functions/_shared/meta_insights.ts";

function mockFetch(resposta: unknown, status = 200) {
  const original = globalThis.fetch;
  const chamadas: string[] = [];
  globalThis.fetch = ((url: string | URL | Request) => {
    chamadas.push(String(url));
    return Promise.resolve(
      new Response(JSON.stringify(resposta), {
        status, headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { chamadas, restaurar: () => { globalThis.fetch = original; } };
}

const OPTS = {
  token: "tok", actId: "act_1",
  desde: "2026-09-14", ate: "2026-09-20",
};

Deno.test("traz o grao base normalizado", async () => {
  const m = mockFetch({
    data: [{
      ad_id: "1", date_start: "2026-09-18", spend: "340.00",
      impressions: "12000", inline_link_clicks: "340",
    }],
  });
  try {
    const r = await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(r!.base.length, 1);
    assertEquals(r!.base[0].gasto_centavos, 34000);
    assertEquals(r!.recortes.length, 0);
  } finally { m.restaurar(); }
});

Deno.test("monta a chave do recorte de posicionamento", async () => {
  const m = mockFetch({
    data: [{
      ad_id: "1", date_start: "2026-09-18", spend: "120.00",
      publisher_platform: "instagram", platform_position: "story",
    }],
  });
  try {
    const r = await buscarInsights({ ...OPTS, recorte: "posicionamento" });
    assertEquals(r!.recortes[0].chave,
      { platform: "instagram", position: "story" });
    assertEquals(r!.recortes[0].gasto_centavos, 12000);
  } finally { m.restaurar(); }
});

Deno.test("monta a chave do recorte de demografia", async () => {
  const m = mockFetch({
    data: [{
      ad_id: "1", date_start: "2026-09-18", spend: "90.00",
      age: "25-34", gender: "female",
    }],
  });
  try {
    const r = await buscarInsights({ ...OPTS, recorte: "demografia" });
    assertEquals(r!.recortes[0].chave, { idade: "25-34", genero: "female" });
  } finally { m.restaurar(); }
});

Deno.test("pede time_increment=1 para vir dia a dia", async () => {
  // Sem isso a Meta devolve o periodo agregado numa linha so, e o grao
  // diario — que e o da chave primaria — se perde.
  const m = mockFetch({ data: [] });
  try {
    await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(m.chamadas[0].includes("time_increment=1"), true);
  } finally { m.restaurar(); }
});

Deno.test("segue a paginacao ate o fim", async () => {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (() => {
    n++;
    const corpo = n === 1
      ? { data: [{ ad_id: "1", date_start: "2026-09-18", spend: "10" }],
          paging: { next: "https://graph.facebook.com/proxima" } }
      : { data: [{ ad_id: "2", date_start: "2026-09-18", spend: "20" }] };
    return Promise.resolve(new Response(JSON.stringify(corpo), { status: 200 }));
  }) as typeof fetch;
  try {
    const r = await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(r!.base.length, 2);
  } finally { globalThis.fetch = original; }
});

Deno.test("devolve null e registra o motivo quando o token expira", async () => {
  // Token revogado para de trazer dado para TODAS as contas, nao so uma.
  // Sem registrar o motivo, o sintoma e igual ao de "nao havia nada".
  const m = mockFetch({ error: { code: 190, message: "expirado" } }, 401);
  try {
    assertEquals(await buscarInsights({ ...OPTS, recorte: "base" }), null);
    const mod = await import(
      "../../supabase/functions/_shared/meta_insights.ts"
    );
    assertEquals(mod.ultimaFalha, "erro_api");
  } finally { m.restaurar(); }
});

Deno.test("registra falha de rede", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(new TypeError("conexao recusada"))) as typeof fetch;
  try {
    assertEquals(await buscarInsights({ ...OPTS, recorte: "base" }), null);
    const mod = await import(
      "../../supabase/functions/_shared/meta_insights.ts"
    );
    assertEquals(mod.ultimaFalha, "rede");
  } finally { globalThis.fetch = original; }
});

Deno.test("sucesso limpa a falha anterior", async () => {
  // Falha velha colada faria o alerta disparar para sempre depois que a
  // Meta voltasse.
  const m = mockFetch({ data: [] });
  try {
    await buscarInsights({ ...OPTS, recorte: "base" });
    const mod = await import(
      "../../supabase/functions/_shared/meta_insights.ts"
    );
    assertEquals(mod.ultimaFalha, null);
  } finally { m.restaurar(); }
});
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
deno test --allow-net tests/unit/meta_insights_test.ts
```

Esperado: FALHA com `Cannot find module`.

- [ ] **Passo 3: Implementar**

Criar `supabase/functions/_shared/meta_insights.ts`:

```typescript
/**
 * Busca de insights na Marketing API.
 *
 * Três recortes, três chamadas: o grão base (anúncio × dia), posicionamento
 * e demografia. A API não combina recortes arbitrários numa chamada só.
 *
 * Este módulo não lê o ambiente — a versão da API chega por parâmetro. É o
 * que o mantém testável sem permissão, como `phone.ts` e `ad_reply.ts`.
 */

import {
  acoesParaObjeto,
  type LinhaInsight,
  normalizarLinha,
  paraCentavos,
} from "./insights_norm.ts";

const VERSAO_PADRAO = "v21.0";
const MAX_PAGINAS = 100;

export type Recorte = "base" | "posicionamento" | "demografia";

export type LinhaRecorte = {
  ad_id: string;
  dia: string;
  chave: Record<string, string>;
  gasto_centavos: number;
  impressoes: number;
  alcance: number;
  cliques: number;
  acoes: Record<string, number>;
};

export type FalhaInsights = "http" | "erro_api" | "rede" | null;
export let ultimaFalha: FalhaInsights = null;

const CAMPOS_BASE = [
  "ad_id", "date_start", "spend", "impressions", "reach",
  "clicks", "inline_link_clicks", "actions",
].join(",");

const CAMPOS_RECORTE = [
  "ad_id", "date_start", "spend", "impressions", "reach", "clicks", "actions",
].join(",");

const BREAKDOWNS: Record<Recorte, string | null> = {
  base: null,
  posicionamento: "publisher_platform,platform_position",
  demografia: "age,gender",
};

function chaveDoRecorte(
  recorte: Recorte, bruto: Record<string, unknown>,
): Record<string, string> {
  if (recorte === "posicionamento") {
    return {
      platform: String(bruto["publisher_platform"] ?? ""),
      position: String(bruto["platform_position"] ?? ""),
    };
  }
  return {
    idade: String(bruto["age"] ?? ""),
    genero: String(bruto["gender"] ?? ""),
  };
}

export async function buscarInsights(opts: {
  token: string;
  actId: string;
  desde: string;
  ate: string;
  recorte: Recorte;
  versao?: string;
}): Promise<{ base: LinhaInsight[]; recortes: LinhaRecorte[] } | null> {
  ultimaFalha = null;

  const versao = opts.versao ?? VERSAO_PADRAO;
  const ehBase = opts.recorte === "base";
  const params = new URLSearchParams({
    level: "ad",
    time_range: JSON.stringify({ since: opts.desde, until: opts.ate }),
    // Sem time_increment=1 a Meta agrega o periodo inteiro numa linha e o
    // grao diario — que e o da chave primaria — se perde.
    time_increment: "1",
    fields: ehBase ? CAMPOS_BASE : CAMPOS_RECORTE,
    limit: "500",
    access_token: opts.token,
  });

  const bd = BREAKDOWNS[opts.recorte];
  if (bd) params.set("breakdowns", bd);

  let url: string | null =
    `https://graph.facebook.com/${versao}/${opts.actId}/insights?${params}`;

  const base: LinhaInsight[] = [];
  const recortes: LinhaRecorte[] = [];

  try {
    for (let p = 0; p < MAX_PAGINAS && url; p++) {
      const r = await fetch(url);

      if (!r.ok) {
        ultimaFalha = "http";
        const corpo = await r.json().catch(() => ({}));
        const err = (corpo as Record<string, any>)?.error;
        if (err) ultimaFalha = "erro_api";
        console.warn(
          `Insights recusados para ${opts.actId} (${opts.recorte}): ` +
            `status=${r.status} code=${err?.code} ${err?.message ?? ""}`,
        );
        return null;
      }

      const corpo = await r.json();
      if (corpo.error) {
        ultimaFalha = "erro_api";
        console.warn(
          `Insights com erro para ${opts.actId}: code=${corpo.error.code} ` +
            corpo.error.message,
        );
        return null;
      }

      for (const bruto of corpo.data ?? []) {
        if (ehBase) {
          const linha = normalizarLinha(bruto);
          if (linha) base.push(linha);
          continue;
        }
        const adId = bruto["ad_id"];
        const dia = bruto["date_start"];
        if (typeof adId !== "string" || typeof dia !== "string") continue;
        recortes.push({
          ad_id: adId,
          dia,
          chave: chaveDoRecorte(opts.recorte, bruto),
          gasto_centavos: paraCentavos(bruto["spend"]),
          impressoes: Number(bruto["impressions"] ?? 0) || 0,
          alcance: Number(bruto["reach"] ?? 0) || 0,
          cliques: Number(bruto["clicks"] ?? 0) || 0,
          acoes: acoesParaObjeto(bruto["actions"]),
        });
      }

      url = corpo.paging?.next ?? null;
    }

    return { base, recortes };
  } catch (e) {
    ultimaFalha = "rede";
    console.warn(`Falha de rede nos insights de ${opts.actId}`, e);
    return null;
  }
}
```

- [ ] **Passo 4: Rodar e confirmar que passa**

```bash
deno test --allow-net tests/unit/meta_insights_test.ts
```

Esperado: 8 testes passando.

- [ ] **Passo 5: Commit**

```bash
git add supabase/functions/_shared/meta_insights.ts tests/unit/meta_insights_test.ts
git commit -m "Busca de insights na Marketing API, com paginacao e recortes

Tres recortes, tres chamadas, porque a API nao combina recortes
arbitrarios numa so.

time_increment=1 e o que garante o grao diario: sem ele a Meta agrega
o periodo inteiro numa linha e o grao da chave primaria se perde.

Falha registra o motivo em vez de so devolver null. Token revogado
para de trazer dado para todas as contas, e sem o motivo o sintoma
fica igual ao de nao haver nada a buscar."
```

---

### Tarefa 5: Gravador — upsert, execuções e a trava do botão

**Arquivos:**
- Criar: `supabase/functions/_shared/insights_store.ts`
- Teste: `tests/unit/insights_store_test.ts`

**Interfaces:**
- Consome: `LinhaInsight` (Tarefa 3), `LinhaRecorte`, `Recorte` (Tarefa 4);
  tabelas da Tarefa 1.
- Produz: `podeRodarManual(ultimaEm: string | null, agora?: Date):
  { pode: boolean; faltamSegundos: number }`,
  `abrirExecucao(db, opts): Promise<number>`,
  `fecharExecucao(db, id, opts): Promise<void>`,
  `gravarBase(db, tenantId, linhas): Promise<number>`,
  `gravarRecortes(db, tenantId, tipo, linhas): Promise<number>`.

- [ ] **Passo 1: Escrever os testes que falham**

Criar `tests/unit/insights_store_test.ts`:

```typescript
import { assertEquals } from "jsr:@std/assert";
import { podeRodarManual } from "../../supabase/functions/_shared/insights_store.ts";

// A trava vive no banco, nao em memoria: Edge Function nao guarda estado
// entre invocacoes, entao uma trava em variavel seria zerada a cada
// chamada e nao travaria nada. Esta funcao decide a partir do timestamp
// que veio do banco.

Deno.test("libera quando nunca rodou manualmente", () => {
  assertEquals(podeRodarManual(null).pode, true);
});

Deno.test("recusa dentro dos 5 minutos", () => {
  const agora = new Date("2026-09-20T12:00:00Z");
  const haDoisMin = "2026-09-20T11:58:00Z";
  const r = podeRodarManual(haDoisMin, agora);
  assertEquals(r.pode, false);
  assertEquals(r.faltamSegundos, 180);
});

Deno.test("libera depois dos 5 minutos", () => {
  const agora = new Date("2026-09-20T12:00:00Z");
  assertEquals(podeRodarManual("2026-09-20T11:54:00Z", agora).pode, true);
});

Deno.test("libera exatamente aos 5 minutos", () => {
  const agora = new Date("2026-09-20T12:00:00Z");
  assertEquals(podeRodarManual("2026-09-20T11:55:00Z", agora).pode, true);
});

Deno.test("timestamp invalido libera em vez de travar para sempre", () => {
  // Preferir liberar: uma data corrompida travaria o botao
  // permanentemente, e o operador nao teria como destravar.
  assertEquals(podeRodarManual("nao e data").pode, true);
});

Deno.test("faltamSegundos e zero quando pode rodar", () => {
  assertEquals(podeRodarManual(null).faltamSegundos, 0);
});
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
deno test tests/unit/insights_store_test.ts
```

Esperado: FALHA com `Cannot find module`.

- [ ] **Passo 3: Implementar**

Criar `supabase/functions/_shared/insights_store.ts`:

```typescript
/**
 * Gravação dos insights e registro das execuções.
 *
 * O upsert é o que faz a janela móvel funcionar: como a Meta reescreve o
 * passado por dias, a mesma linha chega várias vezes com valores
 * diferentes. A chave primária composta garante correção no lugar.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { LinhaInsight } from "./insights_norm.ts";
import type { LinhaRecorte, Recorte } from "./meta_insights.ts";

const INTERVALO_MANUAL_SEGUNDOS = 300;

/**
 * Decide se a atualização manual pode rodar.
 *
 * Função pura recebendo o timestamp que veio do banco, em vez de consultar
 * ela mesma: Edge Function não guarda estado entre invocações, então uma
 * trava em variável de módulo seria zerada a cada chamada.
 *
 * Timestamp inválido libera. Travar seria pior: o operador não teria como
 * destravar, e o botão ficaria morto para sempre.
 */
export function podeRodarManual(
  ultimaEm: string | null,
  agora: Date = new Date(),
): { pode: boolean; faltamSegundos: number } {
  if (!ultimaEm) return { pode: true, faltamSegundos: 0 };

  const t = Date.parse(ultimaEm);
  if (!Number.isFinite(t)) return { pode: true, faltamSegundos: 0 };

  const decorrido = (agora.getTime() - t) / 1000;
  if (decorrido >= INTERVALO_MANUAL_SEGUNDOS) {
    return { pode: true, faltamSegundos: 0 };
  }
  return {
    pode: false,
    faltamSegundos: Math.ceil(INTERVALO_MANUAL_SEGUNDOS - decorrido),
  };
}

export async function abrirExecucao(
  db: SupabaseClient,
  opts: {
    tenantId: string;
    tipo: "recorrente" | "manual" | "backfill";
    desde: string;
    ate: string;
  },
): Promise<number> {
  const { data, error } = await db.from("sync_runs").insert({
    tenant_id: opts.tenantId,
    tipo: opts.tipo,
    janela_inicio: opts.desde,
    janela_fim: opts.ate,
  }).select("id").single();

  if (error) throw new Error(`Nao consegui abrir sync_run: ${error.message}`);
  return data.id as number;
}

export async function fecharExecucao(
  db: SupabaseClient,
  id: number,
  opts: { linhas: number; erro?: string },
): Promise<void> {
  await db.from("sync_runs").update({
    terminado_em: new Date().toISOString(),
    linhas_gravadas: opts.linhas,
    status: opts.erro ? "falhou" : "ok",
    erro: opts.erro ?? null,
  }).eq("id", id);
}

/** Grava o grão base. Upsert porque a Meta reescreve o passado. */
export async function gravarBase(
  db: SupabaseClient, tenantId: string, linhas: LinhaInsight[],
): Promise<number> {
  if (linhas.length === 0) return 0;

  const { error } = await db.from("meta_insights_diario").upsert(
    linhas.map((l) => ({
      tenant_id: tenantId,
      ad_id: l.ad_id,
      dia: l.dia,
      gasto_centavos: l.gasto_centavos,
      impressoes: l.impressoes,
      alcance: l.alcance,
      cliques: l.cliques,
      cliques_link: l.cliques_link,
      acoes: l.acoes,
      atualizado_em: new Date().toISOString(),
    })),
    { onConflict: "tenant_id,ad_id,dia" },
  );

  if (error) throw new Error(`Falha ao gravar insights: ${error.message}`);
  return linhas.length;
}

export async function gravarRecortes(
  db: SupabaseClient,
  tenantId: string,
  tipo: Exclude<Recorte, "base">,
  linhas: LinhaRecorte[],
): Promise<number> {
  if (linhas.length === 0) return 0;

  const { error } = await db.from("meta_insights_recorte").upsert(
    linhas.map((l) => ({
      tenant_id: tenantId,
      ad_id: l.ad_id,
      dia: l.dia,
      tipo_recorte: tipo,
      chave: l.chave,
      gasto_centavos: l.gasto_centavos,
      impressoes: l.impressoes,
      alcance: l.alcance,
      cliques: l.cliques,
      acoes: l.acoes,
      atualizado_em: new Date().toISOString(),
    })),
    { onConflict: "tenant_id,ad_id,dia,tipo_recorte,chave" },
  );

  if (error) throw new Error(`Falha ao gravar recortes: ${error.message}`);
  return linhas.length;
}
```

- [ ] **Passo 4: Rodar e confirmar que passa**

```bash
deno test tests/unit/insights_store_test.ts
```

Esperado: 6 testes passando.

- [ ] **Passo 5: Commit**

```bash
git add supabase/functions/_shared/insights_store.ts tests/unit/insights_store_test.ts
git commit -m "Gravacao dos insights com upsert e registro de execucao

O upsert e o que faz a janela movel funcionar: a Meta reescreve o
passado por dias, entao a mesma linha chega varias vezes com valores
diferentes, e a chave composta corrige no lugar em vez de duplicar o
gasto do mesmo dia.

A decisao da trava do botao e funcao pura recebendo o timestamp do
banco, nao consulta propria: Edge Function nao guarda estado entre
invocacoes, entao trava em variavel de modulo seria zerada a cada
chamada e nao travaria nada.

Timestamp invalido libera em vez de travar. Travar seria pior — o
operador nao teria como destravar e o botao morreria."
```

---

### Tarefa 6: Edge Function de sincronização

**Arquivos:**
- Criar: `supabase/functions/sync-meta-insights/index.ts`
- Modificar: `supabase/config.toml` — acrescentar bloco da função

**Interfaces:**
- Consome: `buscarInsights`, `ultimaFalha` (Tarefa 4); `podeRodarManual`,
  `abrirExecucao`, `fecharExecucao`, `gravarBase`, `gravarRecortes`
  (Tarefa 5); `admin()` de `_shared/db.ts` (Fatia A).
- Produz: endpoint `POST /functions/v1/sync-meta-insights`, aceitando
  `{ tipo?: "recorrente" | "manual" }` no corpo.

- [ ] **Passo 1: Implementar a função**

Criar `supabase/functions/sync-meta-insights/index.ts`:

```typescript
import { admin } from "../_shared/db.ts";
import { buscarInsights, ultimaFalha } from "../_shared/meta_insights.ts";
import {
  abrirExecucao,
  fecharExecucao,
  gravarBase,
  gravarRecortes,
  podeRodarManual,
} from "../_shared/insights_store.ts";

const DIAS_JANELA = 7;

function diaISO(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/**
 * Sincronização recorrente e manual.
 *
 * A janela é de 7 dias, e não só de hoje, porque a Meta reescreve o
 * passado: gasto de ontem muda nos dias seguintes por ajuste de cobrança e
 * atribuição que fecha depois. Sem reescrever a janela, o painel diverge do
 * Gerenciador — e quando o cliente comparar os dois, quem perde a discussão
 * é o operador.
 *
 * `verify_jwt` fica LIGADO nesta função: ela não é webhook. O cron a chama
 * com a service_role_key, e o botão manual também. O JWT é justamente o que
 * a protege de ser disparada por qualquer um — rate limit estourado
 * derrubaria também as sincronizações agendadas.
 */
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const corpo = await req.json().catch(() => ({}));
  const tipo: "recorrente" | "manual" =
    corpo?.tipo === "manual" ? "manual" : "recorrente";

  const db = admin();
  const versao = Deno.env.get("META_API_VERSION") ?? "v21.0";

  const { data: contas } = await db
    .from("ad_accounts")
    .select("tenant_id, act_id, token_ref");

  if (!contas?.length) {
    return Response.json({ ok: true, contas: 0, motivo: "nenhuma cadastrada" });
  }

  const desde = diaISO(DIAS_JANELA);
  const ate = diaISO(0);
  const resultado: unknown[] = [];

  for (const conta of contas) {
    // A trava do manual é por conta, não global: um operador atualizando o
    // cliente A não deve impedir que ele atualize o cliente B.
    if (tipo === "manual") {
      const { data: ultima } = await db
        .from("sync_runs")
        .select("iniciado_em")
        .eq("tenant_id", conta.tenant_id)
        .eq("tipo", "manual")
        .order("iniciado_em", { ascending: false })
        .limit(1)
        .maybeSingle();

      const trava = podeRodarManual(ultima?.iniciado_em ?? null);
      if (!trava.pode) {
        resultado.push({
          act_id: conta.act_id,
          pulado: "trava",
          faltam_segundos: trava.faltamSegundos,
        });
        continue;
      }
    }

    const token = Deno.env.get(conta.token_ref);
    if (!token) {
      // Sem isso o sintoma seria "zero linhas", igual ao de não haver o que
      // buscar — e o operador procuraria o problema no lugar errado.
      console.error(
        `Token ${conta.token_ref} nao esta no ambiente da funcao ` +
          `(conta ${conta.act_id})`,
      );
      resultado.push({ act_id: conta.act_id, erro: "token ausente" });
      continue;
    }

    const execId = await abrirExecucao(db, {
      tenantId: conta.tenant_id, tipo, desde, ate,
    });

    let linhas = 0;
    let erro: string | undefined;

    try {
      for (const recorte of ["base", "posicionamento", "demografia"] as const) {
        const r = await buscarInsights({
          token, actId: conta.act_id, desde, ate, recorte, versao,
        });

        if (!r) {
          erro = `busca de ${recorte} falhou: ${ultimaFalha}`;
          break;
        }

        linhas += recorte === "base"
          ? await gravarBase(db, conta.tenant_id, r.base)
          : await gravarRecortes(db, conta.tenant_id, recorte, r.recortes);
      }
    } catch (e) {
      erro = e instanceof Error ? e.message : String(e);
    }

    await fecharExecucao(db, execId, { linhas, erro });
    resultado.push({ act_id: conta.act_id, linhas, erro: erro ?? null });
  }

  return Response.json({ ok: true, tipo, desde, ate, contas: resultado });
});
```

- [ ] **Passo 2: Declarar a função no config**

Acrescentar ao final de `supabase/config.toml`:

```toml
# Esta não é webhook: o cron a chama com a service_role_key e o botão
# manual também. O verify_jwt ligado é o que impede que qualquer um a
# dispare — rate limit estourado derrubaria as sincronizações agendadas
# junto, e o botão que existia para dar dado fresco impediria qualquer
# dado de chegar.
[functions.sync-meta-insights]
verify_jwt = true
```

- [ ] **Passo 3: Publicar**

```bash
set -a && . ./.env && set +a
supabase functions deploy sync-meta-insights --project-ref "$SUPABASE_PROJECT_REF"
```

- [ ] **Passo 4: Exercitar contra a conta real**

```bash
set -a && . ./.env && set +a
KEY=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/api-keys" \
  | python3 -c "import json,sys; print(next(k['api_key'] for k in json.load(sys.stdin) if k['name']=='service_role'))")

curl -s -X POST "https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1/sync-meta-insights" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"tipo":"manual"}'
```

Esperado: JSON com `linhas` maior que zero para `act_269873128000933`.

- [ ] **Passo 5: Confirmar a trava disparando de novo**

Repita o comando do passo anterior imediatamente.

Esperado: `{"pulado":"trava","faltam_segundos":~300}`.

- [ ] **Passo 6: Conferir que o custo por lead apareceu**

```bash
set -a && . ./.env && set +a
python3 -c "
import sys; sys.path.insert(0,'scripts')
from run_pgtap import carregar_env, executar
carregar_env()
ok, r = executar('''select ad_name, dia, gasto_centavos/100.0 gasto, leads,
  cpl_centavos/100.0 cpl from desempenho_por_anuncio
 where leads > 0 order by dia desc limit 10''')
for x in (r or []): print(x)
"
```

Esperado: os leads reais já capturados aparecem com gasto e CPL.

- [ ] **Passo 7: Commit**

```bash
git add supabase/
git commit -m "Sincronizacao recorrente e manual dos insights

A janela e de 7 dias e nao so de hoje porque a Meta reescreve o
passado: gasto de ontem muda nos dias seguintes por ajuste de
cobranca e atribuicao que fecha depois. Sem reescrever a janela, o
painel diverge do Gerenciador, e quem perde a discussao com o cliente
e o operador.

A trava do manual e por conta e nao global: atualizar o cliente A nao
deve impedir de atualizar o cliente B.

verify_jwt fica ligado porque esta funcao nao e webhook. Rate limit
estourado derrubaria tambem as sincronizacoes agendadas, e o botao
que existia para dar dado fresco impediria qualquer dado de chegar."
```

---

### Tarefa 7: CLI de carga histórica com retomada

**Arquivos:**
- Criar: `scripts/backfill_insights.ts`

**Interfaces:**
- Consome: `buscarInsights`, `ultimaFalha` (Tarefa 4); `abrirExecucao`,
  `fecharExecucao`, `gravarBase`, `gravarRecortes` (Tarefa 5).
- Produz: CLI `deno run --allow-net --allow-env --allow-read
  scripts/backfill_insights.ts [--dias=N]`. **A forma com `=` é a única
  que funciona** — o parser junta `Deno.args` com `&`, então `--dias 90`
  viraria `dias&90` e o valor se perderia em silêncio, com o backfill
  rodando os 90 dias do default sem avisar que o argumento foi ignorado.

**Por que CLI e não Edge Function:** 90 dias × 3 recortes não cabe no limite
de execução de uma Edge Function. E o onboarding de cliente já é manual —
criar o App, pegar o token, conectar a conta — então um comando a mais no
roteiro é natural, e evita construir uma máquina de retomada em fatias para
uma operação que acontece uma vez por cliente.

- [ ] **Passo 1: Implementar**

Criar `scripts/backfill_insights.ts`:

```typescript
/**
 * Carga histórica de insights.
 *
 * Processa a janela em blocos de 7 dias e grava UMA LINHA DE sync_runs POR
 * BLOCO, não uma por execução. É isso que dá o ponto de retomada: rodar de
 * novo pula os blocos que já têm linha com status 'ok'. Sem isso, falhar
 * aos 80 dias de 90 custaria refazer tudo.
 *
 * Consequência para quem lê a tabela: um backfill de 90 dias produz ~13
 * linhas de tipo 'backfill', enquanto uma sincronização recorrente produz
 * uma. O carimbo de "atualizado às" da tela usa a mais recente de tipo
 * 'recorrente' ou 'manual', ignorando as de 'backfill'.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { buscarInsights, ultimaFalha } from "../supabase/functions/_shared/meta_insights.ts";
import {
  abrirExecucao,
  fecharExecucao,
  gravarBase,
  gravarRecortes,
} from "../supabase/functions/_shared/insights_store.ts";

const DIAS_POR_BLOCO = 7;

function carregarEnv(): Record<string, string> {
  const texto = Deno.readTextFileSync(new URL("../.env", import.meta.url));
  const env: Record<string, string> = {};
  for (const linha of texto.split("\n")) {
    const t = linha.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, v] = t.split(/=(.*)/s);
    env[k.trim()] = v.trim();
  }
  return env;
}

function dia(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const env = carregarEnv();
  const args = new URLSearchParams(
    Deno.args.join("&").replaceAll("--", ""),
  );
  const totalDias = Number(args.get("dias") ?? 90);

  const db = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: contas } = await db
    .from("ad_accounts").select("tenant_id, act_id, token_ref");

  if (!contas?.length) {
    console.log("Nenhuma conta cadastrada.");
    return;
  }

  const versao = env.META_API_VERSION ?? "v21.0";

  for (const conta of contas) {
    const token = env[conta.token_ref];
    if (!token) {
      console.error(`✗ ${conta.act_id}: token ${conta.token_ref} ausente`);
      continue;
    }

    console.log(`\n${conta.act_id} — ${totalDias} dias em blocos de ${DIAS_POR_BLOCO}`);

    for (let inicio = totalDias; inicio > 0; inicio -= DIAS_POR_BLOCO) {
      const desde = dia(inicio);
      const ate = dia(Math.max(inicio - DIAS_POR_BLOCO + 1, 1));

      // Retomada: bloco que já terminou com 'ok' é pulado.
      const { data: feito } = await db
        .from("sync_runs")
        .select("id")
        .eq("tenant_id", conta.tenant_id)
        .eq("tipo", "backfill")
        .eq("janela_inicio", desde)
        .eq("janela_fim", ate)
        .eq("status", "ok")
        .maybeSingle();

      if (feito) {
        console.log(`  ${desde} → ${ate}  já feito, pulando`);
        continue;
      }

      const execId = await abrirExecucao(db, {
        tenantId: conta.tenant_id, tipo: "backfill", desde, ate,
      });

      let linhas = 0;
      let erro: string | undefined;

      try {
        for (const recorte of ["base", "posicionamento", "demografia"] as const) {
          const r = await buscarInsights({
            token, actId: conta.act_id, desde, ate, recorte, versao,
          });
          if (!r) {
            erro = `${recorte}: ${ultimaFalha}`;
            break;
          }
          linhas += recorte === "base"
            ? await gravarBase(db, conta.tenant_id, r.base)
            : await gravarRecortes(db, conta.tenant_id, recorte, r.recortes);
        }
      } catch (e) {
        erro = e instanceof Error ? e.message : String(e);
      }

      await fecharExecucao(db, execId, { linhas, erro });
      console.log(
        `  ${desde} → ${ate}  ${erro ? `✗ ${erro}` : `${linhas} linhas`}`,
      );

      // Respira entre blocos: a carga histórica não tem pressa e não pode
      // consumir a cota que as sincronizações agendadas precisam.
      if (!erro) await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

if (import.meta.main) await main();
```

- [ ] **Passo 2: Obter a chave de serviço e guardar no .env**

```bash
set -a && . ./.env && set +a
KEY=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/api-keys" \
  | python3 -c "import json,sys; print(next(k['api_key'] for k in json.load(sys.stdin) if k['name']=='service_role'))")
grep -q SUPABASE_SERVICE_ROLE_KEY .env || echo "SUPABASE_SERVICE_ROLE_KEY=$KEY" >> .env
grep -c SUPABASE_SERVICE_ROLE_KEY .env
```

O `.env` já está no `.gitignore`. Não imprima o valor.

- [ ] **Passo 3: Rodar um bloco curto primeiro**

```bash
deno run --allow-net --allow-env --allow-read scripts/backfill_insights.ts --dias=14
```

Esperado: dois blocos processados, com contagem de linhas em cada.

- [ ] **Passo 4: Provar a retomada**

Rode o mesmo comando de novo.

Esperado: ambos os blocos reportam `já feito, pulando`, e nenhuma chamada
nova à Meta acontece. É isso que prova que interromper aos 80 de 90 dias não
custa refazer tudo.

- [ ] **Passo 5: Rodar os 90 dias**

```bash
deno run --allow-net --allow-env --allow-read scripts/backfill_insights.ts --dias=90
```

Esperado: ~13 blocos, alguns minutos, sem erro.

- [ ] **Passo 6: Conferir o volume**

```bash
set -a && . ./.env && set +a
python3 -c "
import sys; sys.path.insert(0,'scripts')
from run_pgtap import carregar_env, executar
carregar_env()
for t in ['meta_insights_diario','meta_insights_recorte','sync_runs']:
    ok, r = executar(f'select count(*)::int n from {t}')
    print(f'  {t:24} {r[0][\"n\"]:>8} linhas')
"
```

- [ ] **Passo 7: Commit**

```bash
git add scripts/backfill_insights.ts
git commit -m "Carga historica de insights em blocos, com retomada

90 dias por tres recortes nao cabe no limite de execucao de uma Edge
Function. E o onboarding de cliente ja e manual, entao um comando a
mais no roteiro e natural — mais barato que construir uma maquina de
retomada em fatias para algo que acontece uma vez por cliente.

Grava uma linha de sync_runs POR BLOCO, nao por execucao: e isso que
da o ponto de retomada. Rodar de novo pula bloco que ja terminou com
ok, entao falhar aos 80 dias de 90 nao custa refazer tudo.

Respira um segundo entre blocos porque a carga historica nao tem
pressa e nao pode consumir a cota que as sincronizacoes agendadas
precisam."
```

---

### Tarefa 8: Agendamento e classificação do tipo de campanha

**Arquivos:**
- Criar: `supabase/migrations/20260920000300_agendamento_insights.sql`
- Modificar: `supabase/functions/_shared/meta.ts` — acrescentar
  `destination_type` e `optimization_goal` ao retorno
- Modificar: `supabase/functions/enrich-ad-metadata/index.ts` — gravar os
  dois campos novos
- Modificar: `tests/unit/meta_test.ts` — cobrir os campos novos

**Interfaces:**
- Consome: `sync-meta-insights` publicada (Tarefa 6); `ad_metadata_cache`
  com as colunas da Tarefa 1.
- Produz: job `pg_cron` `sincronizar-insights` de 6 em 6 horas;
  `AdMetadata` ganha `destinationType: string | null` e
  `optimizationGoal: string | null`; `ad_accounts.timezone` e
  `ad_metadata_cache.act_id` passam a ser mantidos pelo enriquecimento.

- [ ] **Passo 1: Escrever os testes que falham**

Acrescentar a `tests/unit/meta_test.ts`:

```typescript
Deno.test("traz destination_type e optimization_goal do conjunto", async () => {
  // Campanha de mensagem e de seguidores aparecem AMBAS como
  // OUTCOME_ENGAGEMENT. Verificado na conta real: 191 conjuntos WHATSAPP
  // contra 4 INSTAGRAM_PROFILE, todos sob o mesmo objetivo. Sem estes dois
  // campos, as duas entram misturadas no mesmo relatorio e o CPL de uma
  // campanha que nao tem lead poluiria a media.
  const m = mockFetch({
    id: "123", name: "Criativo A",
    adset: {
      id: "456", name: "Conjunto 1",
      destination_type: "WHATSAPP",
      optimization_goal: "CONVERSATIONS",
    },
    campaign: { id: "789", name: "Campanha X", objective: "OUTCOME_ENGAGEMENT" },
  });
  try {
    const r = await buscarMetadataDoAnuncio("token", "123");
    assertEquals(r!.destinationType, "WHATSAPP");
    assertEquals(r!.optimizationGoal, "CONVERSATIONS");
  } finally { m.restaurar(); }
});

Deno.test("aceita conjunto sem destination_type", async () => {
  const m = mockFetch({ id: "123", name: "A", adset: { id: "4", name: "C" } });
  try {
    const r = await buscarMetadataDoAnuncio("token", "123");
    assertEquals(r!.destinationType, null);
  } finally { m.restaurar(); }
});
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
deno test --allow-net tests/unit/meta_test.ts
```

Esperado: FALHA com erro de tipo em `destinationType`.

- [ ] **Passo 3: Acrescentar os campos em `meta.ts`**

Em `supabase/functions/_shared/meta.ts`, no tipo `AdMetadata`, acrescentar:

```typescript
  /**
   * `WHATSAPP`, `INSTAGRAM_PROFILE`, `MESSAGING_INSTAGRAM_DIRECT_WHATSAPP`…
   *
   * É o que separa campanha de mensagem de campanha de seguidores — o
   * `objective` não serve, porque as duas aparecem como
   * `OUTCOME_ENGAGEMENT`. Campanha sem lead precisa de outra métrica que
   * não custo por lead.
   */
  destinationType: string | null;
  optimizationGoal: string | null;
```

No campo `campos` da consulta, trocar `adset{id,name}` por
`adset{id,name,destination_type,optimization_goal}`.

No retorno, acrescentar:

```typescript
    destinationType: j.adset?.destination_type ?? null,
    optimizationGoal: j.adset?.optimization_goal ?? null,
```

- [ ] **Passo 4: Gravar os campos no enriquecimento**

Em `supabase/functions/enrich-ad-metadata/index.ts`, no `upsert` de
`ad_metadata_cache`, acrescentar:

```typescript
      destination_type: meta.destinationType,
      optimization_goal: meta.optimizationGoal,
```

- [ ] **Passo 5: Rodar e confirmar que passa**

```bash
deno test --allow-net --allow-read tests/unit/
```

Esperado: tudo verde, com os dois testes novos.

- [ ] **Passo 6: Fazer o enriquecimento manter o fuso e a conta de origem**

O `default 'America/Sao_Paulo'` da coluna `timezone` é uma armadilha: entra
calado e parece certo. Na conta real isso já aconteceu — a TET_PROF é
`America/Belem`, recebeu o default, e ninguém notaria, porque os dois só
coincidem enquanto o Brasil não tiver horário de verão.

Depender de alguém lembrar no onboarding repetiria o erro no próximo
cliente. Ler da Meta a cada ciclo faz o valor se corrigir sozinho.

Em `supabase/functions/enrich-ad-metadata/index.ts`, no laço que já percorre
as contas, antes de resolver os anúncios:

```typescript
    // O fuso da conta e a fonte da verdade do CPL diario. Default que
    // parece certo e pior que campo vazio: ele nao pede correcao.
    try {
      const r = await fetch(
        `https://graph.facebook.com/${versaoApi}/${conta.act_id}` +
          `?fields=timezone_name&access_token=${encodeURIComponent(token)}`,
      );
      const j = await r.json();
      if (r.ok && typeof j.timezone_name === "string") {
        await db.from("ad_accounts")
          .update({ timezone: j.timezone_name })
          .eq("tenant_id", linha.tenant_id)
          .eq("act_id", conta.act_id);
      }
    } catch (e) {
      console.warn(`Nao consegui ler o fuso de ${conta.act_id}`, e);
    }
```

E no `upsert` de `ad_metadata_cache`, gravar a conta de origem — sem ela a
view não resolve o fuso do anúncio e volta a contar lead duplicado quando o
tenant tiver mais de uma conta:

```typescript
      act_id: conta.act_id,
```

- [ ] **Passo 7: Conferir o fuso contra a Meta**

```bash
set -a && . ./.env && set +a
python3 -c "
import sys, os, json, urllib.request; sys.path.insert(0,'scripts')
from run_pgtap import carregar_env, executar
carregar_env()
ok, contas = executar('select act_id, timezone from ad_accounts')
for c in contas:
    url = ('https://graph.facebook.com/v21.0/' + c['act_id']
           + '?fields=timezone_name&access_token='
           + os.environ['META_ACCESS_TOKEN'])
    real = json.load(urllib.request.urlopen(url)).get('timezone_name')
    marca = 'OK' if real == c['timezone'] else 'DIVERGE: Meta diz ' + str(real)
    print(' ', c['act_id'], c['timezone'], marca)
"
```

Esperado: todas com `OK`. Divergência aqui significa CPL diário errado com
fechamento mensal certo — o erro que sobrevive meses.

- [ ] **Passo 8: Escrever a migration do agendamento**

Criar `supabase/migrations/20260920000300_agendamento_insights.sql`:

```sql
/**
 * Sincronizacao 4x ao dia.
 *
 * Quatro e nao uma porque gestor de trafego olha o painel durante o dia.
 * Ver "hoje: R$ 0,00" as 15h quando se sabe que houve gasto parece sistema
 * quebrado, mesmo estando tecnicamente correto.
 *
 * A guarda do where nao e detalhe: com as configuracoes ausentes,
 * current_setting devolve NULL, a url do http_post vira NULL e o job
 * estoura com violacao de not-null a cada execucao, para sempre. Ja
 * aconteceu neste projeto com o job de enriquecimento.
 */
select cron.schedule(
  'sincronizar-insights',
  '0 */6 * * *',
  $cron$
    select net.http_post(
      url := current_setting('app.functions_base_url', true)
             || '/sync-meta-insights',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization',
        'Bearer ' || current_setting('app.service_role_key', true)
      ),
      body := '{"tipo":"recorrente"}'::jsonb
    )
    where coalesce(current_setting('app.functions_base_url', true), '') <> ''
      and coalesce(current_setting('app.service_role_key', true), '') <> ''
  $cron$
);
```

- [ ] **Passo 9: Configurar as settings que o job precisa**

```bash
set -a && . ./.env && set +a
python3 -c "
import sys, os; sys.path.insert(0,'scripts')
from run_pgtap import carregar_env, executar
carregar_env()
ref = os.environ['SUPABASE_PROJECT_REF']
executar(f\"alter database postgres set app.functions_base_url = 'https://{ref}.supabase.co/functions/v1';\")
print('base_url configurada')
"
```

E a chave de serviço, que o job usa para chamar a função:

```bash
set -a && . ./.env && set +a
python3 -c "
import sys, os, urllib.request, json; sys.path.insert(0,'scripts')
from run_pgtap import carregar_env, executar
carregar_env()
ref = os.environ['SUPABASE_PROJECT_REF']
req = urllib.request.Request(
    f'https://api.supabase.com/v1/projects/{ref}/api-keys',
    headers={'Authorization': 'Bearer ' + os.environ['SUPABASE_ACCESS_TOKEN']})
chave = next(k['api_key'] for k in json.load(urllib.request.urlopen(req))
             if k['name'] == 'service_role')
ok, r = executar(f\"alter database postgres set app.service_role_key = '{chave}';\")
print('service_role_key configurada' if ok else r)
"
```

O valor nunca é impresso — ele viaja da API para o banco sem passar pela
saída do terminal.

**Confira que as duas ficaram gravadas sem revelar a chave:**

```bash
set -a && . ./.env && set +a
python3 -c "
import sys; sys.path.insert(0,'scripts')
from run_pgtap import carregar_env, executar
carregar_env()
ok, r = executar('''select name, case when setting = '' then 'VAZIA'
     else 'definida (' || length(setting) || ' chars)' end as estado
  from pg_settings where name in
    ('app.functions_base_url','app.service_role_key')''')
for x in (r or []): print(' ', x)
"
```

Esperado: as duas como `definida`. Se aparecerem como `VAZIA`, o job vai
rodar sem fazer nada — que é o comportamento seguro que a guarda garante,
mas não é o que você quer.

- [ ] **Passo 10: Aplicar e confirmar que o job existe**

```bash
set -a && . ./.env && set +a
supabase db push --linked --include-all --yes
python3 -c "
import sys; sys.path.insert(0,'scripts')
from run_pgtap import carregar_env, executar
carregar_env()
ok, r = executar(\"select jobname, schedule, active from cron.job order by jobname\")
for x in (r or []): print(' ', x)
"
```

Esperado: `sincronizar-insights` com `0 */6 * * *`, ativo.

- [ ] **Passo 11: Rodar a suíte inteira**

```bash
deno test --allow-net --allow-read tests/unit/
python3 scripts/run_pgtap.py supabase/tests/database/*.test.sql
```

Esperado: tudo verde, nada regrediu.

- [ ] **Passo 12: Commit**

```bash
git add supabase/ tests/
git commit -m "Agenda a sincronizacao e classifica o tipo de campanha

destination_type e optimization_goal passam a ser gravados porque
campanha de mensagem e de seguidores aparecem ambas como
OUTCOME_ENGAGEMENT. Verificado na conta real: 191 conjuntos WHATSAPP
contra 4 INSTAGRAM_PROFILE, todos sob o mesmo objetivo. Sem separar,
o CPL de uma campanha que nao tem lead poluiria a media.

Quatro sincronizacoes por dia e nao uma porque gestor de trafego olha
o painel durante o dia; ver zero as 15h parece sistema quebrado mesmo
estando correto.

A guarda do where ja provou ser necessaria neste projeto: com as
configuracoes ausentes, current_setting devolve NULL, a url vira NULL
e o job estoura a cada execucao, para sempre."
```

---

## Ordem de Execução

```
Tarefa 1  schema                    ─┐
Tarefa 2  view e fuso               ─┤ SQL puro, sem dependência externa
Tarefa 3  normalização              ─┤ TypeScript puro
Tarefa 4  cliente de insights       ─┘ TypeScript com fetch mockado
Tarefa 5  gravador                  ← depende de 1, 3 e 4
Tarefa 6  Edge Function             ← depende de 5, e usa a conta real
Tarefa 7  CLI de carga histórica    ← depende de 5
Tarefa 8  agendamento e tipo        ← depende de 6
```

As Tarefas 1 a 4 não dependem de nada externo e podem ser feitas em
qualquer ordem entre si. A partir da 6, a conta real `act_269873128000933`
entra no caminho — ela já está cadastrada e com token válido.

## Cobertura da Spec

| Seção da spec | Tarefa |
|---|---|
| 5 Arquitetura (3 caminhos) | 6, 7, 8 |
| 6.1 Grão base | 1 |
| 6.2 Recortes | 1 |
| 6.3 Execuções | 1, 5 |
| 6.4 Colunas novas | 1, 8 |
| 6.5 Regra de dinheiro | 3 |
| 7 Sincronização e upsert | 5, 6 |
| 7 Trava do botão | 5, 6 |
| 7 Retomada do backfill | 7 |
| 8 Cruzamento e fuso | 2 |
| 9 Segurança e RLS | 1, 2 |
| 10 Testes | embutido em todas |
