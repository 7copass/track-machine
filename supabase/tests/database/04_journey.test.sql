-- Jornada do lead recorrente, regra de credito e isolamento da view.
--
-- Formato exigido pelo runner (scripts/run_pgtap.py): a suite inteira
-- precisa ser UMA consulta. Fixtures entram por lives_ok, "set local" vira
-- set_config(...) dentro de diag(), e finish() vem por union all com
-- order by ord para rodar por ultimo. Casts explicitos em toda parte.

select tap from (
  select 1 as ord, unnest(array[
    extensions.plan(8),

    -- Dois tenants: o segundo existe so para provar que a view nao
    -- entrega a jornada dele a quem nao e dele.
    extensions.lives_ok(
      $$insert into tenants (id, nome, slug) values
          ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a'),
          ('22222222-2222-2222-2222-222222222222', 'Cliente B', 'cliente-b')$$,
      'fixtures: dois tenants'
    ),
    -- Um lead que entrou tres vezes, por tres anuncios diferentes,
    -- mais um lead do tenant B com chave de join propria.
    extensions.lives_ok(
      $$insert into ad_touchpoints
          (tenant_id, wa_message_id, phone_e164, phone_match_key,
           ctwa_clid, ad_id, source_channel, received_at, raw_payload)
        values
          ('11111111-1111-1111-1111-111111111111', 'M1', '+5511987654321',
           '551187654321', 'c1', 'ad_A', 'evolution',
           '2026-09-01 10:00:00+00', '{}'::jsonb),
          ('11111111-1111-1111-1111-111111111111', 'M2', '+5511987654321',
           '551187654321', 'c2', 'ad_B', 'evolution',
           '2026-09-01 15:00:00+00', '{}'::jsonb),
          ('11111111-1111-1111-1111-111111111111', 'M3', '+5511987654321',
           '551187654321', 'c3', 'ad_C', 'evolution',
           '2026-09-10 09:00:00+00', '{}'::jsonb),
          ('22222222-2222-2222-2222-222222222222', 'M9', '+5511999998888',
           '551199998888', 'c9', 'ad_Z', 'evolution',
           '2026-09-05 11:00:00+00', '{}'::jsonb)$$,
      'fixtures: lead recorrente com tres toques, e um lead do tenant B'
    ),

    extensions.results_eq(
      $$select total_toques::int from lead_journey
         where phone_match_key = '551187654321'$$,
      array[3],
      'conta quantas vezes o lead entrou por anuncio'
    ),
    extensions.results_eq(
      $$select primeiro_toque_em from lead_journey
         where phone_match_key = '551187654321'$$,
      array['2026-09-01 10:00:00+00'::timestamptz],
      'guarda o primeiro toque, que a sobrescrita teria perdido'
    ),

    -- Credito: venda em 12/09, janela de 7 dias -> ultimo toque dentro dela
    extensions.results_eq(
      $$select ad_id from ad_touchpoints
         where id = atribuir_credito(
           '11111111-1111-1111-1111-111111111111'::uuid,
           '551187654321'::text,
           '2026-09-12 14:00:00+00'::timestamptz, 7)$$,
      array['ad_C'::text],
      'credito vai para o ultimo toque dentro da janela'
    ),
    -- Venda em 25/09: todos os toques ficaram fora da janela
    extensions.results_eq(
      $$select atribuir_credito(
           '11111111-1111-1111-1111-111111111111'::uuid,
           '551187654321'::text,
           '2026-09-25 14:00:00+00'::timestamptz, 7)$$,
      array[null::uuid],
      'nao atribui credito a toque fora da janela'
    ),

    -- Isolamento da view. Nao esta no plano, mas e a mesma classe de risco
    -- que o teste 5 da Tarefa 1 cobre para as tabelas: view sem
    -- security_invoker roda com o privilegio de quem a criou -- e quem a
    -- criou (postgres) tem bypassrls -- entao ela devolveria a jornada de
    -- todos os clientes por baixo do RLS da tabela.
    extensions.diag(set_config('role', 'authenticated', true)),
    extensions.diag(set_config(
      'request.jwt.claims',
      '{"tenant_id":"11111111-1111-1111-1111-111111111111"}', true)),
    extensions.results_eq(
      $$select phone_match_key from lead_journey order by phone_match_key$$,
      array['551187654321'::text],
      'tenant A enxerga apenas a jornada dos proprios leads'
    ),
    extensions.is_empty(
      $$select * from lead_journey where phone_match_key = '551199998888'$$,
      'tenant A nao alcanca a jornada do tenant B nem filtrando por ela'
    )
  ]) as tap
  union all
  select 2, * from extensions.finish()
) t order by ord
