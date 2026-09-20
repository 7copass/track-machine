-- Formato exigido pelo runner: a suite inteira e UMA consulta. Fixtures
-- entram por lives_ok, "set local" vira set_config dentro de diag(), e
-- finish() vem por union all com order by ord.
select tap from (
  select 1 as ord, unnest(array[
    extensions.plan(10),

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
    )
  ]) as tap
  union all
  select 2, * from extensions.finish()
) t order by ord
