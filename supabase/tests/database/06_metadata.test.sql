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
    extensions.plan(21),

    -- Dois tenants: o segundo existe so para provar que nem a fila nem o
    -- cache entregam o anuncio de um cliente a outro.
    extensions.lives_ok(
      $$insert into tenants (id, nome, slug) values
          ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a'),
          ('22222222-2222-2222-2222-222222222222', 'Cliente B', 'cliente-b')$$,
      'fixtures: dois tenants'
    ),
    -- Cinco touchpoints do tenant A cobrindo as situacoes que a fila
    -- precisa distinguir, mais um do tenant B.
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
    -- Tres estados de cache que a fila tem de distinguir:
    --   ad_em_cache      resolvido AGORA, ainda sem as colunas novas
    --   ad_cache_velho   resolvido ANTES de as colunas existirem
    --   ad_cache_completo resolvido antes, mas ja com tudo preenchido
    extensions.lives_ok(
      $$insert into ad_metadata_cache
          (ad_id, tenant_id, ad_name, adset_id, campaign_id,
           act_id, destination_type, atualizado_em)
        values
          ('ad_em_cache', '11111111-1111-1111-1111-111111111111',
           'Criativo ja resolvido', 'conj_1', 'camp_9',
           null, null, now()),
          ('ad_cache_velho', '11111111-1111-1111-1111-111111111111',
           'Criativo antigo', 'conj_2', 'camp_8',
           null, null, '2026-09-19 10:00:00+00'),
          ('ad_cache_completo', '11111111-1111-1111-1111-111111111111',
           'Criativo completo', 'conj_3', 'camp_7',
           'act_1', 'WHATSAPP', '2026-09-19 10:00:00+00'),
          ('ad_cache_b', '22222222-2222-2222-2222-222222222222',
           'Criativo do outro cliente', 'conj_b', 'camp_b',
           null, null, now())$$,
      'fixtures: cache em tres estados para o tenant A e um para o B'
    ),
    -- Gasto sem lead. E daqui que vinham as 98 linhas sem nome: o anuncio
    -- aparece no gasto e nunca gerou touchpoint, entao a fila antiga —
    -- que so nascia de ad_touchpoints — nunca o alcancava.
    extensions.lives_ok(
      $$insert into meta_insights_diario
          (tenant_id, ad_id, dia, gasto_centavos)
        values
          ('11111111-1111-1111-1111-111111111111', 'ad_so_gasto',
           '2026-09-18', 15000),
          ('11111111-1111-1111-1111-111111111111', 'ad_cache_velho',
           '2026-09-18', 9000),
          ('11111111-1111-1111-1111-111111111111', 'ad_cache_completo',
           '2026-09-18', 8000),
          ('22222222-2222-2222-2222-222222222222', 'ad_gasto_b',
           '2026-09-18', 7000)$$,
      'fixtures: gasto de anuncios que nunca geraram lead'
    ),

    -- A fila e o que a funcao de enriquecimento varre. Tudo que ja foi
    -- resolvido precisa sair dela, senao a varredura gasta chamada de
    -- Graph API repetindo anuncio que ja esta no cache.
    -- Escopado aos tenants da fixture. Sem isso a assercao compara o
    -- conteudo INTEIRO da view contra sete ad_id inventados — e o banco
    -- tem 839 anuncios reais de producao. Pior que quebrar: fica
    -- intermitente, verde quando o cron drena a fila e vermelha no
    -- proximo anuncio novo, treinando quem olha a suite a ignorar o
    -- vermelho.
    extensions.results_eq(
      $$select ad_id from touchpoints_sem_metadata
         where tenant_id in ('11111111-1111-1111-1111-111111111111',
                             '22222222-2222-2222-2222-222222222222')
         order by ad_id$$,
      array['ad_cache_velho'::text, 'ad_do_b', 'ad_gasto_b', 'ad_pend_1',
            'ad_pend_2', 'ad_resolvido', 'ad_so_gasto'],
      'a fila traz quem trouxe lead e quem so gastou, e mais ninguem'
    ),

    -- O caso que motivou a mudanca: 98 das 103 linhas da view de
    -- desempenho saiam sem nome porque o anuncio gastou e nunca gerou
    -- touchpoint. Anuncio que gastou sem trazer ninguem e justamente o
    -- que o cliente precisa identificar.
    extensions.results_eq(
      $$select ad_id from touchpoints_sem_metadata
         where ad_id = 'ad_so_gasto'$$,
      array['ad_so_gasto'::text],
      'anuncio que so gastou, sem lead nenhum, entra na fila'
    ),

    -- Coluna nova em linha ja cacheada ficaria nula para sempre: a fila
    -- excluia por construcao tudo que ja estivesse no cache.
    extensions.results_eq(
      $$select ad_id from touchpoints_sem_metadata
         where ad_id = 'ad_cache_velho'$$,
      array['ad_cache_velho'::text],
      'linha em cache desde antes das colunas novas volta para a fila'
    ),
    extensions.is_empty(
      $$select * from touchpoints_sem_metadata
         where ad_id = 'ad_cache_completo'$$,
      'linha antiga ja completa nao volta: nao se re-enriquece a toa'
    ),
    -- A outra metade da mesma moeda. Sem o corte por data, um anuncio
    -- cujo conjunto realmente nao tem destination_type voltaria para a
    -- fila a cada 10 minutos para sempre, queimando rate limit e
    -- disputando as 50 vagas do lote com anuncio novo de verdade.
    extensions.is_empty(
      $$select * from touchpoints_sem_metadata where ad_id = 'ad_em_cache'$$,
      'anuncio recem-resolvido nao volta para a fila, mesmo sem as colunas'
    ),

    extensions.is_empty(
      $$select * from touchpoints_sem_metadata where ad_id is null$$,
      'touchpoint sem anuncio nunca entra na fila'
    ),
    -- Quem preenche campaign_id no touchpoint e o proprio enriquecimento,
    -- no mesmo ciclo em que grava o cache. Filtrar por ele barraria
    -- justamente a linha velha que precisa voltar — por isso o que decide
    -- e o cache, nao o touchpoint.
    extensions.results_eq(
      $$select ad_id from touchpoints_sem_metadata
         where ad_id = 'ad_resolvido'$$,
      array['ad_resolvido'::text],
      'o que tira da fila e o cache gravado, nao a campanha no touchpoint'
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
    extensions.lives_ok(
      $$insert into ad_metadata_cache
          (ad_id, tenant_id, ad_name, act_id, destination_type)
        values ('ad_pend_1', '11111111-1111-1111-1111-111111111111',
                'Criativo resolvido agora', 'act_1', 'WHATSAPP')$$,
      'enriquecimento grava o cache do anuncio que acabou de resolver'
    ),
    extensions.is_empty(
      $$select * from touchpoints_sem_metadata where ad_id = 'ad_pend_1'$$,
      'anuncio resolvido sai da fila'
    ),

    -- Isolamento. A view roda com security_invoker = true; sem a flag ela
    -- executaria com o privilegio de quem a criou (postgres, que tem
    -- bypassrls) e devolveria a fila de todos os clientes a qualquer um
    -- que consultasse. Verificado por mutacao: desligando a flag, as
    -- assercoes abaixo falham.
    -- A PK era so ad_id, global. A tabela tem tenant_id (o RLS precisa),
    -- mas a chave nao o incluia — o schema afirmava uma unicidade que nao
    -- correspondia ao isolamento. Na pratica ad_id da Meta e unico por
    -- conta, mas chave incoerente e divida que cobra juros depois.
    extensions.lives_ok(
      $$insert into ad_metadata_cache (tenant_id, ad_id, ad_name, campaign_id)
        values ('22222222-2222-2222-2222-222222222222', 'ad_compartilhado',
                'Visto pelo B', 'camp_b'),
               ('11111111-1111-1111-1111-111111111111', 'ad_compartilhado',
                'Visto pelo A', 'camp_a')$$,
      'o mesmo ad_id pode existir para dois tenants'
    ),
    extensions.results_eq(
      $$select ad_name from ad_metadata_cache
         where tenant_id = '11111111-1111-1111-1111-111111111111'
           and ad_id = 'ad_compartilhado'$$,
      array['Visto pelo A'::text],
      'cada tenant le a propria entrada de cache do mesmo ad_id'
    ),

    extensions.diag(set_config('role', 'authenticated', true)),
    extensions.diag(set_config(
      'request.jwt.claims',
      '{"tenant_id":"11111111-1111-1111-1111-111111111111"}', true)),
    extensions.results_eq(
      $$select ad_id from touchpoints_sem_metadata order by ad_id$$,
      array['ad_cache_velho'::text, 'ad_pend_2', 'ad_resolvido',
            'ad_so_gasto'],
      'tenant A enxerga apenas a propria fila'
    ),
    extensions.is_empty(
      $$select * from touchpoints_sem_metadata where ad_id = 'ad_do_b'$$,
      'tenant A nao alcanca a fila do tenant B nem filtrando por ela'
    ),
    -- A origem nova precisa do mesmo isolamento: meta_insights_diario
    -- entrou na view, e sem RLS valendo ali o gasto do outro cliente
    -- apareceria na fila deste.
    extensions.is_empty(
      $$select * from touchpoints_sem_metadata where ad_id = 'ad_gasto_b'$$,
      'o gasto do tenant B nao aparece na fila do tenant A'
    ),
    extensions.results_eq(
      $$select ad_id from ad_metadata_cache order by ad_id$$,
      array['ad_cache_completo'::text, 'ad_cache_velho', 'ad_compartilhado',
            'ad_em_cache', 'ad_pend_1'],
      'tenant A le so o proprio cache, inclusive do ad_id que o B tambem tem'
    ),
    extensions.is_empty(
      $$select * from ad_metadata_cache where ad_id = 'ad_cache_b'$$,
      'tenant A nao alcanca o cache do tenant B nem filtrando por ele'
    )
  ]) as tap
  union all
  select 2, * from extensions.finish()
) t order by ord
