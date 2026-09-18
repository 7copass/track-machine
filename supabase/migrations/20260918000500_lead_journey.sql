-- Jornada do lead.
--
-- So existe porque ad_touchpoints e append-only. Se a origem fosse campo
-- do contato, cada retorno sobrescreveria o anterior e esta view nao teria
-- o que agregar.
--
-- security_invoker = true nao e detalhe de estilo. Sem ele a view roda com
-- o privilegio de quem a criou -- e quem a cria aqui e o postgres, que tem
-- bypassrls -- de modo que ela contornaria o RLS de ad_touchpoints e
-- devolveria a jornada de todos os clientes a qualquer um que consultasse
-- a view. Em produto com painel por cliente, isso e vazamento entre
-- clientes. Com a flag, o RLS da tabela por baixo vale para quem consulta.
create view lead_journey
with (security_invoker = true)
as
select
  tenant_id,
  phone_match_key,
  max(phone_e164)        as phone_e164,
  count(*)               as total_toques,
  count(distinct ad_id)  as anuncios_distintos,
  min(received_at)       as primeiro_toque_em,
  max(received_at)       as ultimo_toque_em,
  jsonb_agg(
    jsonb_build_object(
      'ad_id',       ad_id,
      'campaign_id', campaign_id,
      'ctwa_clid',   ctwa_clid,
      'quando',      received_at
    ) order by received_at
  ) as linha_do_tempo
from ad_touchpoints
group by tenant_id, phone_match_key;

-- Escolhe qual toque recebe credito por uma conversao.
--
-- Ultimo toque dentro da janela -- mesma regra padrao da Meta, para o
-- relatorio do painel bater com o do Gerenciador em vez de brigar com ele.
--
-- Os toques anteriores continuam gravados e viram credito de assistencia
-- no painel: e o numero que impede o cliente de matar um anuncio de topo
-- que traz o lead mas nao aparece no relatorio de ultimo clique.
create or replace function atribuir_credito(
  p_tenant      uuid,
  p_match_key   text,
  p_quando      timestamptz,
  p_janela_dias int default 7
)
returns uuid
language sql stable
as $$
  select id
    from ad_touchpoints
   where tenant_id       = p_tenant
     and phone_match_key = p_match_key
     and received_at    <= p_quando
     and received_at    >= p_quando - make_interval(days => p_janela_dias)
   order by received_at desc
   limit 1
$$;
