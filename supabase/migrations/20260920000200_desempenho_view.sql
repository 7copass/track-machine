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
