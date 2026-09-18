import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { extrairAdReply } from "../../supabase/functions/_shared/ad_reply.ts";

async function fixture(nome: string): Promise<unknown> {
  const texto = await Deno.readTextFile(`tests/fixtures/evolution/${nome}.json`);
  return JSON.parse(texto);
}

// ─── Contrato real, provado pelos dois payloads capturados ──────

Deno.test("extrai da fixture com messageType conversation", async () => {
  const r = extrairAdReply(await fixture("conversation_ctwa_instagram"));
  assertNotEquals(r, null);
  assertNotEquals(r!.ctwaClid, null);
  assertEquals(r!.adId, "120228996863460382");
});

Deno.test("extrai da fixture com messageType extendedTextMessage", async () => {
  const r = extrairAdReply(await fixture("extendedtext_ctwa_sem_chatwoot"));
  assertNotEquals(r, null);
  assertNotEquals(r!.ctwaClid, null);
  assertEquals(r!.adId, "120223766489610787");
});

Deno.test("usa sourceApp quando a versao do Evolution o envia", async () => {
  const r = extrairAdReply(await fixture("conversation_ctwa_instagram"));
  assertEquals(r!.sourceApp, "instagram");
});

Deno.test("deduz a plataforma pelo sourceUrl quando sourceApp nao existe", async () => {
  // A versao mais antiga nao manda sourceApp. Confirmado nos dois payloads.
  const r = extrairAdReply(await fixture("extendedtext_ctwa_sem_chatwoot"));
  assertEquals(r!.sourceApp, "instagram");
});

// ─── Sondas estruturais: objetos sintéticos, para provar que a
//     extração não depende de posição. NÃO afirmam que o Evolution
//     produza estas formas — nos dois payloads reais o contextInfo
//     está sempre em data.contextInfo.

Deno.test("sonda: acha o adReply aninhado sob um tipo de mensagem", () => {
  const p = { data: { message: { imageMessage: { contextInfo: {
    externalAdReply: { sourceId: "999", sourceType: "ad", ctwaClid: "x" },
  } } } } };
  assertEquals(extrairAdReply(p)!.adId, "999");
});

Deno.test("sonda: acha o adReply em profundidade maior", () => {
  const p = { a: { b: { c: { d: { externalAdReply: { sourceId: "777" } } } } } };
  assertEquals(extrairAdReply(p)!.adId, "777");
});

Deno.test("sonda: nao deduz plataforma pelo mediaUrl", () => {
  // mediaUrl aponta para facebook.com mesmo em anuncio do Instagram —
  // e so onde o video esta hospedado. Usar ele classificaria errado.
  const p = { data: { contextInfo: { externalAdReply: {
    sourceId: "1", sourceType: "ad",
    sourceUrl: "https://www.instagram.com/p/ABC/",
    mediaUrl: "https://www.facebook.com/alguem/videos/123/",
  } } } };
  assertEquals(extrairAdReply(p)!.sourceApp, "instagram");
});

// ─── Ausência e robustez ────────────────────────────────────────

Deno.test("devolve null em mensagem sem anuncio", async () => {
  // Mesma fixture real, com o contextInfo removido: e o que chega em
  // toda conversa organica, que e a maioria do trafego do webhook.
  const p = await fixture("extendedtext_ctwa_sem_chatwoot") as any;
  delete p.data.contextInfo;
  assertEquals(extrairAdReply(p), null);
});

Deno.test("devolve null sem estourar em payload malformado", () => {
  assertEquals(extrairAdReply(null), null);
  assertEquals(extrairAdReply({}), null);
  assertEquals(extrairAdReply({ data: { message: null } }), null);
  assertEquals(extrairAdReply("texto solto"), null);
  assertEquals(extrairAdReply([1, 2, 3]), null);
});

Deno.test("nao entra em loop com referencia circular", () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  assertEquals(extrairAdReply(circular), null);
});

Deno.test("sobrevive a anuncio sem ctwaClid", () => {
  // Se o protocolo mudar e o clid sumir, o adId ainda mantem o lead
  // atribuivel a campanha, mesmo perdendo a atribuicao de clique.
  const p = { data: { contextInfo: { externalAdReply: {
    sourceId: "123456", sourceType: "ad",
  } } } };
  const r = extrairAdReply(p);
  assertEquals(r!.adId, "123456");
  assertEquals(r!.ctwaClid, null);
});
