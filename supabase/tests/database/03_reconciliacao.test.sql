-- Reconciliacao entre touchpoint do Evolution e conversa do Chatwoot.
--
-- Formato exigido pelo runner (scripts/run_pgtap.py): a suite inteira
-- precisa ser UMA consulta. Fixtures entram por lives_ok, "set local" vira
-- set_config(...) dentro de diag(), e finish() vem por union all com
-- order by ord para rodar por ultimo. Casts explicitos em toda parte.
--
-- Toda assercao recebe SQL como texto de proposito: is()/ok() com
-- subconsulta inline seriam planejados junto com a consulta externa e
-- leriam o snapshot de antes das fixtures, devolvendo verde mentiroso.
--
-- A reconciliacao roda por pg_cron (usuario postgres) e por RPC do webhook
-- (service_role). Os dois contornam RLS, entao o unico freio contra ligar o
-- lead de um cliente a conversa de outro e a condicao de tenant dentro do
-- JOIN. E por isso que o caso cruzado abaixo existe.

select tap from (
  select 1 as ord, unnest(array[
    extensions.plan(17),

    -- Dois tenants: o segundo existe so para provar que a reconciliacao
    -- nao atravessa a fronteira entre clientes.
    extensions.lives_ok(
      $$insert into tenants (id, nome, slug) values
          ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a'),
          ('22222222-2222-2222-2222-222222222222', 'Cliente B', 'cliente-b')$$,
      'fixtures: dois tenants'
    ),

    -- ─── Caso 1: Evolution chegou antes, Chatwoot depois ───────────
    extensions.lives_ok(
      $$insert into ad_touchpoints
          (tenant_id, wa_message_id, phone_e164, phone_match_key,
           ctwa_clid, ad_id, source_channel, received_at, raw_payload)
        values ('11111111-1111-1111-1111-111111111111', 'MSG_1',
                '+5511987654321', '551187654321', 'clid_1', 'ad_1',
                'evolution', now() - interval '2 minutes', '{}'::jsonb);
        insert into chatwoot_conversations
          (id, tenant_id, contact_id, phone_e164, phone_match_key, criada_em)
        values (9001, '11111111-1111-1111-1111-111111111111', 501,
                '+5511987654321', '551187654321', now() - interval '1 minute')$$,
      'fixtures: touchpoint orfao e conversa correspondente'
    ),
    extensions.results_eq(
      $$select reconciliar_orfaos(15)$$, array[1::int],
      'reconcilia o touchpoint orfao com a conversa'
    ),
    extensions.results_eq(
      $$select chatwoot_conversation_id from ad_touchpoints
         where wa_message_id = 'MSG_1'$$,
      array[9001::bigint],
      'o vinculo aponta para a conversa correta'
    ),
    -- O contato vem junto porque e ele que a Fatia C usa para escrever a
    -- origem de volta no Chatwoot. Ligar so a conversa deixaria o lead
    -- reconciliado e mesmo assim sem onde gravar a atribuicao.
    extensions.results_eq(
      $$select chatwoot_contact_id from ad_touchpoints
         where wa_message_id = 'MSG_1'$$,
      array[501::bigint],
      'o contato do Chatwoot vem junto com a conversa'
    ),
    -- reconciled_at e o que tira o touchpoint da fila. Sem ele, a varredura
    -- de cada minuto reescreveria as mesmas linhas para sempre.
    extensions.is_empty(
      $$select 1 from ad_touchpoints
         where wa_message_id = 'MSG_1' and reconciled_at is null$$,
      'touchpoint reconciliado sai da fila de orfaos'
    ),

    -- ─── Caso 2: grafia divergente e conversa fora da janela ───────
    extensions.lives_ok(
      $$insert into ad_touchpoints
          (tenant_id, wa_message_id, phone_e164, phone_match_key,
           ctwa_clid, ad_id, source_channel, received_at, raw_payload)
        values ('11111111-1111-1111-1111-111111111111', 'MSG_2',
                '+5511912345678', '551112345678', 'clid_2', 'ad_2',
                'evolution', now() - interval '2 minutes', '{}'::jsonb),
               ('11111111-1111-1111-1111-111111111111', 'MSG_3',
                '+5511955554444', '551155554444', 'clid_3', 'ad_3',
                'evolution', now() - interval '5 hours', '{}'::jsonb);
        insert into chatwoot_conversations
          (id, tenant_id, contact_id, phone_e164, phone_match_key, criada_em)
        values (9002, '11111111-1111-1111-1111-111111111111', 502,
                '+551112345678', '551112345678', now() - interval '1 minute'),
               (9003, '11111111-1111-1111-1111-111111111111', 503,
                '+5511955554444', '551155554444', now())$$,
      'fixtures: grafia divergente e conversa fora da janela'
    ),
    extensions.results_eq(
      $$select reconciliar_orfaos(15)$$, array[1::int],
      'casa grafias diferentes e ignora conversa fora da janela'
    ),
    -- A contagem sozinha nao distingue "casou o certo" de "casou o errado":
    -- ligar MSG_3 em vez de MSG_2 tambem devolveria 1.
    extensions.results_eq(
      $$select chatwoot_conversation_id from ad_touchpoints
         where wa_message_id = 'MSG_2'$$,
      array[9002::bigint],
      'quem casou foi o lead escrito sem o nono digito do outro lado'
    ),
    extensions.is_empty(
      $$select 1 from ad_touchpoints
         where wa_message_id = 'MSG_3'
           and chatwoot_conversation_id is not null$$,
      'conversa aberta 5 horas depois nao e vinculada ao toque'
    ),

    -- ─── Caso 3: mesmo telefone, cliente diferente ────────────────
    -- O id 9001 se repete de proposito: id de conversa do Chatwoot e
    -- sequencial por conta, e cada tenant e uma conta. Se a chave fosse so
    -- o id, esta insercao sobrescreveria a conversa do tenant A.
    extensions.lives_ok(
      $$insert into ad_touchpoints
          (tenant_id, wa_message_id, phone_e164, phone_match_key,
           ctwa_clid, ad_id, source_channel, received_at, raw_payload)
        values ('11111111-1111-1111-1111-111111111111', 'MSG_4',
                '+5511977776666', '551177776666', 'clid_4', 'ad_4',
                'evolution', now() - interval '2 minutes', '{}'::jsonb);
        insert into chatwoot_conversations
          (id, tenant_id, contact_id, phone_e164, phone_match_key, criada_em)
        values (9001, '22222222-2222-2222-2222-222222222222', 601,
                '+5511977776666', '551177776666', now() - interval '1 minute')$$,
      'fixtures: o mesmo id de conversa existe para dois tenants'
    ),
    -- Zero cobre duas garantias de uma vez: a conversa do tenant B nao
    -- alcanca o toque do tenant A, e os dois ja reconciliados nao voltam
    -- para a fila. Tirar a condicao de tenant do JOIN, ou o filtro de
    -- reconciled_at, faz esta assercao ficar vermelha.
    extensions.results_eq(
      $$select reconciliar_orfaos(15)$$, array[0::int],
      'nao casa com conversa de outro tenant nem refaz o que ja foi ligado'
    ),
    extensions.is_empty(
      $$select 1 from ad_touchpoints
         where wa_message_id = 'MSG_4'
           and chatwoot_conversation_id is not null$$,
      'touchpoint de um cliente nunca aponta para conversa de outro'
    ),

    -- Terceira rede de seguranca: se o job sumir, as duas tentativas em
    -- tempo real continuam funcionando e ninguem percebe que o que
    -- escapou parou de ser recuperado.
    extensions.results_eq(
      $$select schedule from cron.job
         where jobname = 'reconciliar-touchpoints-orfaos'$$,
      array['* * * * *'::text],
      'a varredura de orfaos esta agendada de minuto em minuto'
    ),

    -- ─── Isolamento no painel ─────────────────────────────────────
    -- Verificado por mutacao: com "alter table chatwoot_conversations
    -- disable row level security" dentro da suite, as duas assercoes
    -- abaixo ficam vermelhas; apagando a policy, so a primeira.
    extensions.diag(set_config('role', 'authenticated', true)),
    extensions.diag(set_config(
      'request.jwt.claims',
      '{"tenant_id":"11111111-1111-1111-1111-111111111111"}', true)),
    extensions.results_eq(
      $$select id from chatwoot_conversations order by id$$,
      array[9001::bigint, 9002::bigint, 9003::bigint],
      'tenant A le as proprias conversas'
    ),
    extensions.is_empty(
      $$select * from chatwoot_conversations
         where tenant_id = '22222222-2222-2222-2222-222222222222'$$,
      'tenant A nao alcanca a conversa do tenant B nem filtrando por ela'
    ),
    -- O PostgREST publica toda funcao do schema public como RPC, e os
    -- grants padrao do Supabase alcancam anon e authenticated. O RLS
    -- impediria a escrita, mas nao o trabalho: sem o revoke, quem tiver a
    -- chave anon dispara um join sobre as duas tabelas inteiras de graca.
    extensions.throws_ok(
      $$select reconciliar_orfaos(15)$$,
      '42501', null,
      'reconciliacao nao e RPC aberta ao painel'
    )
  ]) as tap
  union all
  select 2, * from extensions.finish()
) t order by ord
