-- account_id do Chatwoot passa a ser unico.
--
-- O webhook chatwoot-events resolve o tenant assim:
--   .from("chatwoot_configs").eq("account_id", contaId).single()
--
-- Com dois cadastros apontando para o mesmo account_id, esse .single()
-- estoura em producao, no meio do fluxo, com o webhook ja aceito. Falhar
-- alto e melhor que escolher um tenant ao acaso — mas o certo e o schema
-- recusar o cadastro errado na hora de cadastrar, nao horas depois.
--
-- E o mesmo argumento que ja motivou tenant_id ser PK aqui: uma config
-- por cliente, um cliente por conta do Chatwoot.

alter table chatwoot_configs
  add constraint chatwoot_configs_account_id_key unique (account_id);
