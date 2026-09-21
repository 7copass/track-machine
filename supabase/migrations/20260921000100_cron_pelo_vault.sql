-- Os jobs passam a ler a chave do Vault, e a dizer quando nao podem rodar.
--
-- Duas coisas estavam erradas.
--
-- A primeira: o desenho anterior lia as credenciais de `current_setting`,
-- que exige `alter database ... set` — privilegio que este ambiente nao
-- da. As settings nunca existiram.
--
-- A segunda, pior: a guarda do `where` que eu coloquei para o job nao
-- estourar transformou a falha em silencio. O job
-- `enriquecer-metadata-de-anuncio` rodou 144 vezes em 24h, TODAS com
-- status `succeeded` e `0 rows`, e nunca chamou a funcao. Sucesso e zero
-- linhas parece saudavel; so quem fosse conferir se o trabalho aconteceu
-- perceberia.
--
-- Guarda que evita o crash e correta. Guarda que esconde o motivo, nao.

create or replace function chamar_edge_function(
  nome  text,
  corpo jsonb default '{}'::jsonb
)
returns text
language plpgsql
security definer
as $$
declare
  chave text;
  base  constant text :=
    'https://gnalpuiulirleagdwycu.supabase.co/functions/v1';
begin
  select decrypted_secret into chave
    from vault.decrypted_secrets
   where name = 'service_role_key';

  -- A mensagem devolvida aparece em cron.job_run_details.return_message.
  -- E o que diferencia "nao havia o que fazer" de "nao consegui tentar".
  if chave is null or chave = '' then
    raise warning
      'service_role_key ausente no Vault: % nao foi chamada', nome;
    return 'FALHOU: sem chave no Vault';
  end if;

  perform net.http_post(
    url     := base || '/' || nome,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || chave
    ),
    body    := corpo
  );

  return 'chamada: ' || nome;
end $$;

revoke execute on function chamar_edge_function(text, jsonb) from public, anon, authenticated;

-- Reagenda os dois jobs pelo caminho novo.
select cron.unschedule('enriquecer-metadata-de-anuncio')
 where exists (select 1 from cron.job
                where jobname = 'enriquecer-metadata-de-anuncio');

select cron.unschedule('sincronizar-insights')
 where exists (select 1 from cron.job where jobname = 'sincronizar-insights');

select cron.schedule(
  'enriquecer-metadata-de-anuncio',
  '*/10 * * * *',
  $cron$select chamar_edge_function('enrich-ad-metadata')$cron$
);

select cron.schedule(
  'sincronizar-insights',
  '0 */6 * * *',
  $cron$select chamar_edge_function(
    'sync-meta-insights', '{"tipo":"recorrente"}'::jsonb
  )$cron$
);
