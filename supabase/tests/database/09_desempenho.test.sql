-- Formato exigido pelo runner: a suite inteira e UMA consulta. Fixtures
-- entram por lives_ok, "set local" vira set_config dentro de diag(), e
-- finish() vem por union all com order by ord.
--
-- Asserção só enxerga fixture se receber SQL como TEXTO: results_eq e
-- is_empty abrem cursor novo por EXECUTE. is()/ok() com subconsulta inline
-- leriam o snapshot de ANTES das fixtures e devolveriam verde em silencio.
select tap from (
  select 1 as ord, unnest(array[
    extensions.plan(17),

    extensions.lives_ok(
      $$insert into tenants (id, nome, slug) values
          ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a'),
          ('22222222-2222-2222-2222-222222222222', 'Cliente B', 'cliente-b')$$,
      'fixtures: dois tenants'
    ),
    extensions.lives_ok(
      $$insert into ad_accounts (tenant_id, act_id, nome, timezone)
        values ('11111111-1111-1111-1111-111111111111', 'act_1', 'A',
                'America/Belem')$$,
      'fixtures: conta em America/Belem (UTC-3)'
    ),
    extensions.lives_ok(
      $$insert into ad_metadata_cache
          (tenant_id, ad_id, ad_name, adset_name, campaign_name,
           destination_type, act_id)
        values ('11111111-1111-1111-1111-111111111111', 'ad_1', 'Criativo A',
                'CJ01', 'VAGA', 'WHATSAPP', 'act_1'),
               ('11111111-1111-1111-1111-111111111111', 'ad_zero', 'Criativo Z',
                'CJ02', 'VAGA', 'WHATSAPP', 'act_1')$$,
      'fixtures: dois anuncios com nome'
    ),
    extensions.lives_ok(
      $$insert into meta_insights_diario
          (tenant_id, ad_id, dia, gasto_centavos)
        values ('11111111-1111-1111-1111-111111111111', 'ad_1',
                '2026-09-18', 34000),
               ('11111111-1111-1111-1111-111111111111', 'ad_zero',
                '2026-09-18', 15000)$$,
      'fixtures: gasto em dois anuncios'
    ),

    -- A ARMADILHA: 2026-09-19 00:30 UTC e 2026-09-18 21:30 em Belem.
    -- Agrupado por data UTC este lead cairia em 19/09 e o CPL dos DOIS
    -- dias sairia errado — com o total do mes fechando certo, que e o que
    -- faz o erro sobreviver meses sem ninguem notar.
    extensions.lives_ok(
      $$insert into ad_touchpoints
          (tenant_id, wa_message_id, phone_e164, phone_match_key,
           ad_id, source_channel, received_at, raw_payload)
        values
          ('11111111-1111-1111-1111-111111111111', 'M1', '+5593900000001',
           '559390000001', 'ad_1', 'evolution',
           '2026-09-18 14:00:00+00', '{}'::jsonb),
          ('11111111-1111-1111-1111-111111111111', 'M2', '+5593900000002',
           '559390000002', 'ad_1', 'evolution',
           '2026-09-18 18:00:00+00', '{}'::jsonb),
          ('11111111-1111-1111-1111-111111111111', 'M3', '+5593900000003',
           '559390000003', 'ad_1', 'evolution',
           '2026-09-18 22:00:00+00', '{}'::jsonb),
          ('11111111-1111-1111-1111-111111111111', 'M4', '+5593900000004',
           '559390000004', 'ad_1', 'evolution',
           '2026-09-19 00:30:00+00', '{}'::jsonb)$$,
      'fixtures: quatro leads, um deles depois da meia-noite UTC'
    ),

    extensions.results_eq(
      $$select leads from desempenho_por_anuncio
         where ad_id = 'ad_1' and dia = '2026-09-18'$$,
      array[4::bigint],
      'o lead de 00:30 UTC conta no dia 18, que e o dia dele em Belem'
    ),
    extensions.results_eq(
      $$select cpl_centavos from desempenho_por_anuncio
         where ad_id = 'ad_1' and dia = '2026-09-18'$$,
      array[8500::bigint],
      'CPL: R$ 340,00 divididos por 4 leads dao R$ 85,00'
    ),

    -- Anuncio que gastou e nao trouxe ninguem PRECISA aparecer: e
    -- justamente o que o cliente deve olhar. E o CPL vem nulo, nao
    -- infinito nem erro de divisao.
    extensions.results_eq(
      $$select coalesce(leads, -1) from desempenho_por_anuncio
         where ad_id = 'ad_zero'$$,
      array[0::bigint],
      'anuncio sem lead aparece com zero, nao some da lista'
    ),
    extensions.results_eq(
      $$select cpl_centavos from desempenho_por_anuncio
         where ad_id = 'ad_zero'$$,
      array[null::bigint],
      'CPL sem lead e nulo, nunca infinito'
    ),

    -- Varias contas por cliente e o caso que o operador descreveu desde o
    -- inicio. Sem resolver o fuso pela conta DO ANUNCIO, cada lead seria
    -- contado uma vez por conta do tenant e o CPL cairia pela metade.
    --
    -- A segunda conta esta em America/Noronha (UTC-2), nao em
    -- America/Sao_Paulo: Sao Paulo e Belem tem o MESMO deslocamento desde
    -- que o Brasil acabou com o horario de verao, entao com ela a suite
    -- provaria a nao-duplicacao mas nao provaria que o fuso escolhido foi
    -- o da conta certa. Com uma hora de diferenca, prova as duas coisas.
    extensions.lives_ok(
      $$insert into ad_accounts (tenant_id, act_id, nome, timezone)
        values ('11111111-1111-1111-1111-111111111111', 'act_2', 'Segunda',
                'America/Noronha')$$,
      'fixture: uma segunda conta no mesmo tenant, em outro fuso'
    ),
    extensions.results_eq(
      $$select leads from desempenho_por_anuncio
         where ad_id = 'ad_1' and dia = '2026-09-18'$$,
      array[4::bigint],
      'a segunda conta do tenant nao duplica a contagem de leads'
    ),

    -- Agora um anuncio DA SEGUNDA conta, com gasto nos dois dias e um
    -- unico lead em 2026-09-19 02:30 UTC. Esse instante e 00:30 do dia 19
    -- em Noronha (UTC-2) e 23:30 do dia 18 em Belem (UTC-3): as duas
    -- asserções abaixo so ficam verdes se o fuso vier da conta DESTE
    -- anuncio, e nao da primeira conta do tenant.
    extensions.lives_ok(
      -- CTE que grava, e nao tres comandos separados por ';': lives_ok
      -- passa a string por EXECUTE, que espera UM comando.
      $$with cache as (
          insert into ad_metadata_cache
            (tenant_id, ad_id, ad_name, adset_name, campaign_name,
             destination_type, act_id)
          values ('11111111-1111-1111-1111-111111111111', 'ad_2',
                  'Criativo B', 'CJ03', 'VAGA', 'WHATSAPP', 'act_2')
        ),
        gasto as (
          insert into meta_insights_diario
            (tenant_id, ad_id, dia, gasto_centavos)
          values ('11111111-1111-1111-1111-111111111111', 'ad_2',
                  '2026-09-18', 5000),
                 ('11111111-1111-1111-1111-111111111111', 'ad_2',
                  '2026-09-19', 7000)
        )
        insert into ad_touchpoints
          (tenant_id, wa_message_id, phone_e164, phone_match_key,
           ad_id, source_channel, received_at, raw_payload)
        values ('11111111-1111-1111-1111-111111111111', 'M5', '+5593900000005',
                '559390000005', 'ad_2', 'evolution',
                '2026-09-19 02:30:00+00', '{}'::jsonb)$$,
      'fixtures: anuncio da segunda conta, gasto em dois dias e um lead'
    ),
    extensions.results_eq(
      $$select leads from desempenho_por_anuncio
         where ad_id = 'ad_2' and dia = '2026-09-19'$$,
      array[1::bigint],
      'o lead de 02:30 UTC cai no dia 19 pelo fuso da conta DO anuncio'
    ),
    extensions.results_eq(
      $$select leads from desempenho_por_anuncio
         where ad_id = 'ad_2' and dia = '2026-09-18'$$,
      array[0::bigint],
      'e nao no dia 18, que seria o dia dele no fuso da outra conta'
    ),

    -- Isolamento. O Passo 5 manda verificar por mutacao que
    -- security_invoker = false quebra o isolamento — e sem asserção de
    -- isolamento nenhuma nao ha o que quebrar. O tenant B ganha gasto
    -- proprio para que a mutacao apareca nos DOIS sentidos: com a view
    -- rodando como dona (postgres, bypassrls), cada tenant passaria a ver
    -- tambem a linha do outro.
    extensions.lives_ok(
      $$insert into meta_insights_diario
          (tenant_id, ad_id, dia, gasto_centavos)
        values ('22222222-2222-2222-2222-222222222222', 'ad_b',
                '2026-09-18', 9900)$$,
      'fixture: gasto do tenant B, para o isolamento ter o que vazar'
    ),
    extensions.diag(set_config('role', 'authenticated', true)),
    extensions.diag(set_config(
      'request.jwt.claims',
      '{"tenant_id":"22222222-2222-2222-2222-222222222222"}', true)),
    extensions.results_eq(
      $$select ad_id from (select distinct ad_id from desempenho_por_anuncio) s
         order by ad_id collate "C"$$,
      array['ad_b'::text],
      'tenant B ve so o proprio anuncio, nenhum do tenant A'
    ),

    -- Provar so que o tenant B e barrado nao basta: com a view devolvendo
    -- vazio para todo mundo o teste acima passaria, e o sintoma em
    -- producao seria painel vazio — que o cliente relata como "nao esta
    -- funcionando", nao como erro. A de baixo fecha a outra metade.
    extensions.diag(set_config(
      'request.jwt.claims',
      '{"tenant_id":"11111111-1111-1111-1111-111111111111"}', true)),
    extensions.results_eq(
      $$select ad_id from (select distinct ad_id from desempenho_por_anuncio) s
         order by ad_id collate "C"$$,
      array['ad_1'::text, 'ad_2'::text, 'ad_zero'::text],
      'tenant A ve os proprios tres anuncios, nenhum do tenant B'
    )
  ]) as tap
  union all
  select 2, * from extensions.finish()
) t order by ord
