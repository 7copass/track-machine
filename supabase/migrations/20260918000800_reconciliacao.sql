-- Reconciliacao entre o touchpoint do Evolution e a conversa do Chatwoot.
--
-- Os dois sistemas escrevem sobre o mesmo lead sem ordem garantida, e a
-- maioria das instancias nao tem a integracao nativa que traria os ids do
-- Chatwoot no proprio payload do Evolution. Entao o touchpoint nasce orfao
-- e o vinculo e fechado por quem chegar por ultimo: a captura, o webhook do
-- Chatwoot, ou esta varredura.

create extension if not exists pg_cron;

-- Copia local das conversas do Chatwoot, gravada pelo webhook.
--
-- Guardar em vez de consultar a API na hora e o que transforma a
-- reconciliacao num JOIN em SQL puro. Reconciliacao que depende de rede
-- falha quando a rede falha -- ou seja, exatamente durante o incidente em
-- que ela mais importa.
create table chatwoot_conversations (
  -- Id da conversa como o Chatwoot a numera, sequencial POR CONTA. Cada
  -- tenant e uma conta dentro da mesma instancia (ver chatwoot_configs),
  -- entao o id 1 existe uma vez para cada cliente. Com a chave so no id, o
  -- upsert do webhook sobrescreveria a conversa de um cliente com a de
  -- outro -- e o touchpoint do primeiro deixaria de casar, em silencio.
  -- Mesmo erro ja corrigido em ad_metadata_cache (20260918000650).
  id               bigint not null,
  tenant_id        uuid not null references tenants(id) on delete cascade,

  contact_id       bigint,
  phone_e164       text,
  phone_match_key  text,

  -- Quando o Chatwoot abriu a conversa. E o lado temporal do join: a
  -- janela e medida contra o received_at do toque.
  criada_em        timestamptz not null,

  -- Quando nos gravamos. Separado de criada_em porque um webhook atrasado
  -- ou reprocessado nao pode mover a conversa dentro da janela.
  registrada_em    timestamptz not null default now(),

  primary key (tenant_id, id)
);

create index on chatwoot_conversations (tenant_id, phone_match_key, criada_em desc);

alter table chatwoot_conversations enable row level security;

create policy tenant_le_as_proprias_conversas on chatwoot_conversations
  for select to authenticated
  using (tenant_id = current_tenant_id());

-- Liga touchpoints orfaos as conversas do Chatwoot.
--
-- Casa pelo phone_match_key (tolerante ao nono digito) dentro da janela, e
-- escolhe a conversa mais proxima no tempo quando ha mais de uma.
--
-- A condicao c.tenant_id = t.tenant_id nao e redundante com o RLS: quem
-- chama esta funcao e o pg_cron (postgres) ou o webhook (service_role), e
-- os dois contornam RLS. Ela e o unico freio contra ligar o lead de um
-- cliente a conversa de outro que por acaso tenha o mesmo telefone.
create or replace function reconciliar_orfaos(janela_min int default 15)
returns int
language plpgsql
as $$
declare
  ligados int;
begin
  with candidatos as (
    select distinct on (t.id)
      t.id as touchpoint_id,
      c.id as conversation_id,
      c.contact_id
    from ad_touchpoints t
    join chatwoot_conversations c
      on  c.tenant_id       = t.tenant_id
      and c.phone_match_key = t.phone_match_key
      and c.criada_em between t.received_at - make_interval(mins => janela_min)
                          and t.received_at + make_interval(mins => janela_min)
    where t.reconciled_at is null
    order by t.id, abs(extract(epoch from (c.criada_em - t.received_at)))
  )
  update ad_touchpoints t
     set chatwoot_conversation_id = k.conversation_id,
         chatwoot_contact_id      = coalesce(t.chatwoot_contact_id, k.contact_id),
         reconciled_at            = now()
    from candidatos k
   where t.id = k.touchpoint_id;

  get diagnostics ligados = row_count;
  return ligados;
end $$;

-- O PostgREST publica toda funcao do schema public como endpoint de RPC, e
-- os grants padrao do Supabase incluem anon e authenticated. Reconciliacao
-- e manutencao, nao operacao de painel: sem o revoke, qualquer visitante
-- com a chave anon -- que e publica por desenho -- dispara um join sobre as
-- duas tabelas inteiras a cada requisicao. O RLS impediria a escrita, nao o
-- trabalho.
revoke execute on function reconciliar_orfaos(int) from public, anon, authenticated;

-- Varredura a cada minuto: terceira rede de seguranca, depois das duas
-- tentativas em tempo real (captura e webhook do Chatwoot).
--
-- Ao contrario do job de metadata, este nao depende de current_setting
-- nenhum: e SQL puro no proprio banco, sem http e sem configuracao que
-- possa faltar. Nao ha como ele quebrar para sempre esperando um ajuste.
select cron.schedule(
  'reconciliar-touchpoints-orfaos',
  '* * * * *',
  $cron$select reconciliar_orfaos(15)$cron$
);
