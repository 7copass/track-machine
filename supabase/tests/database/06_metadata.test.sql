-- Fila de enriquecimento de metadata de anuncio e isolamento do cache.
--
-- Formato exigido pelo runner (scripts/run_pgtap.py): a suite inteira
-- precisa ser UMA consulta. Fixtures entram por lives_ok, "set local" vira
-- set_config(...) dentro de diag(), e finish() vem por union all com
-- order by ord para rodar por ultimo. Casts explicitos em toda parte.
--
-- Toda assercao recebe SQL como texto de proposito: is()/ok() com
-- subconsulta inline seriam planejados junto com a consulta externa e
-- leriam o snapshot de antes das fixtures, devolvendo verde mentiroso.

select tap from (
  select 1 as ord, unnest(array[
    extensions.plan(13),

    -- Dois tenants: o segundo existe so para provar que nem a fila nem o
    -- cache entregam o anuncio de um cliente a outro.
    extensions.lives_ok(
      $$insert into tenants (id, nome, slug) values
          ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a'),
          ('22222222-2222-2222-2222-222222222222', 'Cliente B', 'cliente-b')$$,
      'fixtures: dois tenants'
    ),
    -- Cinco touchpoints do tenant A cobrindo as quatro situacoes que a
    -- fila precisa distinguir, mais um do tenant B.
    extensions.lives_ok(
      $$insert into ad_touchpoints
          (tenant_id, wa_message_id, phone_e164, phone_match_key,
           ctwa_clid, ad_id, campaign_id, source_channel,
           received_at, raw_payload)
        values
          ('11111111-1111-1111-1111-111111111111', 'M_PEND1', '+5511900000001',
           '551190000001', 'c1', 'ad_pend_1', null, 'evolution',
           '2026-09-01 10:00:00+00', '{}'::jsonb),
          ('11111111-1111-1111-1111-111111111111', 'M_PEND2', '+5511900000002',
           '551190000002', 'c2', 'ad_pend_2', null, 'evolution',
           '2026-09-01 11:00:00+00', '{}'::jsonb),
          ('11111111-1111-1111-1111-111111111111', 'M_RESOLV', '+5511900000003',
           '551190000003', 'c3', 'ad_resolvido', 'camp_1', 'evolution',
           '2026-09-01 12:00:00+00', '{}'::jsonb),
          ('11111111-1111-1111-1111-111111111111', 'M_CACHE', '+5511900000004',
           '551190000004', 'c4', 'ad_em_cache', null, 'evolution',
           '2026-09-01 13:00:00+00', '{}'::jsonb),
          ('11111111-1111-1111-1111-111111111111', 'M_SEMAD', '+5511900000005',
           '551190000005', 'c5', null, null, 'evolution',
           '2026-09-01 14:00:00+00', '{}'::jsonb),
          ('22222222-2222-2222-2222-222222222222', 'M_B', '+5511999998888',
           '551199998888', 'c9', 'ad_do_b', null, 'evolution',
           '2026-09-01 15:00:00+00', '{}'::jsonb)$$,
      'fixtures: cinco touchpoints do tenant A e um do tenant B'
    ),
    extensions.lives_ok(
      $$insert into ad_metadata_cache
          (ad_id, tenant_id, ad_name, adset_id, campaign_id)
        values
          ('ad_em_cache', '11111111-1111-1111-1111-111111111111',
           'Criativo ja resolvido', 'conj_1', 'camp_9'),
          ('ad_cache_b', '22222222-2222-2222-2222-222222222222',
           'Criativo do outro cliente', 'conj_b', 'camp_b')$$,
      'fixtures: um anuncio ja em cache para cada tenant'
    ),

    -- A fila e o que a funcao de enriquecimento varre. Tudo que ja foi
    -- resolvido precisa sair dela, senao a varredura gasta chamada de
    -- Graph API repetindo anuncio que ja esta no cache.
    extensions.results_eq(
      $$select ad_id from touchpoints_sem_metadata order by ad_id$$,
      array['ad_do_b'::text, 'ad_pend_1', 'ad_pend_2'],
      'a fila traz so os anuncios que ainda faltam resolver'
    ),
    extensions.is_empty(
      $$select * from touchpoints_sem_metadata where ad_id = 'ad_em_cache'$$,
      'anuncio ja no cache sai da fila'
    ),
    extensions.is_empty(
      $$select * from touchpoints_sem_metadata where ad_id = 'ad_resolvido'$$,
      'touchpoint que ja tem campanha sai da fila'
    ),
    extensions.is_empty(
      $$select * from touchpoints_sem_metadata where ad_id is null$$,
      'touchpoint sem anuncio nunca entra na fila'
    ),

    -- adset_id e campaign_id estao fora da trava de append-only
    -- justamente para o enriquecimento poder preenche-los. Se alguem
    -- encolher aquela lista, a varredura para de funcionar e e aqui que
    -- isso aparece.
    extensions.lives_ok(
      $$update ad_touchpoints
           set adset_id = 'conj_novo', campaign_id = 'camp_novo'
         where ad_id = 'ad_pend_1'$$,
      'enriquecimento preenche conjunto e campanha sem bater no append-only'
    ),
    extensions.is_empty(
      $$select * from touchpoints_sem_metadata where ad_id = 'ad_pend_1'$$,
      'anuncio resolvido sai da fila'
    ),

    -- Isolamento. A view roda com security_invoker = true; sem a flag ela
    -- executaria com o privilegio de quem a criou (postgres, que tem
    -- bypassrls) e devolveria a fila de todos os clientes a qualquer um
    -- que consultasse. Verificado por mutacao: desligando a flag, as duas
    -- assercoes abaixo falham.
    extensions.diag(set_config('role', 'authenticated', true)),
    extensions.diag(set_config(
      'request.jwt.claims',
      '{"tenant_id":"11111111-1111-1111-1111-111111111111"}', true)),
    extensions.results_eq(
      $$select ad_id from touchpoints_sem_metadata order by ad_id$$,
      array['ad_pend_2'::text],
      'tenant A enxerga apenas a propria fila'
    ),
    extensions.is_empty(
      $$select * from touchpoints_sem_metadata where ad_id = 'ad_do_b'$$,
      'tenant A nao alcanca a fila do tenant B nem filtrando por ela'
    ),
    extensions.results_eq(
      $$select ad_id from ad_metadata_cache order by ad_id$$,
      array['ad_em_cache'::text],
      'tenant A le apenas o proprio cache'
    ),
    extensions.is_empty(
      $$select * from ad_metadata_cache where ad_id = 'ad_cache_b'$$,
      'tenant A nao alcanca o cache do tenant B nem filtrando por ele'
    )
  ]) as tap
  union all
  select 2, * from extensions.finish()
) t order by ord
