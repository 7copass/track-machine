import { assertEquals } from "jsr:@std/assert";
import { buscarMetadataDoAnuncio } from "../../supabase/functions/_shared/meta.ts";

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
