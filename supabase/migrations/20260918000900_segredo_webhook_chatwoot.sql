-- Segredo por tenant para autenticar o webhook do Chatwoot.
--
-- O Chatwoot nao assina o corpo e a interface dele nao permite cabecalho
-- customizado, entao nao existe equivalente ao que o Evolution oferece
-- (apikey no corpo). O unico canal que sobra e a query string da URL:
--
--   https://<projeto>.supabase.co/functions/v1/chatwoot-events?s=<segredo>
--
-- E mais fraco que HMAC, porque URL costuma aparecer em log de acesso e de
-- proxy. Por isso o segredo e POR TENANT: se um vazar, o estrago fica
-- contido a um cliente em vez de abrir a plataforma inteira.
--
-- Sem isso, quem descobrisse a URL injetaria conversa em qualquer cliente
-- chutando o account_id, que e inteiro pequeno e sequencial. O efeito nao
-- seria so lixo no banco: uma conversa falsa no momento certo faz a
-- reconciliacao atribuir um lead pago a conversa de outra pessoa.

alter table chatwoot_configs
  add column webhook_secret text not null unique
    default encode(extensions.gen_random_bytes(32), 'hex');

comment on column chatwoot_configs.webhook_secret is
  'Segredo da query string (?s=) do webhook do Chatwoot. Gerado sozinho; '
  'o operador copia para a URL do webhook no painel do Chatwoot do cliente.';
