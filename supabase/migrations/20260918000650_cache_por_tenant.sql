-- Chave do cache de metadata passa a incluir o tenant.
--
-- A tabela nasceu com PK so em ad_id, global, mas com tenant_id not null
-- porque o RLS precisa dele. As duas coisas nao combinam: a chave afirmava
-- uma unicidade global enquanto o resto da tabela e por tenant.
--
-- Na pratica o ad_id da Meta e unico por conta de anuncio, entao a colisao
-- e improvavel. Mas o join da fila era por ad_id sozinho, e sob service_role
-- (que ignora RLS) o cache de um cliente podia tirar da fila o touchpoint de
-- outro. Chave incoerente e divida que so fica mais cara.

alter table ad_metadata_cache
  drop constraint ad_metadata_cache_pkey;

alter table ad_metadata_cache
  add primary key (tenant_id, ad_id);

-- O join da fila tambem precisa casar o tenant, senao a chave nova nao
-- muda nada na pratica.
create or replace view touchpoints_sem_metadata
with (security_invoker = true)
as
select distinct t.tenant_id, t.ad_id
  from ad_touchpoints t
  left join ad_metadata_cache c
    on  c.ad_id     = t.ad_id
    and c.tenant_id = t.tenant_id
 where t.ad_id is not null
   and t.campaign_id is null
   and c.ad_id is null;
