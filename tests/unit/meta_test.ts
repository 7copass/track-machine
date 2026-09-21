import { assertEquals } from "jsr:@std/assert";
import {
  buscarMetadataDoAnuncio,
  ultimaFalha,
} from "../../supabase/functions/_shared/meta.ts";

// Nao ha credencial da Meta neste projeto, e nem deveria haver para rodar
// teste: o que precisa ser provado aqui e o mapeamento da resposta e o
// comportamento diante de falha, nao a Graph API. Por isso o fetch e
// trocado por um duble e restaurado no finally de cada caso -- deixar o
// global trocado contaminaria o teste seguinte.
function mockFetch(resposta: unknown, status = 200) {
  const original = globalThis.fetch;
  // As urls ficam gravadas porque parte do contrato com a Graph API esta
  // na chamada, nao na resposta: um mock que devolve destination_type
  // independentemente do que foi pedido deixaria passar um `fields` sem o
  // campo, e em producao a Meta simplesmente nao o devolveria.
  const chamadas: string[] = [];
  globalThis.fetch = ((url: string | URL | Request) => {
    chamadas.push(String(url));
    return Promise.resolve(
      new Response(JSON.stringify(resposta), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { chamadas, restaurar: () => { globalThis.fetch = original; } };
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

// ─── ultimaFalha: distinguir "nada a fazer" de "tudo quebrado" ──

Deno.test("registra falha de rede em ultimaFalha", async () => {
  // O tipo declara "rede" como valor possivel. Se o catch devolve null sem
  // atribuir, a variavel fica null — que quem le interpreta como "nenhuma
  // falha". E o falso-verde que este campo existe para eliminar.
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError("conexao recusada"))) as typeof fetch;
  try {
    assertEquals(await buscarMetadataDoAnuncio("token", "123"), null);
    const { ultimaFalha: f } = await import(
      "../../supabase/functions/_shared/meta.ts"
    );
    assertEquals(f, "rede");
  } finally { globalThis.fetch = original; }
});

Deno.test("registra o motivo certo para cada tipo de falha", async () => {
  const original = globalThis.fetch;
  const mod = await import("../../supabase/functions/_shared/meta.ts");

  globalThis.fetch = (() => Promise.resolve(
    new Response("{}", { status: 500 }))) as typeof fetch;
  await buscarMetadataDoAnuncio("token", "1");
  assertEquals(mod.ultimaFalha, "http");

  globalThis.fetch = (() => Promise.resolve(new Response(
    JSON.stringify({ error: { code: 190, message: "expirado" } }),
    { status: 200 }))) as typeof fetch;
  await buscarMetadataDoAnuncio("token", "1");
  assertEquals(mod.ultimaFalha, "erro_api");

  // Sucesso precisa limpar: falha velha colada depois que a Meta volta
  // faria o alerta disparar para sempre.
  globalThis.fetch = (() => Promise.resolve(new Response(
    JSON.stringify({ id: "1", name: "ok" }), { status: 200 }))) as typeof fetch;
  await buscarMetadataDoAnuncio("token", "1");
  assertEquals(mod.ultimaFalha, null);

  globalThis.fetch = original;
});

// ─── Tipo de campanha: o objetivo nao basta ─────────────────────

Deno.test("traz destination_type e optimization_goal do conjunto", async () => {
  // Campanha de mensagem e de seguidores aparecem AMBAS como
  // OUTCOME_ENGAGEMENT. Verificado na conta real: 191 conjuntos WHATSAPP
  // contra 4 INSTAGRAM_PROFILE, todos sob o mesmo objetivo. Sem estes dois
  // campos, as duas entram misturadas no mesmo relatorio e o CPL de uma
  // campanha que nao tem lead poluiria a media.
  const m = mockFetch({
    id: "123",
    name: "Criativo A",
    adset: {
      id: "456",
      name: "Conjunto 1",
      destination_type: "WHATSAPP",
      optimization_goal: "CONVERSATIONS",
    },
    campaign: { id: "789", name: "Campanha X", objective: "OUTCOME_ENGAGEMENT" },
  });
  try {
    const r = await buscarMetadataDoAnuncio("token", "123");
    assertEquals(r!.destinationType, "WHATSAPP");
    assertEquals(r!.optimizationGoal, "CONVERSATIONS");
  } finally { m.restaurar(); }
});

Deno.test("aceita conjunto sem destination_type", async () => {
  const m = mockFetch({ id: "123", name: "A", adset: { id: "4", name: "C" } });
  try {
    const r = await buscarMetadataDoAnuncio("token", "123");
    assertEquals(r!.destinationType, null);
    assertEquals(r!.optimizationGoal, null);
  } finally { m.restaurar(); }
});

Deno.test("pede os campos novos na consulta, nao so os le", async () => {
  // Mapear o retorno sem pedir o campo passa nos testes e falha em
  // producao: a Meta devolve exatamente o que o `fields` lista, e o
  // destination_type sairia null para sempre, sem erro nenhum.
  const m = mockFetch({ id: "1", name: "A" });
  try {
    await buscarMetadataDoAnuncio("token", "1");
    const url = decodeURIComponent(m.chamadas[0]);
    assertEquals(url.includes("destination_type"), true);
    assertEquals(url.includes("optimization_goal"), true);
    assertEquals(url.includes("account_id"), true);
  } finally { m.restaurar(); }
});

// ─── A conta de origem do anuncio ───────────────────────────────

Deno.test("traz a conta de anuncio a que o anuncio pertence", async () => {
  // O fuso do CPL diario e resolvido pela conta DO ANUNCIO. Um tenant com
  // duas contas — que e o caso real — nao permite deduzir isso de
  // "alguma conta do tenant": tem de vir do proprio anuncio.
  const m = mockFetch({ id: "1", name: "A", account_id: "269873128000933" });
  try {
    const r = await buscarMetadataDoAnuncio("token", "1");
    assertEquals(r!.actId, "act_269873128000933");
  } finally { m.restaurar(); }
});

Deno.test("nao duplica o prefixo act_ nem inventa conta que nao veio", async () => {
  const m1 = mockFetch({ id: "1", name: "A", account_id: "act_123" });
  try {
    assertEquals((await buscarMetadataDoAnuncio("token", "1"))!.actId, "act_123");
  } finally { m1.restaurar(); }

  const m2 = mockFetch({ id: "1", name: "A" });
  try {
    assertEquals((await buscarMetadataDoAnuncio("token", "1"))!.actId, null);
  } finally { m2.restaurar(); }
});
