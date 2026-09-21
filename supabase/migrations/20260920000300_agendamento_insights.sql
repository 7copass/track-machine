-- A fila do enriquecimento passa a enxergar o anuncio que gastou.
--
-- Dois buracos, ambos silenciosos:
--
-- 1. A fila so nascia de ad_touchpoints, isto e, de anuncio que GEROU
--    LEAD. A maioria dos que aparecem no gasto nunca gerou: a view de
--    desempenho tinha 103 linhas e 98 saiam com ad_name nulo. O painel
--    mostraria uma lista quase toda em branco — e anuncio que gastou sem
--    trazer ninguem e justamente o que o cliente mais precisa identificar.
--
-- 2. A fila excluia anuncio ja em cache por construcao (`c.ad_id is null`).
--    Coluna nova — act_id, destination_type, optimization_goal — nasceria
--    nula nas linhas ja existentes e NUNCA seria preenchida. Nao e
--    hipotese: as tres linhas de cache ficaram com destination_type nulo, e
--    a view de desempenho caia no coalesce do fuso em carater permanente,
--    com numero certo enquanto as contas coincidissem de fuso — que e
--    exatamente o que faz esse tipo de erro sobreviver meses.
--
-- O corte por data existe para a fila TERMINAR. Sem ele, um anuncio cujo
-- conjunto realmente nao tem destination_type (conjunto apagado, campanha
-- antiga) voltaria para a fila a cada 10 minutos para sempre, queimando
-- rate limit da conta do cliente e disputando as 50 vagas do lote com
-- anuncio novo de verdade. Com o corte, cada linha velha e reprocessada
-- UMA vez: o enriquecimento atualiza atualizado_em e ela sai da fila,
-- tendo a Meta devolvido o campo ou nao.
create or replace view touchpoints_sem_metadata
with (security_invoker = true)
as
with anuncios as (
  -- Anuncio que trouxe lead.
  select distinct tenant_id, ad_id
    from ad_touchpoints
   where ad_id is not null
  union
  -- Anuncio que gastou. Sem esta metade, 98 das 103 linhas da view de
  -- desempenho ficariam sem nome para sempre.
  select distinct tenant_id, ad_id
    from meta_insights_diario
)
select a.tenant_id, a.ad_id
  from anuncios a
  left join ad_metadata_cache c
    on  c.ad_id     = a.ad_id
    and c.tenant_id = a.tenant_id
 where
   -- nunca resolvido
   c.ad_id is null
   -- ou resolvido antes de estas colunas existirem
   or (
     (c.act_id is null or c.destination_type is null)
     and c.atualizado_em < timestamptz '2026-09-21 00:00:00+00'
   );

-- A condicao de campanha ja preenchida no touchpoint saiu de proposito.
-- Quem preenche campaign_id no touchpoint e o proprio enriquecimento, no
-- mesmo ciclo em que grava o cache: mante-la barraria justamente a linha
-- velha que precisa voltar para a fila.

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
