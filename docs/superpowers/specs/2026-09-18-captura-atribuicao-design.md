# Captura e Atribuição de Leads de Anúncio — Design

**Data:** 2026-09-18
**Fatia:** A (de 4) — fundação do produto
**Status:** aprovado em conversa, aguardando revisão do documento

---

## 1. Contexto

Plataforma multi-tenant que integra Chatwoot (CRM) com Meta Ads. Uma agência
opera várias contas de anúncio de vários clientes. A maioria das contas roda
campanhas de mensagens (Click-to-WhatsApp) e de seguidores.

O objetivo do produto completo é fechar o ciclo:

```
anúncio → conversa no WhatsApp → qualificação/venda no Chatwoot
   ↑                                        ↓
   └──────── Meta otimiza ←── evento de conversão
```

Esta fatia entrega **a metade esquerda**: saber, para cada lead que chega,
de qual anúncio ele veio. Sem isso, nenhuma das outras fatias tem o que
mostrar nem o que devolver à Meta.

## 2. Objetivo desta fatia

Ao final, para todo lead que chegar por um anúncio Click-to-WhatsApp:

- O `ctwa_clid` e o `ad_id` estão gravados e associados ao contato no Chatwoot
- A jornada completa do lead é consultável (quantas vezes voltou, por quais anúncios)
- Instâncias Evolution são monitoradas e falhas geram alerta antes do cliente perceber
- O isolamento entre clientes é garantido pelo banco, não por disciplina de código

## 3. Premissas

| # | Premissa | Origem |
|---|---|---|
| P1 | O `ctwaClid` chega no payload do Evolution | Confirmado pelo operador, que já roda isso em produção |
| P2 | Cada cliente pode ter sua própria instância Evolution | Definido pelo operador |
| P3 | Conversas seguem no Chatwoot via Quepasa na maioria das contas | Situação atual |
| P4 | Onboarding de cliente é manual (token, App, conta de anúncio) | Decisão do operador |
| P5 | Campanhas de seguidores só exibem dados, sem atribuição | Decisão do operador |

**Sobre P1 — verificada em 2026-09-18.** Payload real da instância confirmou o
`ctwaClid` presente, junto com `sourceId` (ad), `sourceApp` (plataforma) e o
`ctwaPayload` que a Conversions API pede na Fatia C.

A verificação também derrubou uma suposição: o `externalAdReply` **não** fica
sob `message`, e sim em `data.contextInfo`, irmão dele. Implementação por
caminho fixo teria falhado em todos os casos. A extração por busca já estava
no desenho e sobreviveu.

O design segue guardando o payload cru: o protocolo do WhatsApp Web muda sem
aviso e já quebrou integrações antes.

**Descoberta adicional:** o payload traz `chatwootConversationId`,
`chatwootInboxId` e `chatwootMessageId`. Onde o Evolution já está integrado ao
Chatwoot, o vínculo nasce pronto e a reconciliação da Seção 8.1 vira rede de
segurança em vez de caminho principal.

## 4. Escopo

**Dentro:**
- Recepção e validação de webhooks do Evolution
- Extração e persistência de touchpoints de anúncio
- Enriquecimento do contato no Chatwoot com dados de origem
- Reconciliação touchpoint ↔ conversa
- Consulta de jornada do lead
- Monitoramento de saúde das instâncias
- Fundação multi-tenant com RLS

**Fora (fatias futuras):**
- Painel do cliente (Fatia B)
- Ingestão de métricas da Meta Marketing API com cache (Fatia B)
- Envio de conversões via Conversions API (Fatia C)
- Camada de insights e recomendações (Fatia D)

## 5. Arquitetura

**Supabase Edge Functions + Postgres.** Sem servidor próprio nesta fatia.

```
Evolution ──webhook──▶ Edge Function          ┌──────────────┐
                       capture-touchpoint ───▶│              │
                                              │   Postgres   │
Chatwoot  ──webhook──▶ Edge Function ────────▶│   (Supabase) │
                       chatwoot-events        │              │
                                              └──────┬───────┘
                       pg_cron ───────────────────────┘
                       ├─ reconciliar órfãos (1 min)
                       └─ checar saúde (5 min)
```

**Por que Edge Functions e não serviço dedicado:** o handler é simples
(receber, validar, inserir) e o isolamento multi-tenant via RLS é a
propriedade mais valiosa do desenho. Migrar para um serviço Node depois
é barato, porque a lógica mora no Postgres e não na função.

**Por que não n8n:** o caminho da captura é crítico. Precisa de teste
automatizado e versionamento, que n8n não oferece bem.

## 6. Modelo de dados

### 6.1 Fundação multi-tenant

```sql
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  slug        text not null unique,          -- usado na URL do painel
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now()
);

create table ad_accounts (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  act_id               text not null,        -- act_1234567890
  nome                 text,
  token_ref            text,                 -- referência no Supabase Vault
  nivel_rastreamento   text not null default 'parcial'
                       check (nivel_rastreamento in ('completo','parcial')),
  criado_em            timestamptz not null default now(),
  unique (tenant_id, act_id)
);

create table evolution_instances (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  evolution_instance_id uuid unique,         -- data.instanceId, chave de lookup
  nome_instancia    text not null unique,    -- chega no campo "instance" do webhook
  url_base          text not null,
  api_key           text,                    -- comparada com body.apikey
  estado            text not null default 'desconhecido',
  ultimo_evento_em  timestamptz,
  silencio_limite_min  int not null default 120,
  horario_inicio    time not null default '08:00',
  horario_fim       time not null default '20:00',
  criado_em         timestamptz not null default now()
);
```

`nivel_rastreamento` distingue contas com atribuição determinística
(`completo`, via `ctwa_clid`) de contas que só permitem enriquecimento de
público (`parcial`, só telefone). O painel exibe essa diferença ao cliente.

### 6.2 Núcleo — append-only

```sql
create table ad_touchpoints (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references tenants(id) on delete cascade,
  instance_id               uuid references evolution_instances(id),

  wa_message_id             text not null,      -- idempotência
  from_me                   boolean,            -- lead real chega com false

  -- Nulos quando o JID não for de pessoa (@lid anônimo, grupo). A
  -- identidade do touchpoint é o clique no anúncio, não o telefone.
  phone_e164                text,
  phone_match_key           text,               -- ver 6.4

  ctwa_clid                 text,               -- null quando vier do Quepasa
  ad_id                     text,
  adset_id                  text,               -- preenchido por lookup na Meta
  campaign_id               text,
  platform                  text,               -- instagram | facebook
  source_channel            text not null   -- nesta fatia, sempre 'evolution'
                            check (source_channel in ('evolution','quepasa')),

  received_at               timestamptz not null,
  raw_payload               jsonb not null,

  chatwoot_contact_id       bigint,
  chatwoot_conversation_id  bigint,
  reconciled_at             timestamptz,        -- null = ainda órfão

  criado_em                 timestamptz not null default now(),
  unique (tenant_id, wa_message_id)
);

create index on ad_touchpoints (tenant_id, phone_match_key, received_at desc);
create index on ad_touchpoints (tenant_id, reconciled_at)
  where reconciled_at is null;
```

**Esta tabela nunca sofre UPDATE em campos de origem.** Cada entrada por
anúncio é uma linha nova. É isso que preserva a jornada do lead recorrente
e permite atribuição multi-toque.

Os únicos campos que recebem UPDATE são os cinco de reconciliação e
enriquecimento: `chatwoot_contact_id`, `chatwoot_conversation_id`,
`reconciled_at`, `adset_id` e `campaign_id`.

**A trava é um trigger, e enumera o que pode mudar — não o que não pode.**
Listar os campos congelados envelhece mal: coluna nova nasceria alterável
por esquecimento. Com a lista invertida, coluna nova nasce protegida.

Isso também fecha um buraco que passaria despercebido: sem a trava,
`tenant_id` seria alterável, e um UPDATE moveria um lead de um cliente para
outro — desfazendo pelo dado o isolamento que o RLS garante no acesso.

```sql
create table conversion_events (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references tenants(id) on delete cascade,
  touchpoint_id             uuid references ad_touchpoints(id),

  tipo                      text not null
                            check (tipo in ('qualificado','desqualificado','compra')),
  valor_centavos            bigint,             -- inteiro, nunca float
  moeda                     text default 'BRL',

  chatwoot_conversation_id  bigint,
  agente                    text,
  ocorrido_em               timestamptz not null,

  enviado_meta_em           timestamptz,        -- null = pendente de envio
  meta_response             jsonb,
  tentativas_envio          int not null default 0,

  criado_em                 timestamptz not null default now()
);

create index on conversion_events (tenant_id, enviado_meta_em)
  where enviado_meta_em is null;
```

`enviado_meta_em` separa **registrar** de **enviar**. Se a API da Meta cair,
o evento está salvo e reenvia depois. Nenhuma venda se perde por
instabilidade de terceiro.

> **Limite desta fatia:** a tabela é criada, mas **não é populada aqui**.
> Capturar conversões exige definir a taxonomia de ações do atendente no
> Chatwoot (o que exatamente ele marca, com quais campos), e isso ainda
> não foi decidido — ver Questão Aberta Q1. Captura e envio ficam na
> Fatia C. O schema nasce junto para o modelo ficar coerente.

### 6.3 Operação

```sql
create table instance_health (
  id             bigserial primary key,
  instance_id    uuid not null references evolution_instances(id) on delete cascade,
  estado         text not null,
  detalhe        text,
  registrado_em  timestamptz not null default now()
);

create table ad_metadata_cache (
  ad_id          text primary key,
  tenant_id      uuid not null references tenants(id) on delete cascade,
  ad_name        text,
  adset_id       text,
  adset_name     text,
  campaign_id    text,
  campaign_name  text,
  objetivo       text,
  atualizado_em  timestamptz not null default now()
);
```

`ad_metadata_cache` resolve o fato de que o payload do Evolution traz só o
`ad_id`. Campanha e conjunto vêm de uma consulta à Meta, feita uma vez por
anúncio. Também alimenta o nome legível no painel.

> **Degradação prevista:** o enriquecimento é *best-effort*. Enquanto não
> houver token da Meta configurado para o tenant, o touchpoint é gravado
> com `ad_id` e `adset_id`/`campaign_id` nulos. A captura nunca falha por
> falta de credencial da Meta — o enriquecimento roda depois, quando o
> token existir, varrendo os touchpoints incompletos.

### 6.4 Normalização de telefone

O join entre Evolution e Chatwoot é por telefone, e no Brasil isso tem uma
armadilha: números móveis ganharam um nono dígito, e o WhatsApp nem sempre
usa a mesma forma nos dois lados.

`5511987654321` e `551187654321` são a mesma pessoa.

Por isso duas colunas:

- **`phone_e164`** — forma canônica, para exibição e envio à Meta
- **`phone_match_key`** — forma reduzida usada só no join: DDI+DDD+últimos 8 dígitos

O join usa `phone_match_key`. Isso aceita as duas grafias sem perder o número
original.

**Nem todo JID é telefone.** O WhatsApp também endereça por `@lid`
(identificador anônimo) e `@g.us` (grupo), e vem migrando conversas para o
primeiro. A extração devolve nulo nesses casos em vez de cunhar um E.164
inventado — número falso entraria no banco como válido, não casaria com
contato nenhum, e a atribuição se perderia sem erro. O touchpoint ainda é
gravado, porque o `ctwa_clid` vale por si; ele só não terá como ser
reconciliado.

## 7. Fluxo de captura

Edge Function `capture-touchpoint`, acionada por `messages.upsert`:

```
1. Valida assinatura           header secreto por instância
2. Resolve tenant              nome da instância → evolution_instances
3. Marca instância viva        UPDATE ultimo_evento_em  ← sempre, toda mensagem
4. Procura externalAdReply     busca recursiva no payload
5. Sem anúncio? encerra        mensagem comum, nada mais a fazer
6. Normaliza telefone          E.164 + match_key
7. Insere touchpoint           ON CONFLICT DO NOTHING (idempotente)
8. Enfileira enriquecimento    lookup do ad_id na Meta, se não estiver em cache
9. Tenta ligar ao Chatwoot     best-effort, não bloqueia a resposta
```

**Passo 3 antes do 4, de propósito.** Toda mensagem marca a instância como
viva, não só as que vêm de anúncio. É isso que faz o dead man's switch
funcionar — uma instância que só recebe conversas orgânicas ainda está
saudável.

**Passo 4 é busca recursiva, não acesso direto.** O `externalAdReply` aparece
em posições diferentes conforme o tipo da primeira mensagem:

```
data.message.extendedTextMessage.contextInfo.externalAdReply   (texto)
data.message.imageMessage.contextInfo.externalAdReply          (imagem)
data.message.videoMessage.contextInfo.externalAdReply          (vídeo)
data.message.audioMessage.contextInfo.externalAdReply          (áudio)
```

Acesso direto ao caminho de texto funciona no teste e falha em produção
quando o lead responde ao anúncio com um áudio. A extração varre o objeto
procurando a chave.

**Passo 7 é idempotente.** O `wa_message_id` é único por natureza. Evolution
reenvia webhook em retry, e reenvia com frequência.

**Passo 9 não bloqueia.** Se o Chatwoot estiver fora do ar, o touchpoint já
está salvo. A reconciliação da Seção 8 recupera depois.

## 8. Reconciliação e atribuição

### 8.1 Ligar touchpoint à conversa

Três mecanismos sobrepostos. Quem chegar por último fecha o vínculo:

| Ordem de chegada | Quem faz o join |
|---|---|
| Evolution primeiro | Passo 9 não acha conversa → fica órfão → Chatwoot liga ao criar |
| Chatwoot primeiro | Passo 9 acha a conversa → liga na hora |
| Nenhum dos dois | `pg_cron` varre órfãos a cada minuto |

A busca casa por `phone_match_key` dentro de uma janela de 15 minutos antes
e depois do `received_at`. Ordem de chegada deixa de importar porque nenhum
lado espera pelo outro.

### 8.2 Jornada do lead

```sql
create view lead_journey
with (security_invoker = true)   -- sem isto, a view devolve dado de todos
as
select
  tenant_id,
  phone_match_key,
  max(phone_e164)               as phone_e164,
  count(*)                      as total_toques,
  count(distinct ad_id)         as anuncios_distintos,
  min(received_at)              as primeiro_toque_em,
  max(received_at)              as ultimo_toque_em,
  jsonb_agg(
    jsonb_build_object(
      'ad_id', ad_id, 'campaign_id', campaign_id,
      'quando', received_at, 'ctwa_clid', ctwa_clid
    ) order by received_at
  )                             as linha_do_tempo
from ad_touchpoints
group by tenant_id, phone_match_key;
```

Responde diretamente o que foi pedido: quantas vezes o lead entrou por
anúncio, por quais anúncios, e em que datas e horários.

### 8.3 Regra de crédito

Quando uma conversão é registrada, o crédito vai para o **último toque
dentro da janela de atribuição**.

- Janela padrão: **7 dias** — mesma da Meta, para os relatórios baterem
- A janela é **parâmetro da função**, não valor fixo no código
- Toques anteriores dentro da janela ficam registrados como **assistência**

> **Onde o valor por tenant fica guardado ainda não está decidido** — hoje
> quem chama é que informa. Nenhum chamador existe antes da Fatia C, e a
> decisão pertence a ela. Ver Q3.

Como nada foi sobrescrito, o painel pode mostrar o que a Meta não mostra:

> *"Lead entrou 3 vezes. Anúncio A trouxe em 12/09, Anúncio C fechou em
> 15/09. Venda: R$ 400."*

Anúncio A recebe crédito de assistência. É o número que impede o cliente de
matar um anúncio que funciona no topo do funil e não aparece no relatório
de última clique.

## 9. Monitoramento

| Falha | Detecção |
|---|---|
| Instância caiu | Uptime Kuma em `/instance/connectionState/{instance}`, a cada 60s |
| Diz "online" mas parou de receber | `pg_cron` compara `ultimo_evento_em` com `silencio_limite_min` |
| Erro ao processar webhook | Sentry na Edge Function |
| Update do Evolution quebrou o payload | Versão Docker fixada + alerta de queda súbita de touchpoints |

**O que esta fatia constrói:** a linha 2 (dead man's switch em `pg_cron`),
a tabela `instance_health` e a entrega do alerta. Uptime Kuma e Sentry são
ferramentas de terceiros recomendadas — instalá-las é trabalho de infra do
operador, fora do escopo de código desta fatia. O sistema funciona sem elas,
com cobertura menor.

A segunda linha é a que mais importa e a que quase ninguém implementa. Uma
instância "conectada" que parou de entregar mensagens não dispara alarme de
uptime — a falha só aparece quando o cliente reclama que o relatório zerou.

O limiar respeita o horário comercial configurado por instância. Silêncio às
3h da manhã é normal; silêncio às 14h por duas horas não é.

Alertas vão para o operador. O painel do cliente exibe um selo de saúde do
rastreamento — ele vê que está ativo, e o operador vê antes dele quando não está.

## 10. Segurança e multi-tenancy

**RLS habilitado em todas as tabelas.** O isolamento é garantido pelo banco,
não por `WHERE tenant_id = ...` espalhado pelo código.

```sql
alter table ad_touchpoints enable row level security;

-- Edge Functions usam service_role e contornam RLS: são confiáveis
-- O painel (Fatia B) usa usuário autenticado com claim de tenant
create policy tenant_isolation on ad_touchpoints
  for select using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
  );
```

O mesmo padrão em todas as tabelas com `tenant_id`. Papel `anon` não tem
acesso a nada.

> **Questão aberta Q2:** o formato exato do claim depende de como o cliente
> autentica no painel (link mágico? token assinado na URL?), e isso é
> decisão da Fatia B. Nesta fatia as políticas são escritas e **testadas
> com JWT sintético**. Se a Fatia B escolher outro mecanismo, muda a
> expressão do claim — não a estrutura das políticas.

**Tokens no Vault.** Tokens da Meta ficam no Supabase Vault; as tabelas
guardam só a referência. Quem conseguir ler a tabela não leva as credenciais
dos clientes junto.

**Webhook autenticado pela apikey da instância.** O Evolution não assina o
corpo: ele envia a própria `apikey` dentro do payload. A validação compara
essa chave com a cadastrada para aquela instância, em tempo constante.

É mais fraco que HMAC — a chave viaja no corpo a cada requisição — mas é o
que o Evolution oferece. TLS protege em trânsito e a chave é por instância,
então um vazamento não alcança os outros clientes. Instância sem chave
cadastrada recusa todo webhook: na dúvida, negar.

## 11. Testes

Desenvolvimento guiado por teste. Fixtures são **payloads reais** capturados
da instância do operador, não payloads derivados de documentação.

| Teste | Cobre |
|---|---|
| Extração em 5 formatos | texto, imagem, vídeo, áudio, e mensagem sem anúncio |
| Idempotência | mesmo `wa_message_id` duas vezes → uma linha |
| Corrida nos dois sentidos | Evolution→Chatwoot, Chatwoot→Evolution, simultâneo |
| Lead recorrente | 2 anúncios no mesmo dia; retorno após 10 dias (fora da janela) |
| **Isolamento RLS** | tenant A não lê dado de tenant B |
| Normalização de telefone | com/sem nono dígito, com/sem DDI, sufixo do WhatsApp |
| Assinatura de webhook | requisição sem assinatura é rejeitada |

O teste de RLS é a prova executável de que o isolamento existe, e roda a
cada mudança — então continua existindo.

## 12. Riscos conhecidos

| Risco | Mitigação |
|---|---|
| Protocolo do WhatsApp muda e o campo some | `raw_payload` permite reprocessar histórico |
| API não oficial → ban do número do cliente | Risco do operador, conhecido; recomenda-se registrar em contrato |
| Instância Evolution cai sem ninguém notar | Dead man's switch da Seção 9 |
| Lead recorrente atribuído ao anúncio errado | Multi-toque preservado; janela configurável |
| Telefone não casa entre os dois sistemas | `phone_match_key` com tolerância ao nono dígito |

## 13. Questões em aberto

Nenhuma bloqueia o início desta fatia. Ficam registradas para não virarem
decisão implícita tomada no meio do código.

| # | Questão | Decide quando |
|---|---|---|
| Q1 | Taxonomia de ações do atendente no Chatwoot: o que ele marca, com quais campos, e como informa valor de compra | Início da Fatia C |
| Q2 | Como o cliente autentica no painel, e daí o formato do claim de tenant no JWT | Início da Fatia B |
| Q3 | Janela de atribuição: qual valor por vertical (7 dias é o padrão da Meta, ticket alto pode pedir mais) e **onde guardar o valor por tenant** — coluna em `tenants`, tabela de configuração, ou parâmetro do chamador | Início da Fatia C |

## 14. Critérios de conclusão

- Um lead que clica num anúncio real tem `ctwa_clid` e `ad_id` gravados
- O contato correspondente no Chatwoot exibe os atributos de origem
- `lead_journey` devolve a jornada completa de um lead recorrente
- Derrubar uma instância dispara alerta dentro do limiar configurado
- A suíte de testes passa, incluindo o teste de isolamento RLS
