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
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(resposta), {
        status,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
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
