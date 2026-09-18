-- Configuracao do Chatwoot por tenant.
--
-- Cada cliente tem sua conta dentro da mesma instancia do Chatwoot, entao
-- a captura precisa saber em qual conta procurar o contato antes de
-- enriquecer. Sem esta tabela o account_id viraria variavel de ambiente
-- unica e o sistema so serviria a um cliente.

create table chatwoot_configs (
  -- tenant_id e a chave primaria, nao uma coluna comum: duas configuracoes
  -- para o mesmo cliente fariam a captura escolher uma ao acaso, e o lead
  -- seria enriquecido na conta errada em parte das vezes.
  tenant_id   uuid primary key references tenants(id) on delete cascade,

  base_url    text not null default 'https://chat.leaderaperformance.com.br',

  -- Cadastrado manualmente pelo operador no onboarding de cada cliente
  account_id  bigint not null,

  -- Id da caixa de entrada, que chega em data.chatwootInboxId. Nulo no
  -- cadastro de proposito: so aparece quando o primeiro evento chega, e
  -- exigi-lo travaria o onboarding esperando um dado que ninguem tem.
  inbox_id    bigint,

  -- Guarda o NOME do segredo, nunca o segredo. Quem ler esta tabela — num
  -- dump, num backup, num join distraido — nao leva as credenciais junto.
  -- Onde o nome e resolvido (Vault ou ambiente da Edge Function) e decisao
  -- de quem le, e muda sem tocar no schema.
  token_ref   text not null,

  criado_em   timestamptz not null default now()
);

-- Sem policy: so service_role acessa. Configuracao de integracao nao e
-- dado que o cliente precise ler no painel.
--
-- O "enable" continua sendo obrigatorio mesmo sem policy nenhuma. Com RLS
-- ligado e sem policy, o acesso e negado por padrao, que e exatamente o
-- que se quer. Sem ele, a unica protecao seria a ausencia de grant — e um
-- "grant select on all tables in schema public to authenticated", que e
-- comando comum, abriria a tabela inteira sem ninguem notar.
alter table chatwoot_configs enable row level security;
