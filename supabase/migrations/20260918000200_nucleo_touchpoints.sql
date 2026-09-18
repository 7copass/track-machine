create table ad_touchpoints (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references tenants(id) on delete cascade,
  instance_id               uuid references evolution_instances(id),

  wa_message_id             text not null,

  -- Telefone e NULO quando o JID nao for de pessoa (@lid anonimo, grupo).
  -- A identidade do touchpoint e o clique no anuncio (ctwa_clid), nao o
  -- telefone -- o telefone e so como se liga ele ao Chatwoot. Descartar o
  -- touchpoint nesse caso perderia o ctwa_clid, que e justamente o que a
  -- Fatia C precisa para devolver a conversao a Meta.
  phone_e164                text,
  phone_match_key           text,

  -- Lead de verdade chega com fromMe false. Guardado para diagnostico:
  -- um payload real veio com true carregando contexto de anuncio, e vale
  -- poder separar os dois casos depois sem reprocessar tudo.
  from_me                   boolean,

  ctwa_clid                 text,
  ad_id                     text,
  adset_id                  text,
  campaign_id               text,
  platform                  text,
  source_channel            text not null
                            check (source_channel in ('evolution','quepasa')),

  received_at               timestamptz not null,
  raw_payload               jsonb not null,

  chatwoot_contact_id       bigint,
  chatwoot_conversation_id  bigint,
  reconciled_at             timestamptz,

  criado_em                 timestamptz not null default now(),
  unique (tenant_id, wa_message_id)
);

create index on ad_touchpoints (tenant_id, phone_match_key, received_at desc);
create index on ad_touchpoints (tenant_id, reconciled_at)
  where reconciled_at is null;

-- Append-only aplicado pelo banco, nao por convencao.
-- A jornada do lead recorrente so existe porque nada se sobrescreve;
-- deixar isso a cargo da disciplina de quem escreve query e apostar.
--
-- A regra e escrita ao contrario: em vez de listar os campos congelados,
-- lista os cinco que podem mudar e compara todo o resto. Uma lista de
-- campos congelados envelhece mal -- coluna nova nasce desprotegida ate
-- alguem lembrar de acrescenta-la -- enquanto a lista do que pode mudar
-- e fechada pela Restricao Global do plano e nao cresce sozinha.
create or replace function bloquear_alteracao_de_origem()
returns trigger language plpgsql as $$
declare
  alteraveis constant text[] := array[
    'chatwoot_contact_id', 'chatwoot_conversation_id', 'reconciled_at',
    'adset_id', 'campaign_id'
  ];
begin
  if to_jsonb(new) - alteraveis is distinct from to_jsonb(old) - alteraveis
  then
    raise exception
      'ad_touchpoints e append-only: campos de origem nao podem mudar';
  end if;
  return new;
end $$;

create trigger tg_touchpoint_append_only
  before update on ad_touchpoints
  for each row execute function bloquear_alteracao_de_origem();

create table conversion_events (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references tenants(id) on delete cascade,
  touchpoint_id             uuid references ad_touchpoints(id),

  tipo                      text not null
                            check (tipo in ('qualificado','desqualificado','compra')),
  valor_centavos            bigint,
  moeda                     text default 'BRL',

  chatwoot_conversation_id  bigint,
  agente                    text,
  ocorrido_em               timestamptz not null,

  enviado_meta_em           timestamptz,
  meta_response             jsonb,
  tentativas_envio          int not null default 0,

  criado_em                 timestamptz not null default now()
);

create index on conversion_events (tenant_id, enviado_meta_em)
  where enviado_meta_em is null;

alter table ad_touchpoints    enable row level security;
alter table conversion_events enable row level security;

create policy tenant_le_os_proprios_touchpoints on ad_touchpoints
  for select to authenticated
  using (tenant_id = current_tenant_id());

create policy tenant_le_as_proprias_conversoes on conversion_events
  for select to authenticated
  using (tenant_id = current_tenant_id());
