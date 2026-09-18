-- Cache de metadata de anuncio.
--
-- O payload do Evolution traz so o ad_id. Campanha, conjunto e nomes
-- legiveis vem de uma consulta a Graph API -- uma vez por anuncio, e
-- depois e cache. Sem o cache, cada varredura repetiria a mesma chamada
-- para o mesmo anuncio e gastaria o rate limit da conta do cliente.

-- pg_cron e pg_net entram aqui porque esta e a primeira migration que
-- agenda trabalho no banco. "if not exists" mantem idempotente para as
-- migrations de monitoramento, que dependem das mesmas duas.
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table ad_metadata_cache (
  ad_id          text primary key,
  tenant_id      uuid not null references tenants(id) on delete cascade,
  ad_name        text,
  adset_id       text,
  adset_name     text,
  campaign_id    text,
  campaign_name  text,
  objetivo       text,
  atualizado_em  timestamptz not null default now()
);

alter table ad_metadata_cache enable row level security;

create policy tenant_le_o_proprio_cache on ad_metadata_cache
  for select to authenticated
  using (tenant_id = current_tenant_id());

-- Touchpoints ainda sem campanha resolvida. A funcao de enriquecimento
-- varre esta lista; enquanto nao houver token da Meta configurado, ela
-- fica parada sem quebrar nada.
--
-- security_invoker = true nao e detalhe de estilo. Sem ele a view roda com
-- o privilegio de quem a criou -- e quem a cria aqui e o postgres, que tem
-- bypassrls -- de modo que ela contornaria o RLS de ad_touchpoints e
-- entregaria a fila de todos os clientes a qualquer um que consultasse.
-- Com a flag, o RLS das tabelas por baixo vale para quem consulta.
create view touchpoints_sem_metadata
with (security_invoker = true)
as
select distinct t.tenant_id, t.ad_id
  from ad_touchpoints t
  left join ad_metadata_cache c on c.ad_id = t.ad_id
 where t.ad_id is not null
   and t.campaign_id is null
   and c.ad_id is null;

-- De 10 em 10 minutos. Anuncio novo aparece no painel com nome legivel
-- em ate 10 minutos; nao ha urgencia porque o lead ja foi capturado.
--
-- O "where" no fim nao esta no plano e foi acrescentado de proposito: sem
-- ele, num projeto onde app.functions_base_url ainda nao foi configurado,
-- current_setting devolve null, a url vira null e o job erra a cada 10
-- minutos para sempre, enchendo cron.job_run_details de ruido. Com o
-- guarda, o job fica registrado e simplesmente nao dispara ate a
-- configuracao existir -- que e o comportamento que o plano descreve em
-- texto ("fica parada sem quebrar nada").
select cron.schedule(
  'enriquecer-metadata-de-anuncio',
  '*/10 * * * *',
  $cron$
  select net.http_post(
      url := current_setting('app.functions_base_url', true)
             || '/enrich-ad-metadata',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || current_setting('app.service_role_key', true)
      )
    )
   where coalesce(current_setting('app.functions_base_url', true), '') <> ''
     and coalesce(current_setting('app.service_role_key', true), '') <> ''
  $cron$
);
