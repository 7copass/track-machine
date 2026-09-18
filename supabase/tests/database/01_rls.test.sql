-- Isolamento entre tenants, provado por execucao.
--
-- Formato: o runner (scripts/run_pgtap.py) envolve este arquivo num
-- "for linha in <consulta> loop", entao a suite inteira precisa ser UMA
-- consulta. Daqui saem tres adaptacoes:
--
--   1. As fixtures entram como extensions.lives_ok($$insert ...$$): e o
--      unico jeito de executar comando dentro de uma expressao, e cada
--      chamada pgTAP abre nova consulta interna, entao a assercao
--      seguinte ja enxerga as linhas inseridas.
--   2. "set local role" vira set_config('role', ..., true), a forma
--      funcional do mesmo comando, embrulhada em diag() para sair como
--      comentario TAP em vez de linha solta no relatorio.
--   3. finish() devolve setof text e nao cabe no array; vem por union all
--      com "order by ord" garantindo que roda por ultimo.
--
-- Casts explicitos de tipo em toda parte: sem eles o Postgres nao resolve
-- os parametros polimorficos do pgTAP.
select tap from (
  select 1 as ord, unnest(array[
    extensions.plan(6),

    -- Dois tenants e uma conta de anuncio para cada um
    extensions.lives_ok(
      $$insert into tenants (id, nome, slug) values
          ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a'),
          ('22222222-2222-2222-2222-222222222222', 'Cliente B', 'cliente-b')$$,
      'fixtures: dois tenants cadastrados'
    ),
    extensions.lives_ok(
      $$insert into ad_accounts (tenant_id, act_id, nome) values
          ('11111111-1111-1111-1111-111111111111', 'act_111', 'Conta A'),
          ('22222222-2222-2222-2222-222222222222', 'act_222', 'Conta B')$$,
      'fixtures: uma conta de anuncio para cada tenant'
    ),

    -- Papel anonimo nao enxerga nada
    extensions.diag(set_config('role', 'anon', true)),
    extensions.is_empty(
      'select * from ad_accounts',
      'anon nao le nenhuma conta de anuncio'
    ),

    -- Tenant A autenticado enxerga so o que e dele
    extensions.diag(set_config('role', 'authenticated', true)),
    extensions.diag(set_config(
      'request.jwt.claims',
      '{"tenant_id":"11111111-1111-1111-1111-111111111111"}',
      true
    )),
    extensions.results_eq(
      'select act_id from ad_accounts',
      array['act_111'::text],
      'tenant A enxerga apenas a propria conta'
    ),
    extensions.is_empty(
      $$select * from ad_accounts where act_id = 'act_222'$$,
      'tenant A nao alcanca a conta do tenant B nem filtrando por ela'
    ),

    -- Tenant B enxerga o dele
    extensions.diag(set_config(
      'request.jwt.claims',
      '{"tenant_id":"22222222-2222-2222-2222-222222222222"}',
      true
    )),
    extensions.results_eq(
      'select act_id from ad_accounts',
      array['act_222'::text],
      'tenant B enxerga apenas a propria conta'
    )
  ]) as tap
  union all
  select 2, * from extensions.finish()
) t order by ord
