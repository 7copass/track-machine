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
