-- Nucleo de touchpoints: idempotencia, append-only e isolamento.
--
-- Formato exigido pelo runner (scripts/run_pgtap.py): a suite inteira
-- precisa ser UMA consulta. Fixtures entram por lives_ok, "set local" vira
-- set_config(...) dentro de diag(), e finish() vem por union all com
-- order by ord para rodar por ultimo. Casts explicitos em toda parte.

select tap from (
  select 1 as ord, unnest(array[
    extensions.plan(11),

    extensions.lives_ok(
      $$insert into tenants (id, nome, slug) values
          ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a'),
          ('22222222-2222-2222-2222-222222222222', 'Cliente B', 'cliente-b')$$,
      'fixtures: dois tenants'
    ),
    extensions.lives_ok(
      $$insert into ad_touchpoints
          (tenant_id, wa_message_id, phone_e164, phone_match_key,
           ctwa_clid, ad_id, source_channel, received_at, raw_payload)
        values
          ('11111111-1111-1111-1111-111111111111', 'MSG_A1', '+5511900000001',
           '551190000001', 'clid_a1', 'ad_1', 'evolution', now(), '{}'::jsonb),
          ('22222222-2222-2222-2222-222222222222', 'MSG_B1', '+5511900000002',
           '551190000002', 'clid_b1', 'ad_2', 'evolution', now(), '{}'::jsonb)$$,
      'fixtures: um touchpoint para cada tenant'
    ),

    -- Idempotencia: o Evolution reenvia webhook, e reenvia sempre
    extensions.lives_ok(
      $$insert into ad_touchpoints
          (tenant_id, wa_message_id, phone_e164, phone_match_key,
           source_channel, received_at, raw_payload)
        values
          ('11111111-1111-1111-1111-111111111111', 'MSG_A1', '+5511900000001',
           '551190000001', 'evolution', now(), '{}'::jsonb)
        on conflict (tenant_id, wa_message_id) do nothing$$,
      'reenvio do mesmo webhook nao estoura'
    ),
    -- A contagem vai por results_eq, com o SQL em texto, e nao por is()
    -- sobre uma subconsulta: subconsulta escrita direto aqui e avaliada no
    -- snapshot da consulta externa, tirado antes de qualquer lives_ok rodar,
    -- e enxergaria a tabela vazia. So a assercao que recebe SQL como texto
    -- abre consulta nova e ve as fixtures.
    extensions.results_eq(
      $$select count(*)::int from ad_touchpoints where wa_message_id = 'MSG_A1'$$,
      array[1::int],
      'reenvio do mesmo webhook nao duplica o lead'
    ),

    -- Append-only: alterar a origem e bloqueado pelo trigger
    extensions.throws_ok(
      $$update ad_touchpoints set ad_id = 'outro' where wa_message_id = 'MSG_A1'$$,
      'P0001', null,
      'alterar a origem de um touchpoint e bloqueado'
    ),
    -- Campos de reconciliacao seguem alteraveis
    extensions.lives_ok(
      $$update ad_touchpoints
           set chatwoot_contact_id = 42, reconciled_at = now()
         where wa_message_id = 'MSG_A1'$$,
      'campos de reconciliacao permanecem alteraveis'
    ),

    -- Telefone nulo: JID @lid nao e telefone, mas o touchpoint vale pelo
    -- ctwa_clid, que e o que a Fatia C devolve a Meta.
    extensions.lives_ok(
      $$insert into ad_touchpoints
          (tenant_id, wa_message_id, phone_e164, phone_match_key,
           ctwa_clid, ad_id, source_channel, received_at, raw_payload)
        values ('11111111-1111-1111-1111-111111111111', 'MSG_LID',
                null, null, 'clid_lid', 'ad_9', 'evolution',
                now(), '{}'::jsonb)$$,
      'touchpoint sem telefone e aceito'
    ),

    -- A trava e por lista do que PODE mudar. Estes tres provam a
    -- amplitude: nenhum deles esta entre os 5 alteraveis.
    extensions.throws_ok(
      $$update ad_touchpoints
           set tenant_id = '22222222-2222-2222-2222-222222222222'
         where wa_message_id = 'MSG_A1'$$,
      'P0001', null,
      'mover um lead de tenant e bloqueado'
    ),
    extensions.throws_ok(
      $$update ad_touchpoints set from_me = true
         where wa_message_id = 'MSG_A1'$$,
      'P0001', null,
      'coluna nova nasce protegida, sem precisar entrar em lista'
    ),
    extensions.throws_ok(
      $$update ad_touchpoints set phone_match_key = 'outro'
         where wa_message_id = 'MSG_A1'$$,
      'P0001', null,
      'chave de join tambem e congelada'
    ),

    -- Isolamento
    extensions.diag(set_config('role', 'authenticated', true)),
    extensions.diag(set_config(
      'request.jwt.claims',
      '{"tenant_id":"11111111-1111-1111-1111-111111111111"}', true)),
    extensions.is_empty(
      $$select * from ad_touchpoints where wa_message_id = 'MSG_B1'$$,
      'tenant A nao alcanca touchpoint do tenant B'
    )
  ]) as tap
  union all
  select 2, * from extensions.finish()
) t order by ord
