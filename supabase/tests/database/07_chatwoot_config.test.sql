-- Configuracao do Chatwoot por tenant: contrato do schema e fechamento
-- da tabela para quem nao e service_role.
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
    extensions.plan(12),

    extensions.lives_ok(
      $$insert into tenants (id, nome, slug) values
          ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a'),
          ('22222222-2222-2222-2222-222222222222', 'Cliente B', 'cliente-b')$$,
      'fixtures: dois tenants'
    ),
    -- base_url e inbox_id ficam de fora de proposito: sao justamente os
    -- dois campos que o operador nao precisa preencher no onboarding.
    extensions.lives_ok(
      $$insert into chatwoot_configs (tenant_id, account_id, token_ref) values
          ('11111111-1111-1111-1111-111111111111', 7, 'CHATWOOT_API_TOKEN'),
          ('22222222-2222-2222-2222-222222222222', 9, 'CHATWOOT_API_TOKEN')$$,
      'fixtures: uma configuracao para cada tenant'
    ),
    extensions.results_eq(
      $$select base_url from chatwoot_configs
         where tenant_id = '11111111-1111-1111-1111-111111111111'$$,
      array['https://chat.leaderaperformance.com.br'::text],
      'config nasce apontando para a instancia do operador'
    ),
    -- inbox_id so aparece quando o primeiro evento do Chatwoot chega; ele
    -- nao pode ser obrigatorio no cadastro, senao o onboarding trava
    -- esperando um dado que ninguem tem ainda.
    extensions.results_eq(
      $$select count(*)::int from chatwoot_configs where inbox_id is null$$,
      array[2::int],
      'inbox_id e opcional no cadastro'
    ),

    -- account_id e token_ref sem valor deixariam a config parecendo
    -- cadastrada e o enriquecimento falhando em silencio na primeira
    -- chamada. Melhor recusar no cadastro.
    extensions.throws_ok(
      $$insert into chatwoot_configs (tenant_id, token_ref)
        values ('11111111-1111-1111-1111-111111111111', 'CHATWOOT_API_TOKEN')$$,
      '23502', null,
      'config sem account_id e recusada'
    ),
    extensions.throws_ok(
      $$insert into chatwoot_configs (tenant_id, account_id)
        values ('11111111-1111-1111-1111-111111111111', 7)$$,
      '23502', null,
      'config sem token_ref e recusada'
    ),
    -- tenant_id e a chave primaria: duas configs para o mesmo cliente
    -- fariam o .single() da captura escolher uma ao acaso.
    extensions.throws_ok(
      $$insert into chatwoot_configs (tenant_id, account_id, token_ref)
        values ('11111111-1111-1111-1111-111111111111', 8, 'OUTRO_TOKEN')$$,
      '23505', null,
      'um tenant nao pode ter duas configuracoes'
    ),

    -- Cliente que sai leva a configuracao junto. Sem o cascade, o delete
    -- do tenant falharia por violacao de chave estrangeira e a remocao
    -- teria que ser manual e na ordem certa.
    extensions.lives_ok(
      $$delete from tenants where id = '22222222-2222-2222-2222-222222222222'$$,
      'apagar o tenant nao esbarra na configuracao'
    ),
    extensions.is_empty(
      $$select * from chatwoot_configs
         where tenant_id = '22222222-2222-2222-2222-222222222222'$$,
      'a configuracao do tenant apagado vai junto'
    ),

    -- Esta tabela nao tem policy de proposito: configuracao de integracao
    -- nao e dado que o cliente precise ler no painel. Mas sem RLS ligado a
    -- protecao seria so a ausencia de grant — e um "grant select on all
    -- tables to authenticated", que e comando comum, abriria a tabela
    -- inteira sem ninguem notar. As duas assercoes abaixo fixam as duas
    -- metades da decisao.
    extensions.results_eq(
      $$select relrowsecurity from pg_class
         where oid = 'public.chatwoot_configs'::regclass$$,
      array[true::boolean],
      'RLS esta ligado, a protecao nao depende de grant'
    ),
    extensions.is_empty(
      $$select policyname from pg_policies
         where schemaname = 'public' and tablename = 'chatwoot_configs'$$,
      'nenhuma policy: so service_role acessa'
    ),

    extensions.diag(set_config('role', 'authenticated', true)),
    extensions.diag(set_config(
      'request.jwt.claims',
      '{"tenant_id":"11111111-1111-1111-1111-111111111111"}', true)),
    -- Nem a propria: o token_ref do cliente nao aparece para ele nem
    -- quando ele pergunta pela linha que e dele.
    extensions.is_empty(
      $$select * from chatwoot_configs
         where tenant_id = '11111111-1111-1111-1111-111111111111'$$,
      'authenticated nao le a configuracao nem do proprio tenant'
    )
  ]) as tap
  union all
  select 2, * from extensions.finish()
) t order by ord
