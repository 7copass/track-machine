# Captura e Atribuição de Leads — Plano de Implementação

> **Para executores agênticos:** SUB-SKILL OBRIGATÓRIA: use
> `superpowers:subagent-driven-development` (recomendado) ou
> `superpowers:executing-plans` para implementar tarefa a tarefa.
> Os passos usam checkbox (`- [ ]`) para acompanhamento.

**Objetivo:** Para todo lead que chega por um anúncio Click-to-WhatsApp,
gravar de qual anúncio veio, ligar essa origem à conversa no Chatwoot, e
preservar a jornada completa de leads que voltam por anúncios diferentes.

**Arquitetura:** Supabase Edge Functions (Deno) recebem webhooks do Evolution
e do Chatwoot e gravam em Postgres. Reconciliação e monitoramento rodam em
`pg_cron` dentro do banco. Isolamento entre clientes por Row Level Security,
não por filtro em código de aplicação.

**Stack:** Supabase (Postgres 17), Deno 2.5, TypeScript, pgTAP para testes de
banco, `deno test` para lógica pura.

**Spec:** `docs/superpowers/specs/2026-09-18-captura-atribuicao-design.md`

## Restrições Globais

Valem para toda tarefa. Os requisitos de cada tarefa incluem esta seção
implicitamente.

- **RLS habilitado em toda tabela com `tenant_id`.** Sem exceção. Uma tabela
  sem política é um vazamento entre clientes esperando acontecer.
- **Dinheiro sempre em centavos, tipo `bigint`.** Nunca `float`, `real` ou
  `double precision`.
- **`ad_touchpoints` é append-only nos campos de origem.** `UPDATE` permitido
  apenas em `chatwoot_contact_id`, `chatwoot_conversation_id`,
  `reconciled_at`, `adset_id`, `campaign_id`.
- **`raw_payload` sempre gravado**, mesmo quando a extração falhar.
- **Idempotência por `wa_message_id`.** Evolution reenvia webhooks.
- **Fixtures são payloads reais** capturados da instância do operador. Payload
  inventado a partir de documentação não serve como fixture.
- **Migrations nomeadas** `YYYYMMDDHHMMSS_descricao.sql` em `supabase/migrations/`.
- **Sem Docker nesta máquina.** Migrations vão ao projeto remoto com
  `supabase db push`; testes rodam com `python3 scripts/run_pgtap.py <arquivo>`.
  Toda suíte pgTAP deve ser uma única expressão `select unnest(array[...])`,
  formato que o runner espera.
- **Commits em português**, imperativo, explicando o porquê e não o quê.

## Estrutura de Arquivos

```
supabase/
  config.toml
  migrations/
    20260918000000_pgtap.sql                  framework de teste (só local)
    20260918000100_fundacao_multitenant.sql   tenants, contas, instâncias, RLS
    20260918000200_nucleo_touchpoints.sql     touchpoints append-only, conversões
    20260918000300_chatwoot_config.sql        config do Chatwoot por tenant
    20260918000400_reconciliacao.sql          conversas + join + cron
    20260918000500_lead_journey.sql           jornada e regra de crédito
    20260918000600_metadata_cache.sql         cache de anúncio da Meta
    20260918000700_monitoramento.sql          alertas e dead man's switch
    20260918000800_notificar_alertas.sql      entrega do alerta via pg_net
  functions/
    _shared/
      phone.ts           normalização E.164 + chave de join
      ad_reply.ts        extração do externalAdReply
      db.ts              cliente Postgres com service_role
      webhook_auth.ts    validação de assinatura
      chatwoot.ts        cliente da API do Chatwoot
      meta.ts            lookup de metadata de anúncio
    capture-touchpoint/
      index.ts           webhook do Evolution
    chatwoot-events/
      index.ts           webhook do Chatwoot
    enrich-ad-metadata/
      index.ts           preenche campanha/conjunto dos touchpoints
  tests/
    database/
      01_rls.test.sql            isolamento entre tenants
      02_touchpoints.test.sql    append-only e idempotência
      03_reconciliacao.test.sql  join entre touchpoint e conversa
      04_journey.test.sql        lead recorrente e crédito
      05_monitoramento.test.sql  dead man's switch
tests/
  unit/
    phone_test.ts
    ad_reply_test.ts
    webhook_auth_test.ts
    chatwoot_test.ts
    meta_test.ts
  fixtures/
    evolution/
      texto_com_anuncio.json
      imagem_com_anuncio.json
      video_com_anuncio.json
      audio_com_anuncio.json
      texto_sem_anuncio.json
    chatwoot/
      conversation_created.json
```

Cada arquivo em `_shared/` tem uma responsabilidade e é testável sozinho.
`phone.ts` e `ad_reply.ts` são funções puras — nenhuma I/O — porque é neles
que mora a lógica que mais erra, e função pura é a que se testa melhor.

---

### Tarefa 1: Fundação multi-tenant com isolamento testado

**Arquivos:**
- Criar: `supabase/config.toml` (via CLI)
- Criar: `supabase/migrations/20260918000100_fundacao_multitenant.sql`
- Teste: `supabase/tests/database/01_rls.test.sql`

**Interfaces:**
- Produz: tabelas `tenants`, `ad_accounts`, `evolution_instances`; função
  `current_tenant_id() returns uuid` usada por toda política RLS posterior.

- [ ] **Passo 1: Confirmar acesso ao banco remoto**

Não há Docker nesta máquina, e o operador optou por trabalhar direto no
projeto Supabase remoto — que está vazio e é ambiente de teste.

```bash
cd /Users/victorhugosantanaalmeida/Clientes-Victor-Tráfego
set -a && . ./.env && set +a
supabase migration list --linked
```

`supabase init` e `supabase link` já foram executados. As migrations vão para
o remoto com `supabase db push`, e os testes rodam por
`scripts/run_pgtap.py`.

**Consequência que vale saber:** sem banco local não há rede de segurança —
migration com erro chega ao projeto de verdade. Como o banco está vazio e é
de teste, o risco é aceitável agora; quando houver dado de cliente, isso
precisa mudar.

- [ ] **Passo 2: Escrever o teste de isolamento que falha**

Criar `supabase/tests/database/01_rls.test.sql`:

```sql
select unnest(array[
  extensions.plan(4),

-- Dois tenants e um usuário para cada
insert into tenants (id, nome, slug) values
  ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a'),
  ('22222222-2222-2222-2222-222222222222', 'Cliente B', 'cliente-b');

insert into ad_accounts (tenant_id, act_id, nome) values
  ('11111111-1111-1111-1111-111111111111', 'act_111', 'Conta A'),
  ('22222222-2222-2222-2222-222222222222', 'act_222', 'Conta B');

-- Papel anônimo não enxerga nada
set local role anon;
select is_empty(
  'select * from ad_accounts',
  'anon nao le nenhuma conta de anuncio'
);

-- Tenant A autenticado enxerga só o que é dele
set local role authenticated;
set local request.jwt.claims =
  '{"tenant_id":"11111111-1111-1111-1111-111111111111"}';

select results_eq(
  'select act_id from ad_accounts',
  array['act_111'],
  'tenant A enxerga apenas a propria conta'
);

select is_empty(
  $$select * from ad_accounts where act_id = 'act_222'$$,
  'tenant A nao alcanca a conta do tenant B nem filtrando por ela'
);

-- Tenant B enxerga o dele
set local request.jwt.claims =
  '{"tenant_id":"22222222-2222-2222-2222-222222222222"}';

select results_eq(
  'select act_id from ad_accounts',
  array['act_222'],
  'tenant B enxerga apenas a propria conta'
);

select * from finish();
rollback;
```

O terceiro caso é o que importa de verdade: não basta o `SELECT` sem filtro
devolver só o que é do tenant. Um `WHERE` apontando direto para o dado do
outro cliente também precisa voltar vazio. É a diferença entre filtrar e
isolar.

- [ ] **Passo 3: Rodar o teste e confirmar que falha**

```bash
python3 scripts/run_pgtap.py supabase/tests/database/01_rls.test.sql
```

Esperado: FALHA com `relation "tenants" does not exist`. O pgTAP 1.3.3 já
está instalado no projeto, então o erro vem da tabela que ainda não existe.

**Como o runner funciona:** a API de query do Supabase commita cada chamada,
então `begin/rollback` não é aceito. O runner envolve a suíte num bloco que
termina levantando exceção de propósito — a exceção desfaz as fixtures e
devolve o relatório pela mensagem de erro. Verificado: o banco fica limpo
depois de cada execução.

- [ ] **Passo 4: Escrever as migrations**

Primeiro, o pgTAP numa migration separada — `supabase/migrations/20260918000000_pgtap.sql`:

```sql
-- pgTAP isolado numa migration propria de proposito: ele e framework de
-- teste, e mante-lo separado permite excluir esta migration do push para
-- producao sem mexer em nenhuma outra.
create extension if not exists pgtap with schema extensions;
```

Depois a fundação — `supabase/migrations/20260918000100_fundacao_multitenant.sql`:

```sql
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

-- Lê o tenant do JWT. Uma função só, para toda política usar a mesma
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
```

Nenhuma política para `anon`: ausência de política com RLS ligado significa
acesso negado. As Edge Functions usam `service_role`, que contorna RLS por
ser confiável.

- [ ] **Passo 5: Aplicar a migration e rodar o teste**

```bash
supabase db push
python3 scripts/run_pgtap.py supabase/tests/database/01_rls.test.sql
```

Esperado: 4 testes passando, nenhum `not ok`.

- [ ] **Passo 6: Commit**

```bash
git add supabase/
git commit -m "Fundacao multi-tenant com isolamento garantido pelo banco

RLS em vez de filtro por tenant no codigo da aplicacao: filtro
esquecido em uma query vaza dado de um cliente para outro, e em
produto com painel por cliente isso encerra contrato.

current_tenant_id() centraliza a leitura do claim para que a
mudanca de formato na Fatia B toque um lugar so.

O teste cobre o caso que importa: nao basta a query sem filtro
devolver so o proprio dado, a query apontando direto para o dado
alheio tambem precisa voltar vazia."
```

---

### Tarefa 2: Normalização de telefone

**Arquivos:**
- Criar: `supabase/functions/_shared/phone.ts`
- Teste: `tests/unit/phone_test.ts`

**Interfaces:**
- Produz: `fromJid(jid: string): string` — extrai E.164 de um JID do WhatsApp.
  `toMatchKey(e164: string): string` — chave de join tolerante ao nono dígito.

- [ ] **Passo 1: Escrever os testes que falham**

Criar `tests/unit/phone_test.ts`:

```typescript
import { assertEquals } from "jsr:@std/assert";
import { fromJid, toMatchKey } from "../../supabase/functions/_shared/phone.ts";

Deno.test("fromJid extrai o numero de um JID simples", () => {
  assertEquals(fromJid("5511987654321@s.whatsapp.net"), "+5511987654321");
});

Deno.test("fromJid descarta o sufixo de dispositivo", () => {
  // Multi-device do WhatsApp adiciona ":12" ao JID
  assertEquals(fromJid("5511987654321:12@s.whatsapp.net"), "+5511987654321");
});

Deno.test("fromJid aceita numero internacional", () => {
  assertEquals(fromJid("351912345678@s.whatsapp.net"), "+351912345678");
});

Deno.test("toMatchKey remove o nono digito de movel brasileiro", () => {
  assertEquals(toMatchKey("+5511987654321"), "551187654321");
});

Deno.test("toMatchKey mantem numero brasileiro legado sem o nono digito", () => {
  assertEquals(toMatchKey("+551187654321"), "551187654321");
});

Deno.test("as duas grafias brasileiras produzem a mesma chave", () => {
  // O caso que motiva existir uma chave separada: o mesmo lead escrito
  // de dois jeitos entre Evolution e Chatwoot precisa casar
  assertEquals(toMatchKey("+5511987654321"), toMatchKey("+551187654321"));
});

Deno.test("toMatchKey preserva numero internacional por inteiro", () => {
  // Cortar digitos de numero estrangeiro criaria colisao entre pessoas
  assertEquals(toMatchKey("+351912345678"), "351912345678");
});

Deno.test("toMatchKey preserva fixo brasileiro", () => {
  assertEquals(toMatchKey("+551133334444"), "551133334444");
});
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
deno test tests/unit/phone_test.ts
```

Esperado: FALHA com `Module not found`.

- [ ] **Passo 3: Implementar**

Criar `supabase/functions/_shared/phone.ts`:

```typescript
/**
 * Normalização de telefone para o join entre Evolution e Chatwoot.
 *
 * Móveis brasileiros ganharam um nono dígito, e os dois sistemas nem sempre
 * usam a mesma grafia: 5511987654321 e 551187654321 são a mesma pessoa.
 * Por isso o número canônico e a chave de join são coisas separadas.
 */

/** Extrai o E.164 de um JID do WhatsApp. */
export function fromJid(jid: string): string {
  const antesDoArroba = jid.split("@")[0];
  const semDispositivo = antesDoArroba.split(":")[0];
  return "+" + semDispositivo.replace(/\D/g, "");
}

/**
 * Chave de join tolerante ao nono dígito.
 *
 * Móvel brasileiro (55 + DDD + 9 dígitos = 13) vira 55 + DDD + últimos 8,
 * igualando-se à grafia legada de 12 dígitos. Qualquer outro número fica
 * inteiro — encurtar número estrangeiro colidiria pessoas diferentes.
 */
export function toMatchKey(e164: string): string {
  const digitos = e164.replace(/\D/g, "");
  const ehMovelBrasileiro = digitos.startsWith("55") && digitos.length === 13;
  if (ehMovelBrasileiro) {
    return digitos.slice(0, 4) + digitos.slice(-8);
  }
  return digitos;
}
```

- [ ] **Passo 4: Rodar e confirmar que passa**

```bash
deno test tests/unit/phone_test.ts
```

Esperado: 8 testes passando.

- [ ] **Passo 5: Commit**

```bash
git add supabase/functions/_shared/phone.ts tests/unit/phone_test.ts
git commit -m "Normalizacao de telefone tolerante ao nono digito brasileiro

O join entre Evolution e Chatwoot e por telefone, e os dois nem
sempre gravam a mesma grafia do mesmo numero. Sem a chave reduzida,
lead com nono digito de um lado e sem do outro vira duas pessoas e
a atribuicao se perde silenciosamente.

A reducao vale so para movel brasileiro: cortar digito de numero
estrangeiro colidiria pessoas diferentes na mesma chave."
```

---

### Tarefa 3: Extração do externalAdReply

**Arquivos:**
- Criar: `supabase/functions/_shared/ad_reply.ts`
- Criar: `tests/fixtures/evolution/*.json` (5 payloads reais)
- Teste: `tests/unit/ad_reply_test.ts`

**Interfaces:**
- Consome: nada.
- Produz: `type AdReply = { ctwaClid: string | null; adId: string | null;
  sourceUrl: string | null; title: string | null; body: string | null }` e
  `extrairAdReply(payload: unknown): AdReply | null`.

> **DEPENDÊNCIA DO OPERADOR:** esta tarefa precisa de 5 payloads reais
> capturados da instância Evolution. Ver seção "Dados Necessários" ao final.
> Payload derivado de documentação não serve — o formato real é a única
> fonte confiável, e é justamente onde este tipo de integração quebra.

- [ ] **Passo 1: Salvar os payloads reais como fixtures**

Salvar cada payload capturado em `tests/fixtures/evolution/`, com o telefone
substituído por `5511900000000` e o `ctwaClid` por um valor fictício de mesmo
formato. Os cinco casos: primeira mensagem em texto, imagem, vídeo e áudio
vindas de anúncio, e uma mensagem comum sem anúncio.

- [ ] **Passo 2: Escrever os testes que falham**

Criar `tests/unit/ad_reply_test.ts`:

```typescript
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { extrairAdReply } from "../../supabase/functions/_shared/ad_reply.ts";

async function fixture(nome: string): Promise<unknown> {
  const texto = await Deno.readTextFile(`tests/fixtures/evolution/${nome}.json`);
  return JSON.parse(texto);
}

Deno.test("extrai de primeira mensagem em texto", async () => {
  const r = extrairAdReply(await fixture("texto_com_anuncio"));
  assertNotEquals(r, null);
  assertNotEquals(r!.ctwaClid, null);
  assertNotEquals(r!.adId, null);
});

Deno.test("extrai quando o lead responde com imagem", async () => {
  const r = extrairAdReply(await fixture("imagem_com_anuncio"));
  assertNotEquals(r, null);
  assertNotEquals(r!.ctwaClid, null);
});

Deno.test("extrai quando o lead responde com video", async () => {
  const r = extrairAdReply(await fixture("video_com_anuncio"));
  assertNotEquals(r, null);
});

Deno.test("extrai quando o lead responde com audio", async () => {
  // O caso que quebra implementacao com caminho fixo: audio nao passa
  // por extendedTextMessage
  const r = extrairAdReply(await fixture("audio_com_anuncio"));
  assertNotEquals(r, null);
});

Deno.test("devolve null em mensagem sem anuncio", async () => {
  assertEquals(extrairAdReply(await fixture("texto_sem_anuncio")), null);
});

Deno.test("devolve null sem estourar em payload malformado", () => {
  assertEquals(extrairAdReply(null), null);
  assertEquals(extrairAdReply({}), null);
  assertEquals(extrairAdReply({ data: { message: null } }), null);
  assertEquals(extrairAdReply("texto solto"), null);
});

Deno.test("nao entra em loop com referencia circular", () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  assertEquals(extrairAdReply(circular), null);
});

Deno.test("sobrevive a anuncio sem ctwaClid", () => {
  // Protocolo mudou ou anuncio antigo: adId presente, clid ausente.
  // Precisa devolver o que tem, nao descartar tudo.
  const p = {
    data: { message: { extendedTextMessage: { contextInfo: {
      externalAdReply: { sourceId: "123456", sourceType: "ad" },
    } } } },
  };
  const r = extrairAdReply(p);
  assertEquals(r!.adId, "123456");
  assertEquals(r!.ctwaClid, null);
});
```

- [ ] **Passo 3: Rodar e confirmar que falha**

```bash
deno test --allow-read tests/unit/ad_reply_test.ts
```

Esperado: FALHA com `Module not found`.

- [ ] **Passo 4: Implementar**

Criar `supabase/functions/_shared/ad_reply.ts`:

```typescript
/**
 * Extração dos dados de anúncio da primeira mensagem de um lead.
 *
 * O externalAdReply muda de lugar conforme o tipo da mensagem com que o lead
 * respondeu ao anúncio — extendedTextMessage, imageMessage, videoMessage,
 * audioMessage. Acesso por caminho fixo funciona no teste e falha em
 * produção no primeiro lead que responde com áudio. Por isso a busca varre
 * o objeto procurando a chave, em vez de assumir posição.
 */

export type AdReply = {
  ctwaClid: string | null;
  adId: string | null;
  sourceUrl: string | null;
  sourceApp: string | null;   // "instagram" | "facebook" — vira platform
  title: string | null;
  body: string | null;
};

const PROFUNDIDADE_MAXIMA = 12;

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Busca em largura pela chave externalAdReply, com proteção contra ciclos. */
function acharNo(raiz: unknown): Record<string, unknown> | null {
  const vistos = new WeakSet<object>();
  let nivel: unknown[] = [raiz];

  for (let d = 0; d < PROFUNDIDADE_MAXIMA && nivel.length > 0; d++) {
    const proximo: unknown[] = [];

    for (const no of nivel) {
      if (no === null || typeof no !== "object") continue;
      if (vistos.has(no)) continue;
      vistos.add(no);

      const obj = no as Record<string, unknown>;
      const achado = obj["externalAdReply"];
      if (achado && typeof achado === "object") {
        return achado as Record<string, unknown>;
      }
      for (const valor of Object.values(obj)) proximo.push(valor);
    }
    nivel = proximo;
  }
  return null;
}

export function extrairAdReply(payload: unknown): AdReply | null {
  const no = acharNo(payload);
  if (!no) return null;

  return {
    ctwaClid: texto(no["ctwaClid"]),
    adId: texto(no["sourceId"]),
    sourceUrl: texto(no["sourceUrl"]),
    sourceApp: texto(no["sourceApp"]),
    title: texto(no["title"]),
    body: texto(no["body"]),
  };
}
```

- [ ] **Passo 5: Rodar e confirmar que passa**

```bash
deno test --allow-read tests/unit/ad_reply_test.ts
```

Esperado: 8 testes passando.

- [ ] **Passo 6: Commit**

```bash
git add supabase/functions/_shared/ad_reply.ts tests/unit/ad_reply_test.ts tests/fixtures/
git commit -m "Extracao de dados de anuncio por busca, nao por caminho fixo

O externalAdReply muda de posicao conforme o tipo da mensagem com
que o lead respondeu ao anuncio. Implementacao que acessa
extendedTextMessage.contextInfo direto passa no teste e falha no
primeiro lead que responde com audio.

Fixtures sao payloads reais da instancia, nao derivados de
documentacao: o formato real e a unica fonte confiavel.

Extracao parcial e proposital. Se o protocolo mudar e o ctwaClid
sumir, o adId ainda e gravado e o lead continua atribuivel a
campanha, mesmo perdendo a atribuicao de clique."
```

---

### Tarefa 4: Schema do núcleo

**Arquivos:**
- Criar: `supabase/migrations/20260918000200_nucleo_touchpoints.sql`
- Teste: `supabase/tests/database/02_touchpoints.test.sql`

**Interfaces:**
- Consome: `tenants`, `evolution_instances`, `current_tenant_id()` da Tarefa 1.
- Produz: tabelas `ad_touchpoints` e `conversion_events` com RLS e índices.

- [ ] **Passo 1: Escrever o teste que falha**

Criar `supabase/tests/database/02_touchpoints.test.sql`:

```sql
begin;
select plan(5);

insert into tenants (id, nome, slug) values
  ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a'),
  ('22222222-2222-2222-2222-222222222222', 'Cliente B', 'cliente-b');

insert into ad_touchpoints
  (tenant_id, wa_message_id, phone_e164, phone_match_key,
   ctwa_clid, ad_id, source_channel, received_at, raw_payload)
values
  ('11111111-1111-1111-1111-111111111111', 'MSG_A1', '+5511900000001',
   '551190000001', 'clid_a1', 'ad_1', 'evolution', now(), '{}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'MSG_B1', '+5511900000002',
   '551190000002', 'clid_b1', 'ad_2', 'evolution', now(), '{}'::jsonb);

-- Idempotencia: o mesmo wa_message_id nao entra duas vezes
insert into ad_touchpoints
  (tenant_id, wa_message_id, phone_e164, phone_match_key,
   source_channel, received_at, raw_payload)
values
  ('11111111-1111-1111-1111-111111111111', 'MSG_A1', '+5511900000001',
   '551190000001', 'evolution', now(), '{}'::jsonb)
on conflict (tenant_id, wa_message_id) do nothing;

select is(
  (select count(*)::int from ad_touchpoints
     where wa_message_id = 'MSG_A1'),
  1,
  'reenvio do mesmo webhook nao duplica o lead'
);

-- Append-only: alterar a origem de um touchpoint e bloqueado
select throws_ok(
  $$update ad_touchpoints set ad_id = 'outro' where wa_message_id = 'MSG_A1'$$,
  null,
  'alterar a origem de um touchpoint e bloqueado'
);

-- Campos de reconciliacao continuam alteraveis
select lives_ok(
  $$update ad_touchpoints set chatwoot_contact_id = 42,
      reconciled_at = now() where wa_message_id = 'MSG_A1'$$,
  'campos de reconciliacao permanecem alteraveis'
);

-- Isolamento
set local role authenticated;
set local request.jwt.claims =
  '{"tenant_id":"11111111-1111-1111-1111-111111111111"}';

select results_eq(
  'select wa_message_id from ad_touchpoints',
  array['MSG_A1'],
  'tenant A enxerga apenas os proprios touchpoints'
);

select is_empty(
  $$select * from ad_touchpoints where wa_message_id = 'MSG_B1'$$,
  'tenant A nao alcanca touchpoint do tenant B'
);

select * from finish();
rollback;
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
supabase test db
```

Esperado: FALHA com `relation "ad_touchpoints" does not exist`.

- [ ] **Passo 3: Escrever a migration**

Criar `supabase/migrations/20260918000200_nucleo_touchpoints.sql`:

```sql
create table ad_touchpoints (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references tenants(id) on delete cascade,
  instance_id               uuid references evolution_instances(id),

  wa_message_id             text not null,
  phone_e164                text not null,
  phone_match_key           text not null,

  ctwa_clid                 text,
  ad_id                     text,
  adset_id                  text,
  campaign_id               text,
  platform                  text,
  source_channel            text not null
                            check (source_channel in ('evolution','quepasa')),

  received_at               timestamptz not null,
  raw_payload               jsonb not null,

  chatwoot_contact_id       bigint,
  chatwoot_conversation_id  bigint,
  reconciled_at             timestamptz,

  criado_em                 timestamptz not null default now(),
  unique (tenant_id, wa_message_id)
);

create index on ad_touchpoints (tenant_id, phone_match_key, received_at desc);
create index on ad_touchpoints (tenant_id, reconciled_at)
  where reconciled_at is null;

-- Append-only aplicado pelo banco, nao por convencao.
-- A jornada do lead recorrente so existe porque nada se sobrescreve;
-- deixar isso a cargo da disciplina de quem escreve query e apostar.
create or replace function bloquear_alteracao_de_origem()
returns trigger language plpgsql as $$
begin
  if (new.wa_message_id, new.phone_e164, new.ctwa_clid, new.ad_id,
      new.received_at, new.raw_payload)
     is distinct from
     (old.wa_message_id, old.phone_e164, old.ctwa_clid, old.ad_id,
      old.received_at, old.raw_payload)
  then
    raise exception
      'ad_touchpoints e append-only: campos de origem nao podem mudar';
  end if;
  return new;
end $$;

create trigger tg_touchpoint_append_only
  before update on ad_touchpoints
  for each row execute function bloquear_alteracao_de_origem();

create table conversion_events (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references tenants(id) on delete cascade,
  touchpoint_id             uuid references ad_touchpoints(id),

  tipo                      text not null
                            check (tipo in ('qualificado','desqualificado','compra')),
  valor_centavos            bigint,
  moeda                     text default 'BRL',

  chatwoot_conversation_id  bigint,
  agente                    text,
  ocorrido_em               timestamptz not null,

  enviado_meta_em           timestamptz,
  meta_response             jsonb,
  tentativas_envio          int not null default 0,

  criado_em                 timestamptz not null default now()
);

create index on conversion_events (tenant_id, enviado_meta_em)
  where enviado_meta_em is null;

alter table ad_touchpoints    enable row level security;
alter table conversion_events enable row level security;

create policy tenant_le_os_proprios_touchpoints on ad_touchpoints
  for select to authenticated
  using (tenant_id = current_tenant_id());

create policy tenant_le_as_proprias_conversoes on conversion_events
  for select to authenticated
  using (tenant_id = current_tenant_id());
```

- [ ] **Passo 4: Rodar e confirmar que passa**

```bash
supabase test db
```

Esperado: 5 testes passando (9 no total com a Tarefa 1).

- [ ] **Passo 5: Commit**

```bash
git add supabase/
git commit -m "Nucleo append-only de touchpoints com bloqueio no banco

Origem de lead e evento, nao campo do contato. Se fosse campo, o
segundo anuncio sobrescreveria o primeiro e a jornada do lead
recorrente se perderia — justamente o dado que permite mostrar que
um anuncio de topo assistiu a venda que outro fechou.

O append-only e trigger e nao convencao: a garantia nao pode
depender de ninguem lembrar de nao dar UPDATE.

conversion_events nasce aqui mas so e populada na Fatia C, quando
a taxonomia de acoes do atendente estiver definida (Q1 da spec)."
```

---

### Tarefa 5: Edge Function de captura

**Arquivos:**
- Criar: `supabase/functions/_shared/webhook_auth.ts`
- Criar: `supabase/functions/_shared/db.ts`
- Criar: `supabase/functions/capture-touchpoint/index.ts`
- Teste: `tests/unit/webhook_auth_test.ts`

**Interfaces:**
- Consome: `fromJid`, `toMatchKey` (Tarefa 2); `extrairAdReply` (Tarefa 3);
  tabelas da Tarefa 4.
- Produz: endpoint `POST /functions/v1/capture-touchpoint`;
  `validarAssinatura(req: Request, segredo: string): Promise<boolean>`.

> **DEPENDÊNCIA DO OPERADOR:** o passo 6 precisa da URL e da API key de uma
> instância Evolution para configurar o webhook. Ver "Dados Necessários".

- [ ] **Passo 1: Escrever o teste de assinatura que falha**

Criar `tests/unit/webhook_auth_test.ts`:

```typescript
import { assertEquals } from "jsr:@std/assert";
import { validarApiKey } from "../../supabase/functions/_shared/webhook_auth.ts";

Deno.test("aceita a apikey correta", () => {
  assertEquals(validarApiKey("CHAVE-ABC-123", "CHAVE-ABC-123"), true);
});

Deno.test("recusa apikey de outra instancia", () => {
  // Sem isso, o webhook de um cliente grava lead no tenant de outro
  assertEquals(validarApiKey("CHAVE-XYZ-999", "CHAVE-ABC-123"), false);
});

Deno.test("recusa quando o webhook nao manda apikey", () => {
  assertEquals(validarApiKey(null, "CHAVE-ABC-123"), false);
  assertEquals(validarApiKey(undefined, "CHAVE-ABC-123"), false);
  assertEquals(validarApiKey("", "CHAVE-ABC-123"), false);
});

Deno.test("recusa quando a instancia ainda nao tem chave cadastrada", () => {
  // Instancia recem-criada sem api_key nao pode aceitar qualquer webhook
  assertEquals(validarApiKey("qualquer-coisa", null), false);
  assertEquals(validarApiKey("qualquer-coisa", ""), false);
});

Deno.test("recusa chave de tamanho diferente sem vazar o tamanho", () => {
  assertEquals(validarApiKey("CHAVE-ABC", "CHAVE-ABC-123"), false);
  assertEquals(validarApiKey("CHAVE-ABC-123-EXTRA", "CHAVE-ABC-123"), false);
});

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
deno test tests/unit/webhook_auth_test.ts
```

Esperado: FALHA com `Module not found`.

- [ ] **Passo 3: Implementar a assinatura**

Criar `supabase/functions/_shared/webhook_auth.ts`:

```typescript
/**
 * Validação do webhook do Evolution.
 *
 * O Evolution não assina o corpo: ele manda a própria apikey da instância
 * dentro do payload (`body.apikey`). Então a validação é comparar essa
 * chave com a que o operador cadastrou para aquela instância.
 *
 * É mais fraco que HMAC — a chave viaja no corpo a cada requisição — mas
 * é o que o Evolution oferece hoje. TLS protege em trânsito, e a chave é
 * por instância, então um vazamento não alcança os outros clientes.
 */

/** Comparação em tempo constante: não revela a chave por timing. */
function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

export function validarApiKey(
  recebida: string | null | undefined,
  esperada: string | null | undefined,
): boolean {
  // Instancia sem chave cadastrada nao aceita webhook nenhum: na duvida,
  // recusar. Aceitar seria deixar uma instancia recem-criada aberta.
  if (!recebida || !esperada) return false;
  return iguais(recebida, esperada);
}
```

- [ ] **Passo 4: Rodar e confirmar que passa**

```bash
deno test tests/unit/webhook_auth_test.ts
```

Esperado: 5 testes passando.

- [ ] **Passo 5: Implementar a função de captura**

Criar `supabase/functions/_shared/db.ts`:

```typescript
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Cliente com service_role: contorna RLS por ser código confiável. */
export function admin(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}
```

Criar `supabase/functions/capture-touchpoint/index.ts`:

```typescript
import { admin } from "../_shared/db.ts";
import { validarApiKey } from "../_shared/webhook_auth.ts";
import { extrairAdReply } from "../_shared/ad_reply.ts";
import { fromJid, toMatchKey } from "../_shared/phone.ts";

/**
 * Remove o thumbnail em base64 antes de guardar o payload.
 * São ~6KB por lead, e a mesma imagem já está em thumbnailUrl. Guardar o
 * base64 de cada lead infla a tabela sem acrescentar informação.
 */
function enxugar(payload: Record<string, unknown>): Record<string, unknown> {
  const copia = structuredClone(payload) as any;
  const ad = copia?.data?.contextInfo?.externalAdReply;
  if (ad?.thumbnail) ad.thumbnail = "[removido: ver thumbnailUrl]";
  return copia;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const payload = await req.json().catch(() => null);
  if (!payload) return new Response("Bad Request", { status: 400 });

  const dados = payload.data ?? {};
  const instanciaUuid: string | null = dados.instanceId ?? null;
  const instanciaNome: string | null = payload.instance ?? null;

  if (!instanciaUuid && !instanciaNome) {
    return new Response("Payload sem identificacao de instancia", { status: 400 });
  }

  const db = admin();

  // Lookup pelo UUID quando existir: o nome pode ser renomeado no painel
  // do Evolution e quebraria o vinculo silenciosamente.
  const consulta = db.from("evolution_instances").select("id, tenant_id, api_key");
  const { data: inst } = await (instanciaUuid
    ? consulta.eq("evolution_instance_id", instanciaUuid)
    : consulta.eq("nome_instancia", instanciaNome)
  ).single();

  if (!inst) return new Response("Instancia desconhecida", { status: 404 });

  if (!validarApiKey(payload.apikey, inst.api_key)) {
    return new Response("Apikey invalida", { status: 401 });
  }

  // Marca a instancia viva ANTES de olhar se tem anuncio: mensagem
  // organica tambem prova que o rastreamento esta funcionando, e e
  // disso que o dead man's switch da Tarefa 10 depende.
  await db.from("evolution_instances")
    .update({ ultimo_evento_em: new Date().toISOString(), estado: "ativo" })
    .eq("id", inst.id);

  const anuncio = extrairAdReply(payload);
  if (!anuncio) {
    return Response.json({ ok: true, anuncio: false });
  }

  const jid = dados?.key?.remoteJid;
  const waMessageId = dados?.key?.id;
  if (!jid || !waMessageId) {
    return new Response("Payload sem identificacao de mensagem", { status: 400 });
  }

  // remoteJid e sempre a outra parte da conversa, com fromMe true ou
  // false. Entao e sempre o telefone do lead.
  const e164 = fromJid(jid);
  const timestamp = dados?.messageTimestamp;
  const recebidoEm = timestamp
    ? new Date(Number(timestamp) * 1000).toISOString()
    : new Date().toISOString();

  // O Evolution ja integrado ao Chatwoot manda os ids no proprio payload.
  // Quando vem, o vinculo nasce pronto e a reconciliacao nem precisa
  // acontecer. Quando nao vem, a Tarefa 7 recupera por telefone e tempo.
  const conversaChatwoot = dados?.chatwootConversationId ?? null;

  // ON CONFLICT DO NOTHING: Evolution reenvia webhook, e reenvia sempre
  const { error } = await db.from("ad_touchpoints").insert({
    tenant_id: inst.tenant_id,
    instance_id: inst.id,
    wa_message_id: waMessageId,
    phone_e164: e164,
    phone_match_key: toMatchKey(e164),
    ctwa_clid: anuncio.ctwaClid,
    ad_id: anuncio.adId,
    platform: anuncio.sourceApp,
    source_channel: "evolution",
    received_at: recebidoEm,
    raw_payload: enxugar(payload),
    chatwoot_conversation_id: conversaChatwoot,
    reconciled_at: conversaChatwoot ? new Date().toISOString() : null,
  });

  if (error && error.code !== "23505") {
    console.error("Falha ao gravar touchpoint", error);
    return new Response("Erro ao gravar", { status: 500 });
  }

  return Response.json({
    ok: true, anuncio: true,
    ad_id: anuncio.adId,
    ja_vinculado: conversaChatwoot !== null,
  });
});
```

- [ ] **Passo 6: Testar de ponta a ponta com a instância real**

```bash
supabase functions serve capture-touchpoint --env-file supabase/.env.local
```

Cadastrar a instância no banco, apontar o webhook do Evolution para a URL
local exposta, e enviar uma mensagem clicando num anúncio real.

Esperado: uma linha em `ad_touchpoints` com `ctwa_clid` e `ad_id`
preenchidos, e `raw_payload` com o payload completo.

- [ ] **Passo 7: Commit**

```bash
git add supabase/functions/ tests/unit/webhook_auth_test.ts
git commit -m "Captura de touchpoint a partir do webhook do Evolution

A instancia e marcada viva antes de checar se a mensagem veio de
anuncio: mensagem organica tambem prova que o rastreamento funciona,
e e nisso que o dead man's switch se baseia. Checar so mensagem de
anuncio daria falso alarme em conta de volume baixo.

Insercao idempotente por wa_message_id porque Evolution reenvia
webhook com frequencia, e lead duplicado inflaria o relatorio do
cliente.

Assinatura HMAC por instancia: sem ela, quem descobrir a URL injeta
lead falso no painel de um cliente."
```

---

### Tarefa 6: Enriquecimento do contato no Chatwoot

**Arquivos:**
- Criar: `supabase/functions/_shared/chatwoot.ts`
- Modificar: `supabase/functions/capture-touchpoint/index.ts`
- Criar: `supabase/migrations/20260918000300_chatwoot_config.sql`
- Teste: `tests/unit/chatwoot_test.ts`

**Interfaces:**
- Consome: `ad_touchpoints` (Tarefa 4), `AdReply` (Tarefa 3).
- Produz: `buscarContatoPorTelefone(cfg, telefone): Promise<number | null>`,
  `gravarAtributosDeOrigem(cfg, contatoId, origem): Promise<boolean>`,
  tipo `ChatwootConfig = { baseUrl: string; accountId: number; token: string }`.

> **DEPENDÊNCIA DO OPERADOR:** esta tarefa precisa da URL do Chatwoot, do
> `account_id` e de um `api_access_token`. Ver "Dados Necessários".

- [ ] **Passo 1: Escrever os testes que falham**

Criar `tests/unit/chatwoot_test.ts`:

```typescript
import { assertEquals } from "jsr:@std/assert";
import {
  buscarContatoPorTelefone,
  gravarAtributosDeOrigem,
} from "../../supabase/functions/_shared/chatwoot.ts";

const cfg = {
  baseUrl: "https://chat.exemplo.com",
  accountId: 1,
  token: "token-de-teste",
};

function mockFetch(resposta: unknown, status = 200) {
  const original = globalThis.fetch;
  const chamadas: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(resposta), {
        status, headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { chamadas, restaurar: () => { globalThis.fetch = original; } };
}

Deno.test("busca contato e devolve o id", async () => {
  const m = mockFetch({ payload: [{ id: 77, phone_number: "+5511900000000" }] });
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+5511900000000"), 77);
  } finally { m.restaurar(); }
});

Deno.test("devolve null quando o contato nao existe", async () => {
  // Acontece quando o Evolution chega antes do Chatwoot criar o contato.
  // Nao e erro: a reconciliacao da Tarefa 7 resolve depois.
  const m = mockFetch({ payload: [] });
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+5511900000000"), null);
  } finally { m.restaurar(); }
});

Deno.test("devolve null quando o Chatwoot esta fora do ar", async () => {
  // Chatwoot indisponivel nao pode derrubar a captura: o touchpoint
  // ja foi gravado e a reconciliacao recupera
  const m = mockFetch({ erro: "indisponivel" }, 503);
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+5511900000000"), null);
  } finally { m.restaurar(); }
});

Deno.test("grava os atributos de origem no contato", async () => {
  const m = mockFetch({ id: 77 });
  try {
    const ok = await gravarAtributosDeOrigem(cfg, 77, {
      ctwa_clid: "clid_x", ad_id: "ad_1",
      campaign_id: null, veio_de_anuncio: true,
    });
    assertEquals(ok, true);
    assertEquals(m.chamadas.length, 1);
    const corpo = JSON.parse(m.chamadas[0].init!.body as string);
    assertEquals(corpo.custom_attributes.ad_id, "ad_1");
    assertEquals(corpo.custom_attributes.veio_de_anuncio, true);
  } finally { m.restaurar(); }
});

Deno.test("envia o token no header esperado pelo Chatwoot", async () => {
  const m = mockFetch({ payload: [] });
  try {
    await buscarContatoPorTelefone(cfg, "+5511900000000");
    const headers = new Headers(m.chamadas[0].init!.headers);
    assertEquals(headers.get("api_access_token"), "token-de-teste");
  } finally { m.restaurar(); }
});
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
deno test --allow-net tests/unit/chatwoot_test.ts
```

Esperado: FALHA com `Module not found`.

- [ ] **Passo 3: Implementar o cliente**

Criar `supabase/functions/_shared/chatwoot.ts`:

```typescript
/**
 * Cliente da API do Chatwoot.
 *
 * Toda operação falha em silêncio devolvendo null/false. Isso é proposital:
 * o enriquecimento é best-effort, e Chatwoot fora do ar não pode derrubar a
 * captura — o touchpoint já está salvo e a reconciliação recupera depois.
 */

export type ChatwootConfig = {
  baseUrl: string;
  accountId: number;
  token: string;
};

export type OrigemDoLead = {
  ctwa_clid: string | null;
  ad_id: string | null;
  campaign_id: string | null;
  veio_de_anuncio: boolean;
};

function headers(cfg: ChatwootConfig): HeadersInit {
  return {
    "content-type": "application/json",
    "api_access_token": cfg.token,
  };
}

export async function buscarContatoPorTelefone(
  cfg: ChatwootConfig, telefone: string,
): Promise<number | null> {
  const url = `${cfg.baseUrl}/api/v1/accounts/${cfg.accountId}` +
    `/contacts/search?q=${encodeURIComponent(telefone)}`;
  try {
    const r = await fetch(url, { headers: headers(cfg) });
    if (!r.ok) return null;
    const j = await r.json();
    const primeiro = j?.payload?.[0];
    return typeof primeiro?.id === "number" ? primeiro.id : null;
  } catch {
    return null;
  }
}

export async function gravarAtributosDeOrigem(
  cfg: ChatwootConfig, contatoId: number, origem: OrigemDoLead,
): Promise<boolean> {
  const url = `${cfg.baseUrl}/api/v1/accounts/${cfg.accountId}/contacts/${contatoId}`;
  try {
    const r = await fetch(url, {
      method: "PUT",
      headers: headers(cfg),
      body: JSON.stringify({ custom_attributes: origem }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Passo 4: Migration da configuração do Chatwoot**

Criar `supabase/migrations/20260918000300_chatwoot_config.sql`:

```sql
create table chatwoot_configs (
  tenant_id   uuid primary key references tenants(id) on delete cascade,
  base_url    text not null default 'https://chat.leaderaperformance.com.br',
  -- Cadastrado manualmente pelo operador no onboarding de cada cliente
  account_id  bigint not null,
  -- Id da caixa de entrada, que chega em data.chatwootInboxId
  inbox_id    bigint,
  token_ref   text not null,   -- referencia no Vault, nunca o token
  criado_em   timestamptz not null default now()
);

alter table chatwoot_configs enable row level security;
-- Sem policy: so service_role acessa. Configuracao de integracao nao
-- e dado que o cliente precise ler no painel.
```

- [ ] **Passo 5: Ligar o enriquecimento à captura**

Em `supabase/functions/capture-touchpoint/index.ts`, antes do `return`
final, acrescentar:

```typescript
  // Enriquecimento best-effort: nunca bloqueia nem falha a resposta.
  // Se o contato ainda nao existe no Chatwoot, a Tarefa 7 reconcilia.
  try {
    const { data: cfgRow } = await db
      .from("chatwoot_configs")
      .select("base_url, account_id, token_ref")
      .eq("tenant_id", inst.tenant_id)
      .single();

    if (cfgRow) {
      const cfg = {
        baseUrl: cfgRow.base_url,
        accountId: Number(cfgRow.account_id),
        token: Deno.env.get(cfgRow.token_ref) ?? "",
      };
      const contatoId = await buscarContatoPorTelefone(cfg, e164);
      if (contatoId) {
        await gravarAtributosDeOrigem(cfg, contatoId, {
          ctwa_clid: anuncio.ctwaClid,
          ad_id: anuncio.adId,
          campaign_id: null,
          veio_de_anuncio: true,
        });
        await db.from("ad_touchpoints")
          .update({ chatwoot_contact_id: contatoId })
          .eq("tenant_id", inst.tenant_id)
          .eq("wa_message_id", waMessageId);
      }
    }
  } catch (e) {
    console.error("Enriquecimento falhou, reconciliacao recupera", e);
  }
```

E o import no topo do arquivo:

```typescript
import { buscarContatoPorTelefone, gravarAtributosDeOrigem } from "../_shared/chatwoot.ts";
```

- [ ] **Passo 6: Rodar todos os testes**

```bash
deno test --allow-net --allow-read tests/unit/
supabase test db
```

Esperado: tudo passando.

- [ ] **Passo 7: Commit**

```bash
git add supabase/ tests/unit/chatwoot_test.ts
git commit -m "Enriquecimento do contato no Chatwoot com a origem do lead

Toda chamada ao Chatwoot falha em silencio de proposito. O
enriquecimento e best-effort: o touchpoint ja esta salvo, e Chatwoot
fora do ar nao pode derrubar a captura nem perder o lead.

Contato inexistente nao e erro — e o caso normal de o Evolution
chegar antes do Chatwoot criar a conversa. A Tarefa 7 reconcilia.

Token do Chatwoot vai para o Vault por referencia: quem ler a
tabela de configuracao nao leva as credenciais junto."
```

---

### Tarefa 7: Reconciliação

**Arquivos:**
- Criar: `supabase/functions/chatwoot-events/index.ts`
- Criar: `supabase/migrations/20260918000400_reconciliacao.sql`
- Teste: `supabase/tests/database/03_reconciliacao.test.sql`

**Interfaces:**
- Consome: `ad_touchpoints` (Tarefa 4), `phone.ts` (Tarefa 2).
- Produz: tabela `chatwoot_conversations`, função
  `reconciliar_orfaos(janela_min int) returns int`, job `pg_cron` de 1 minuto.

**Decisão de desenho:** o webhook do Chatwoot grava as conversas numa tabela
local. Com isso a reconciliação vira um `JOIN` em SQL puro, sem chamada de
API. Reconciliação que depende de rede falha quando a rede falha — e falha
justamente durante o incidente em que você mais precisa dela.

- [ ] **Passo 1: Escrever o teste que falha**

Criar `supabase/tests/database/03_reconciliacao.test.sql`:

```sql
select unnest(array[
  extensions.plan(4),

insert into tenants (id, nome, slug)
values ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a');

-- Caso 1: Evolution chegou primeiro, Chatwoot depois
insert into ad_touchpoints
  (tenant_id, wa_message_id, phone_e164, phone_match_key,
   ctwa_clid, ad_id, source_channel, received_at, raw_payload)
values
  ('11111111-1111-1111-1111-111111111111', 'MSG_1', '+5511987654321',
   '551187654321', 'clid_1', 'ad_1', 'evolution',
   now() - interval '2 minutes', '{}'::jsonb);

insert into chatwoot_conversations
  (id, tenant_id, contact_id, phone_e164, phone_match_key, criada_em)
values
  (9001, '11111111-1111-1111-1111-111111111111', 501, '+5511987654321',
   '551187654321', now() - interval '1 minute');

select is(
  reconciliar_orfaos(15), 1,
  'reconcilia o touchpoint orfao com a conversa'
);

select is(
  (select chatwoot_conversation_id from ad_touchpoints
     where wa_message_id = 'MSG_1'),
  9001::bigint,
  'o vinculo aponta para a conversa correta'
);

-- Caso 2: o mesmo lead escrito sem o nono digito no Chatwoot
insert into ad_touchpoints
  (tenant_id, wa_message_id, phone_e164, phone_match_key,
   ctwa_clid, ad_id, source_channel, received_at, raw_payload)
values
  ('11111111-1111-1111-1111-111111111111', 'MSG_2', '+5511912345678',
   '551112345678', 'clid_2', 'ad_2', 'evolution',
   now() - interval '2 minutes', '{}'::jsonb);

insert into chatwoot_conversations
  (id, tenant_id, contact_id, phone_e164, phone_match_key, criada_em)
values
  (9002, '11111111-1111-1111-1111-111111111111', 502, '+551112345678',
   '551112345678', now() - interval '1 minute');

select is(
  reconciliar_orfaos(15), 1,
  'casa o lead mesmo com grafias diferentes do nono digito'
);

-- Caso 3: conversa muito depois do toque nao deve casar
insert into ad_touchpoints
  (tenant_id, wa_message_id, phone_e164, phone_match_key,
   ctwa_clid, ad_id, source_channel, received_at, raw_payload)
values
  ('11111111-1111-1111-1111-111111111111', 'MSG_3', '+5511955554444',
   '551155554444', 'clid_3', 'ad_3', 'evolution',
   now() - interval '5 hours', '{}'::jsonb);

insert into chatwoot_conversations
  (id, tenant_id, contact_id, phone_e164, phone_match_key, criada_em)
values
  (9003, '11111111-1111-1111-1111-111111111111', 503, '+5511955554444',
   '551155554444', now());

select is(
  reconciliar_orfaos(15), 0,
  'nao casa conversa fora da janela de tempo'
);

select * from finish();
rollback;
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
supabase test db
```

Esperado: FALHA com `function reconciliar_orfaos does not exist`.

- [ ] **Passo 3: Escrever a migration**

Criar `supabase/migrations/20260918000400_reconciliacao.sql`:

```sql
create extension if not exists pg_cron;

create table chatwoot_conversations (
  id               bigint primary key,
  tenant_id        uuid not null references tenants(id) on delete cascade,
  contact_id       bigint,
  phone_e164       text,
  phone_match_key  text,
  criada_em        timestamptz not null,
  registrada_em    timestamptz not null default now()
);

create index on chatwoot_conversations (tenant_id, phone_match_key, criada_em desc);

alter table chatwoot_conversations enable row level security;

create policy tenant_le_as_proprias_conversas on chatwoot_conversations
  for select to authenticated
  using (tenant_id = current_tenant_id());

/**
 * Liga touchpoints órfãos às conversas do Chatwoot.
 *
 * JOIN em SQL puro, sem chamada de API: reconciliação que depende de rede
 * falha durante o incidente em que ela é mais necessária.
 *
 * Casa pelo phone_match_key (tolerante ao nono dígito) dentro da janela,
 * e escolhe a conversa mais próxima no tempo quando há mais de uma.
 */
create or replace function reconciliar_orfaos(janela_min int default 15)
returns int
language plpgsql
as $$
declare
  ligados int;
begin
  with candidatos as (
    select distinct on (t.id)
      t.id as touchpoint_id,
      c.id as conversation_id,
      c.contact_id
    from ad_touchpoints t
    join chatwoot_conversations c
      on  c.tenant_id       = t.tenant_id
      and c.phone_match_key = t.phone_match_key
      and c.criada_em between t.received_at - make_interval(mins => janela_min)
                          and t.received_at + make_interval(mins => janela_min)
    where t.reconciled_at is null
    order by t.id, abs(extract(epoch from (c.criada_em - t.received_at)))
  )
  update ad_touchpoints t
     set chatwoot_conversation_id = k.conversation_id,
         chatwoot_contact_id      = coalesce(t.chatwoot_contact_id, k.contact_id),
         reconciled_at            = now()
    from candidatos k
   where t.id = k.touchpoint_id;

  get diagnostics ligados = row_count;
  return ligados;
end $$;

-- Varredura a cada minuto: terceira rede de seguranca, depois das duas
-- tentativas em tempo real (captura e webhook do Chatwoot)
select cron.schedule(
  'reconciliar-touchpoints-orfaos',
  '* * * * *',
  $$select reconciliar_orfaos(15)$$
);
```

- [ ] **Passo 4: Rodar e confirmar que passa**

```bash
supabase test db
```

Esperado: 4 testes passando.

- [ ] **Passo 5: Implementar o webhook do Chatwoot**

Criar `supabase/functions/chatwoot-events/index.ts`:

```typescript
import { admin } from "../_shared/db.ts";
import { toMatchKey } from "../_shared/phone.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const evento = await req.json().catch(() => null);
  if (!evento) return new Response("Bad Request", { status: 400 });

  if (evento.event !== "conversation_created") {
    return Response.json({ ok: true, ignorado: evento.event });
  }

  const contato = evento?.meta?.sender ?? evento?.contact;
  const telefone: string | undefined = contato?.phone_number;
  const contaId = evento?.account?.id ?? evento?.account_id;

  if (!telefone || !contaId) {
    return Response.json({ ok: true, semTelefone: true });
  }

  const db = admin();

  const { data: cfg } = await db
    .from("chatwoot_configs")
    .select("tenant_id")
    .eq("account_id", contaId)
    .single();

  if (!cfg) return new Response("Conta desconhecida", { status: 404 });

  await db.from("chatwoot_conversations").upsert({
    id: evento.id,
    tenant_id: cfg.tenant_id,
    contact_id: contato?.id ?? null,
    phone_e164: telefone,
    phone_match_key: toMatchKey(telefone),
    criada_em: evento.created_at ?? new Date().toISOString(),
  });

  // Tenta reconciliar na hora; se nao pegar, o cron de 1 minuto pega
  await db.rpc("reconciliar_orfaos", { janela_min: 15 });

  return Response.json({ ok: true });
});
```

- [ ] **Passo 6: Commit**

```bash
git add supabase/
git commit -m "Reconciliacao entre touchpoint e conversa do Chatwoot

Tres redes sobrepostas e nenhum lado esperando pelo outro: a captura
tenta ligar na hora, o webhook do Chatwoot tenta ao criar a conversa,
e o cron varre o que escapou. A corrida entre os dois sistemas deixa
de existir porque a ordem de chegada nao importa mais.

O JOIN e SQL puro sobre conversas ja gravadas, sem chamada de API:
reconciliacao que depende de rede falha exatamente durante o
incidente em que ela mais importa.

Com mais de uma conversa na janela, vence a mais proxima no tempo."
```

---

### Tarefa 8: Jornada do lead e regra de crédito

**Arquivos:**
- Criar: `supabase/migrations/20260918000500_lead_journey.sql`
- Teste: `supabase/tests/database/04_journey.test.sql`

**Interfaces:**
- Consome: `ad_touchpoints` (Tarefa 4).
- Produz: view `lead_journey`, função
  `atribuir_credito(p_tenant uuid, p_match_key text, p_quando timestamptz,
  p_janela_dias int) returns uuid`.

- [ ] **Passo 1: Escrever o teste que falha**

Criar `supabase/tests/database/04_journey.test.sql`:

```sql
begin;
select plan(5);

insert into tenants (id, nome, slug)
values ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a');

-- Um lead que entrou tres vezes por anuncios diferentes
insert into ad_touchpoints
  (tenant_id, wa_message_id, phone_e164, phone_match_key,
   ctwa_clid, ad_id, source_channel, received_at, raw_payload)
values
  ('11111111-1111-1111-1111-111111111111', 'M1', '+5511987654321',
   '551187654321', 'c1', 'ad_A', 'evolution',
   '2026-09-01 10:00:00+00', '{}'::jsonb),
  ('11111111-1111-1111-1111-111111111111', 'M2', '+5511987654321',
   '551187654321', 'c2', 'ad_B', 'evolution',
   '2026-09-01 15:00:00+00', '{}'::jsonb),
  ('11111111-1111-1111-1111-111111111111', 'M3', '+5511987654321',
   '551187654321', 'c3', 'ad_C', 'evolution',
   '2026-09-10 09:00:00+00', '{}'::jsonb);

select is(
  (select total_toques::int from lead_journey
     where phone_match_key = '551187654321'),
  3,
  'conta quantas vezes o lead entrou por anuncio'
);

select is(
  (select anuncios_distintos::int from lead_journey
     where phone_match_key = '551187654321'),
  3,
  'conta por quantos anuncios diferentes o lead entrou'
);

select is(
  (select primeiro_toque_em from lead_journey
     where phone_match_key = '551187654321'),
  '2026-09-01 10:00:00+00'::timestamptz,
  'guarda o primeiro toque, que a sobrescrita teria perdido'
);

-- Credito: venda em 12/09, janela de 7 dias -> ultimo toque dentro dela
select is(
  (select ad_id from ad_touchpoints
     where id = atribuir_credito(
       '11111111-1111-1111-1111-111111111111',
       '551187654321', '2026-09-12 14:00:00+00'::timestamptz, 7)),
  'ad_C',
  'credito vai para o ultimo toque dentro da janela'
);

-- Venda em 25/09: todos os toques ficaram fora da janela de 7 dias
select is(
  atribuir_credito(
    '11111111-1111-1111-1111-111111111111',
    '551187654321', '2026-09-25 14:00:00+00'::timestamptz, 7),
  null,
  'nao atribui credito a toque fora da janela'
);

select * from finish();
rollback;
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
supabase test db
```

Esperado: FALHA com `relation "lead_journey" does not exist`.

- [ ] **Passo 3: Escrever a migration**

Criar `supabase/migrations/20260918000500_lead_journey.sql`:

```sql
/**
 * Jornada do lead.
 *
 * Só existe porque ad_touchpoints é append-only. Se a origem fosse campo
 * do contato, cada retorno sobrescreveria o anterior e esta view não teria
 * o que agregar.
 */
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

/**
 * Escolhe qual toque recebe crédito por uma conversão.
 *
 * Último toque dentro da janela — mesma regra padrão da Meta, para o
 * relatório do painel bater com o do Gerenciador em vez de brigar com ele.
 *
 * Os toques anteriores continuam gravados e viram crédito de assistência
 * no painel: é o número que impede o cliente de matar um anúncio de topo
 * que traz o lead mas não aparece no relatório de último clique.
 */
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
```

`security_invoker = true` na view é obrigatório: sem isso a view roda com
os privilégios de quem a criou e contorna o RLS da tabela por baixo,
devolvendo dado de todos os tenants.

- [ ] **Passo 4: Rodar e confirmar que passa**

```bash
supabase test db
```

Esperado: 5 testes passando.

- [ ] **Passo 5: Commit**

```bash
git add supabase/
git commit -m "Jornada do lead e regra de credito por ultimo toque

A view so e possivel porque nada se sobrescreve: e ela que responde
quantas vezes o lead voltou, por quais anuncios e quando.

Credito por ultimo toque em 7 dias, igual ao padrao da Meta, para o
painel bater com o Gerenciador em vez de divergir dele sem
explicacao. Os toques anteriores viram assistencia, que e o numero
que evita matar anuncio de topo de funil.

security_invoker na view nao e detalhe: sem ele a view roda com o
privilegio de quem criou e devolve dado de todos os tenants,
contornando o RLS da tabela por baixo."
```

---

### Tarefa 9: Cache de metadata de anúncio

**Arquivos:**
- Criar: `supabase/functions/_shared/meta.ts`
- Criar: `supabase/functions/enrich-ad-metadata/index.ts`
- Criar: `supabase/migrations/20260918000600_metadata_cache.sql`
- Teste: `tests/unit/meta_test.ts`

**Interfaces:**
- Consome: `ad_touchpoints` (Tarefa 4).
- Produz: `buscarMetadataDoAnuncio(token, adId): Promise<AdMetadata | null>`,
  tipo `AdMetadata = { adName, adsetId, adsetName, campaignId, campaignName,
  objetivo }` — todos `string | null`.

O payload do Evolution traz só o `ad_id`. Campanha, conjunto e nomes legíveis
vêm de uma consulta à Meta, feita uma vez por anúncio e guardada em cache.

- [ ] **Passo 1: Escrever os testes que falham**

Criar `tests/unit/meta_test.ts`:

```typescript
import { assertEquals } from "jsr:@std/assert";
import { buscarMetadataDoAnuncio } from "../../supabase/functions/_shared/meta.ts";

function mockFetch(resposta: unknown, status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify(resposta), {
      status, headers: { "content-type": "application/json" },
    }))) as typeof fetch;
  return { restaurar: () => { globalThis.fetch = original; } };
}

Deno.test("mapeia a resposta da Meta para o formato interno", async () => {
  const m = mockFetch({
    id: "123",
    name: "Criativo A",
    adset: { id: "456", name: "Conjunto 1" },
    campaign: { id: "789", name: "Campanha X", objective: "MESSAGES" },
  });
  try {
    const r = await buscarMetadataDoAnuncio("token", "123");
    assertEquals(r!.adName, "Criativo A");
    assertEquals(r!.adsetId, "456");
    assertEquals(r!.campaignId, "789");
    assertEquals(r!.objetivo, "MESSAGES");
  } finally { m.restaurar(); }
});

Deno.test("devolve null quando o token expirou", async () => {
  // Token da Meta expira. Isso nao pode derrubar a captura de leads:
  // o touchpoint ja esta salvo com o ad_id e enriquece depois.
  const m = mockFetch({ error: { code: 190, message: "expirado" } }, 401);
  try {
    assertEquals(await buscarMetadataDoAnuncio("token", "123"), null);
  } finally { m.restaurar(); }
});

Deno.test("devolve null quando o anuncio foi apagado", async () => {
  const m = mockFetch({ error: { code: 100, message: "nao existe" } }, 400);
  try {
    assertEquals(await buscarMetadataDoAnuncio("token", "999"), null);
  } finally { m.restaurar(); }
});

Deno.test("aceita anuncio sem conjunto ou campanha", async () => {
  const m = mockFetch({ id: "123", name: "Criativo A" });
  try {
    const r = await buscarMetadataDoAnuncio("token", "123");
    assertEquals(r!.adName, "Criativo A");
    assertEquals(r!.campaignId, null);
  } finally { m.restaurar(); }
});
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
deno test --allow-net tests/unit/meta_test.ts
```

Esperado: FALHA com `Module not found`.

- [ ] **Passo 3: Implementar**

Criar `supabase/functions/_shared/meta.ts`:

```typescript
/**
 * Consulta de metadata de anúncio na Graph API.
 *
 * O payload do Evolution traz só o ad_id. Campanha, conjunto e nomes
 * legíveis vêm daqui — uma vez por anúncio, depois é cache.
 *
 * Falha sempre devolve null: token expirado ou anúncio apagado não pode
 * derrubar a captura de leads, que já gravou o ad_id e enriquece depois.
 */

const VERSAO = "v21.0";

export type AdMetadata = {
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  objetivo: string | null;
};

export async function buscarMetadataDoAnuncio(
  token: string, adId: string,
): Promise<AdMetadata | null> {
  const campos = "id,name,adset{id,name},campaign{id,name,objective}";
  const url = `https://graph.facebook.com/${VERSAO}/${adId}` +
    `?fields=${encodeURIComponent(campos)}&access_token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.error) return null;
    return {
      adName: j.name ?? null,
      adsetId: j.adset?.id ?? null,
      adsetName: j.adset?.name ?? null,
      campaignId: j.campaign?.id ?? null,
      campaignName: j.campaign?.name ?? null,
      objetivo: j.campaign?.objective ?? null,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Passo 4: Migration do cache**

Criar `supabase/migrations/20260918000600_metadata_cache.sql`:

```sql
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

alter table ad_metadata_cache enable row level security;

create policy tenant_le_o_proprio_cache on ad_metadata_cache
  for select to authenticated
  using (tenant_id = current_tenant_id());

-- Touchpoints ainda sem campanha resolvida. A funcao de enriquecimento
-- varre esta lista; enquanto nao houver token da Meta configurado, ela
-- fica parada sem quebrar nada.
create view touchpoints_sem_metadata
with (security_invoker = true)
as
select distinct t.tenant_id, t.ad_id
  from ad_touchpoints t
  left join ad_metadata_cache c on c.ad_id = t.ad_id
 where t.ad_id is not null
   and t.campaign_id is null
   and c.ad_id is null;
```

- [ ] **Passo 5: Implementar a função de enriquecimento**

Criar `supabase/functions/enrich-ad-metadata/index.ts`:

```typescript
import { admin } from "../_shared/db.ts";
import { buscarMetadataDoAnuncio } from "../_shared/meta.ts";

/**
 * Varre os touchpoints sem campanha resolvida e preenche a partir da Meta.
 *
 * Roda separado da captura de propósito: é a única parte que depende de
 * token da Meta, e token expirado não pode fazer o sistema perder lead.
 */
Deno.serve(async () => {
  const db = admin();

  const { data: pendentes } = await db
    .from("touchpoints_sem_metadata")
    .select("tenant_id, ad_id")
    .limit(50);

  if (!pendentes?.length) {
    return Response.json({ ok: true, processados: 0 });
  }

  let resolvidos = 0;

  for (const linha of pendentes) {
    const { data: conta } = await db
      .from("ad_accounts")
      .select("token_ref")
      .eq("tenant_id", linha.tenant_id)
      .limit(1)
      .single();

    // Sem token configurado ainda: sai sem erro, tenta no proximo ciclo
    if (!conta?.token_ref) continue;

    const token = Deno.env.get(conta.token_ref);
    if (!token) continue;

    const meta = await buscarMetadataDoAnuncio(token, linha.ad_id);
    if (!meta) continue;

    await db.from("ad_metadata_cache").upsert({
      ad_id: linha.ad_id,
      tenant_id: linha.tenant_id,
      ad_name: meta.adName,
      adset_id: meta.adsetId,
      adset_name: meta.adsetName,
      campaign_id: meta.campaignId,
      campaign_name: meta.campaignName,
      objetivo: meta.objetivo,
      atualizado_em: new Date().toISOString(),
    });

    // Propaga para os touchpoints. Campanha e conjunto estao fora do
    // trigger de append-only justamente para permitir este preenchimento.
    await db.from("ad_touchpoints")
      .update({ adset_id: meta.adsetId, campaign_id: meta.campaignId })
      .eq("tenant_id", linha.tenant_id)
      .eq("ad_id", linha.ad_id);

    resolvidos++;
  }

  return Response.json({ ok: true, processados: resolvidos });
});
```

- [ ] **Passo 6: Agendar o enriquecimento**

Acrescentar ao final de `20260918000600_metadata_cache.sql`:

```sql
-- De 10 em 10 minutos. Anuncio novo aparece no painel com nome legivel
-- em ate 10 minutos; nao ha urgencia porque o lead ja foi capturado.
select cron.schedule(
  'enriquecer-metadata-de-anuncio',
  '*/10 * * * *',
  $$select net.http_post(
      url := current_setting('app.functions_base_url', true)
             || '/enrich-ad-metadata',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || current_setting('app.service_role_key', true)
      )
    )$$
);
```

- [ ] **Passo 7: Rodar todos os testes**

```bash
deno test --allow-net --allow-read tests/unit/
supabase test db
```

Esperado: tudo passando.

- [ ] **Passo 8: Commit**

```bash
git add supabase/ tests/unit/meta_test.ts
git commit -m "Cache de metadata de anuncio vindo da Graph API

O payload do Evolution traz so o ad_id. Campanha, conjunto e nome
legivel vem de uma consulta por anuncio, depois e cache.

Enriquecimento e best-effort e roda separado da captura: token da
Meta expirado ou anuncio apagado nao pode fazer o sistema perder
lead. O touchpoint ja esta gravado com o ad_id e enriquece quando
der."
```

---

### Tarefa 10: Monitoramento das instâncias

**Arquivos:**
- Criar: `supabase/migrations/20260918000700_monitoramento.sql`
- Teste: `supabase/tests/database/05_monitoramento.test.sql`

**Interfaces:**
- Consome: `evolution_instances` (Tarefa 1).
- Produz: tabela `alertas`, função `checar_silencio_das_instancias() returns int`,
  job `pg_cron` de 5 minutos.

> **DEPENDÊNCIA DO OPERADOR:** o passo 5 precisa da URL de webhook para onde
> os alertas serão enviados. Ver "Dados Necessários".

- [ ] **Passo 1: Escrever o teste que falha**

Criar `supabase/tests/database/05_monitoramento.test.sql`:

```sql
select unnest(array[
  extensions.plan(4),

insert into tenants (id, nome, slug)
values ('11111111-1111-1111-1111-111111111111', 'Cliente A', 'cliente-a');

-- Instancia em silencio ha 3h, limite de 2h, dentro do horario comercial
insert into evolution_instances
  (id, tenant_id, nome_instancia, url_base, api_key,
   ultimo_evento_em, silencio_limite_min, horario_inicio, horario_fim)
values
  ('aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111', 'inst-muda',
   'http://x', 's3cr3t', now() - interval '3 hours', 120, '00:00', '23:59');

-- Instancia saudavel, recebeu ha 5 minutos
insert into evolution_instances
  (id, tenant_id, nome_instancia, url_base, api_key,
   ultimo_evento_em, silencio_limite_min, horario_inicio, horario_fim)
values
  ('aaaaaaaa-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111', 'inst-viva',
   'http://x', 's3cr3t', now() - interval '5 minutes', 120, '00:00', '23:59');

-- Instancia muda, mas fora do horario comercial dela
insert into evolution_instances
  (id, tenant_id, nome_instancia, url_base, api_key,
   ultimo_evento_em, silencio_limite_min, horario_inicio, horario_fim)
values
  ('aaaaaaaa-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111', 'inst-fora-de-horario',
   'http://x', 's3cr3t', now() - interval '6 hours', 120,
   (now() + interval '2 hours')::time, (now() + interval '4 hours')::time);

select is(
  checar_silencio_das_instancias(), 1,
  'alerta apenas a instancia muda dentro do horario comercial'
);

select is(
  (select count(*)::int from alertas where instance_id =
     'aaaaaaaa-0000-0000-0000-000000000001'),
  1, 'registra o alerta da instancia muda'
);

select is(
  (select count(*)::int from alertas where instance_id =
     'aaaaaaaa-0000-0000-0000-000000000003'),
  0, 'nao alerta fora do horario comercial configurado'
);

-- Segunda execucao nao deve duplicar o alerta ainda aberto
select is(
  checar_silencio_das_instancias(), 0,
  'nao repete alerta ainda em aberto'
);

select * from finish();
rollback;
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
supabase test db
```

Esperado: FALHA com `function checar_silencio_das_instancias does not exist`.

- [ ] **Passo 3: Escrever a migration**

Criar `supabase/migrations/20260918000700_monitoramento.sql`:

```sql
create table alertas (
  id           bigserial primary key,
  tenant_id    uuid references tenants(id) on delete cascade,
  instance_id  uuid references evolution_instances(id) on delete cascade,
  tipo         text not null,
  mensagem     text not null,
  aberto_em    timestamptz not null default now(),
  fechado_em   timestamptz,
  notificado_em timestamptz
);

create index on alertas (instance_id, tipo) where fechado_em is null;

create table instance_health (
  id             bigserial primary key,
  instance_id    uuid not null references evolution_instances(id) on delete cascade,
  estado         text not null,
  detalhe        text,
  registrado_em  timestamptz not null default now()
);

alter table alertas         enable row level security;
alter table instance_health enable row level security;

create policy tenant_le_os_proprios_alertas on alertas
  for select to authenticated
  using (tenant_id = current_tenant_id());

/**
 * Dead man's switch.
 *
 * Instância "conectada" que parou de receber mensagem não dispara alarme
 * de uptime nenhum — a falha só aparece quando o cliente reclama que o
 * relatório zerou. Esta função é a que pega esse caso.
 *
 * Respeita o horário comercial por instância: silêncio às 3h da manhã é
 * normal, silêncio às 14h não é.
 */
create or replace function checar_silencio_das_instancias()
returns int
language plpgsql
as $$
declare
  novos int;
begin
  with mudas as (
    select i.id, i.tenant_id, i.nome_instancia, i.ultimo_evento_em,
           i.silencio_limite_min
      from evolution_instances i
     where i.ultimo_evento_em is not null
       and i.ultimo_evento_em <
           now() - make_interval(mins => i.silencio_limite_min)
       and localtime between i.horario_inicio and i.horario_fim
       and not exists (
         select 1 from alertas a
          where a.instance_id = i.id
            and a.tipo        = 'silencio'
            and a.fechado_em is null
       )
  )
  insert into alertas (tenant_id, instance_id, tipo, mensagem)
  select m.tenant_id, m.id, 'silencio',
         format(
           'Instancia %s sem mensagens ha %s minutos (limite: %s)',
           m.nome_instancia,
           round(extract(epoch from (now() - m.ultimo_evento_em)) / 60),
           m.silencio_limite_min
         )
    from mudas m;

  get diagnostics novos = row_count;

  -- Snapshot do estado de cada instancia. Alimenta o historico de saude
  -- que o painel mostra ao cliente: sem serie temporal, "esta ativo agora"
  -- nao diz se caiu tres vezes esta semana.
  insert into instance_health (instance_id, estado, detalhe)
  select i.id,
         case when i.ultimo_evento_em >=
                   now() - make_interval(mins => i.silencio_limite_min)
              then 'saudavel' else 'mudo' end,
         format('ultimo evento: %s', coalesce(i.ultimo_evento_em::text, 'nunca'))
    from evolution_instances i;

  -- Fecha alertas de instancias que voltaram a receber
  update alertas a
     set fechado_em = now()
    from evolution_instances i
   where a.instance_id = i.id
     and a.tipo        = 'silencio'
     and a.fechado_em is null
     and i.ultimo_evento_em >=
         now() - make_interval(mins => i.silencio_limite_min);

  return novos;
end $$;

select cron.schedule(
  'checar-silencio-das-instancias',
  '*/5 * * * *',
  $$select checar_silencio_das_instancias()$$
);
```

O `not exists` sobre alertas abertos é o que impede o job de criar um alerta
novo a cada 5 minutos enquanto a instância segue muda. Alerta repetido vira
ruído, e ruído faz o operador ignorar alerta de verdade.

- [ ] **Passo 4: Rodar e confirmar que passa**

```bash
supabase test db
```

Esperado: 4 testes passando.

- [ ] **Passo 5: Entregar o alerta**

Criar `supabase/migrations/20260918000800_notificar_alertas.sql`:

```sql
create extension if not exists pg_net;

-- A URL de destino fica em configuracao do banco, nao no codigo:
--   alter database postgres set app.alert_webhook_url = 'https://...';
create or replace function notificar_alertas_pendentes()
returns int
language plpgsql
as $$
declare
  destino text := current_setting('app.alert_webhook_url', true);
  enviados int := 0;
  a record;
begin
  if destino is null or destino = '' then
    return 0;
  end if;

  for a in
    select id, mensagem from alertas
     where notificado_em is null and fechado_em is null
     order by aberto_em
     limit 20
  loop
    perform net.http_post(
      url     := destino,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := jsonb_build_object('texto', a.mensagem)
    );
    update alertas set notificado_em = now() where id = a.id;
    enviados := enviados + 1;
  end loop;

  return enviados;
end $$;

select cron.schedule(
  'notificar-alertas',
  '*/5 * * * *',
  $$select notificar_alertas_pendentes()$$
);
```

- [ ] **Passo 6: Commit**

```bash
git add supabase/
git commit -m "Dead man's switch das instancias Evolution

Instancia conectada que parou de receber mensagem nao dispara alarme
de uptime: a falha so aparece quando o cliente reclama que o
relatorio zerou, ja com dias de lead perdido. Este check e o que
pega esse caso, que e o mais comum e o mais caro.

Horario comercial por instancia evita alerta as 3h da manha por
silencio que e normal.

Alerta ja aberto nao e recriado a cada ciclo: alerta repetido vira
ruido, e ruido faz o operador ignorar o alerta que importa."
```

---

## Dados Necessários do Operador

Nenhum é preciso para começar. Cada um trava a tarefa indicada.

| Quando | O que | Onde encontrar |
|---|---|---|
| **Tarefa 3** | 5 payloads reais do Evolution: primeira mensagem de anúncio em texto, imagem, vídeo e áudio, e uma mensagem comum | Webhook da instância, ou `GET /chat/findMessages` |
| **Tarefa 5** | URL base e API key de uma instância Evolution | Painel do Evolution |
| **Tarefa 6** | URL do Chatwoot, `account_id`, e um `api_access_token` | Chatwoot → Perfil → Tokens de acesso |
| **Tarefa 10** | URL de webhook para onde mandar os alertas | Sua escolha: Evolution do próprio operador, Telegram, Slack |

As Tarefas 1, 2, 4, 7, 8 e 9 rodam inteiras sem nada disso — são schema,
lógica pura e SQL, todas testáveis contra o Postgres local.

## Ordem de Execução

```
Tarefa 1  fundação multi-tenant + RLS          ─┐
Tarefa 2  normalização de telefone             ─┤ sem dependência externa
Tarefa 4  schema do núcleo                     ─┘
Tarefa 3  extração do adReply                  ← payloads reais
Tarefa 5  Edge Function de captura             ← instância Evolution
Tarefa 6  enriquecimento no Chatwoot           ← credenciais Chatwoot
Tarefa 7  reconciliação                        ─┐
Tarefa 8  jornada e crédito                    ─┤ sem dependência externa
Tarefa 9  cache de metadata                    ─┘
Tarefa 10 monitoramento                        ← URL de alerta
```

Tarefas 1, 2 e 4 podem começar imediatamente. A 3 é a que valida a premissa
P1 da spec — quanto antes os payloads reais chegarem, antes se confirma que
o `ctwaClid` está mesmo vindo na versão em uso.

## Cobertura da Spec

| Seção da spec | Tarefa |
|---|---|
| 6.1 Fundação multi-tenant | 1 |
| 6.2 Núcleo append-only | 4 |
| 6.3 Operação (health, cache) | 9, 10 |
| 6.4 Normalização de telefone | 2 |
| 7 Fluxo de captura | 3, 5, 6 |
| 8.1 Ligar touchpoint à conversa | 7 |
| 8.2 Jornada do lead | 8 |
| 8.3 Regra de crédito | 8 |
| 9 Monitoramento | 10 |
| 10 Segurança e multi-tenancy | 1, 4, 5 (assinatura), todas (RLS) |
| 11 Testes | embutido em todas |
