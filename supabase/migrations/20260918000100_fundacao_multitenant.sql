create table tenants (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  slug       text not null unique,
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);

create table ad_accounts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  act_id              text not null,
  nome                text,
  token_ref           text,
  nivel_rastreamento  text not null default 'parcial'
                      check (nivel_rastreamento in ('completo','parcial')),
  criado_em           timestamptz not null default now(),
  unique (tenant_id, act_id)
);

create table evolution_instances (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,

  -- UUID estavel que o Evolution manda em data.instanceId. E a chave de
  -- lookup do webhook: o nome da instancia pode ser renomeado no painel
  -- do Evolution e tem espaco ("ortodonto comercial 01"), o UUID nao muda.
  evolution_instance_id uuid unique,
  nome_instancia       text not null unique,

  url_base             text not null,

  -- O Evolution autentica mandando a propria apikey no corpo do webhook
  -- (body.apikey), nao com header assinado. O operador cadastra aqui no
  -- onboarding de cada cliente.
  api_key              text,

  estado               text not null default 'desconhecido',
  ultimo_evento_em     timestamptz,
  silencio_limite_min  int not null default 120,
  horario_inicio       time not null default '08:00',
  horario_fim          time not null default '20:00',
  criado_em            timestamptz not null default now()
);

-- Le o tenant do JWT. Uma funcao so, para toda politica usar a mesma
-- fonte: se o formato do claim mudar (Fatia B), muda aqui e nada mais.
create or replace function current_tenant_id()
returns uuid
language sql stable
as $$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id',
    ''
  )::uuid
$$;

alter table tenants            enable row level security;
alter table ad_accounts        enable row level security;
alter table evolution_instances enable row level security;

create policy tenant_le_o_proprio on tenants
  for select to authenticated
  using (id = current_tenant_id());

create policy tenant_le_as_proprias_contas on ad_accounts
  for select to authenticated
  using (tenant_id = current_tenant_id());

create policy tenant_le_as_proprias_instancias on evolution_instances
  for select to authenticated
  using (tenant_id = current_tenant_id());
