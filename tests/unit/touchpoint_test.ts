import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import {
  ehDescarte,
  type LinhaTouchpoint,
  montarTouchpoint,
} from "../../supabase/functions/_shared/touchpoint.ts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const INSTANCIA = "33333333-3333-3333-3333-333333333333";

// deno-lint-ignore no-explicit-any
async function fixture(nome: string): Promise<any> {
  const texto = await Deno.readTextFile(`tests/fixtures/evolution/${nome}.json`);
  return JSON.parse(texto);
}

/** Estreita o tipo e falha com mensagem legivel se tiver vindo descarte. */
function linha(r: ReturnType<typeof montarTouchpoint>): LinhaTouchpoint {
  if (ehDescarte(r)) {
    throw new Error(`esperava linha, veio descarte: ${r.descartar}`);
  }
  return r;
}

// ─── Extracao completa dos dois payloads reais ──────────────────
//
// Campo a campo de proposito: a montagem da linha e o ponto onde um
// erro de nome de coluna ou de unidade de timestamp passa despercebido
// ate alguem abrir a tabela semanas depois.

Deno.test("monta a linha inteira do payload real com messageType conversation", async () => {
  const r = linha(montarTouchpoint(
    await fixture("conversation_ctwa_instagram"),
    TENANT,
    INSTANCIA,
  ));

  assertEquals(r.tenant_id, TENANT);
  assertEquals(r.instance_id, INSTANCIA);
  assertEquals(r.wa_message_id, "23DFF1513A3BF590939A24D773DE45E2");
  assertEquals(r.phone_e164, "+559392572839");
  assertEquals(r.phone_match_key, "559392572839");
  assertEquals(r.ad_id, "120228996863460382");
  assertEquals(r.platform, "instagram");
  assertEquals(r.source_channel, "evolution");
  assertNotEquals(r.ctwa_clid, null);

  // messageTimestamp e epoch em SEGUNDOS. Repassar o numero cru gravaria
  // a data de 1970 em todo lead, e o relatorio por periodo do cliente
  // viria vazio sem nenhum erro.
  assertEquals(r.received_at, "2025-07-28T15:19:56.000Z");
});

Deno.test("monta a linha inteira do payload real com messageType extendedTextMessage", async () => {
  const r = linha(montarTouchpoint(
    await fixture("extendedtext_ctwa_sem_chatwoot"),
    TENANT,
    INSTANCIA,
  ));

  assertEquals(r.wa_message_id, "87FDBB3D7F5D2820847CC01FE7CA168B");
  assertEquals(r.phone_e164, "+5591981617148");
  // Nono digito removido: e a grafia com que o Chatwoot pode ter gravado
  // o mesmo lead, e sem o corte o join nao encontraria a conversa.
  assertEquals(r.phone_match_key, "559181617148");
  assertEquals(r.ad_id, "120223766489610787");
  // Esta versao do Evolution nao manda sourceApp; a plataforma sai do
  // sourceUrl.
  assertEquals(r.platform, "instagram");
  assertEquals(r.received_at, "2024-09-27T14:52:43.000Z");
  assertNotEquals(r.ctwa_clid, null);
});

Deno.test("aproveita o id de conversa quando a integracao nativa o manda", async () => {
  // Instancia com a integracao Evolution-Chatwoot ligada ja entrega o
  // vinculo pronto; a maioria nao tem, e ai o touchpoint nasce orfao.
  const comChatwoot = linha(montarTouchpoint(
    await fixture("conversation_ctwa_instagram"),
    TENANT,
    INSTANCIA,
  ));
  assertEquals(comChatwoot.chatwoot_conversation_id, 4348);
  assertNotEquals(comChatwoot.reconciled_at, null);

  const semChatwoot = linha(montarTouchpoint(
    await fixture("extendedtext_ctwa_sem_chatwoot"),
    TENANT,
    INSTANCIA,
  ));
  assertEquals(semChatwoot.chatwoot_conversation_id, null);
  // Nulo e o que faz a Tarefa 7 encontrar este touchpoint para reconciliar.
  assertEquals(semChatwoot.reconciled_at, null);
});

// ─── from_me nos dois valores ───────────────────────────────────

Deno.test("preserva from_me nos dois valores que os payloads reais trazem", async () => {
  // Lead de verdade chega com false. O true de um payload real e o que
  // justifica guardar a coluna: sem ela nao da para separar os dois casos
  // depois sem reprocessar tudo.
  const fromMeTrue = linha(montarTouchpoint(
    await fixture("conversation_ctwa_instagram"),
    TENANT,
    INSTANCIA,
  ));
  assertEquals(fromMeTrue.from_me, true);

  const fromMeFalse = linha(montarTouchpoint(
    await fixture("extendedtext_ctwa_sem_chatwoot"),
    TENANT,
    INSTANCIA,
  ));
  assertEquals(fromMeFalse.from_me, false);
});

// ─── Descartes ──────────────────────────────────────────────────

Deno.test("descarta como organico quando o sourceType nao e ad", async () => {
  // Responder a post organico pelo botao de mensagem tambem gera
  // externalAdReply. Gravar isso inflaria a contagem de leads pagos do
  // cliente, e o sourceId seria id de post — o lookup na Graph API
  // falharia nele.
  const p = await fixture("extendedtext_ctwa_sem_chatwoot");
  p.data.contextInfo.externalAdReply.sourceType = "post";

  const r = montarTouchpoint(p, TENANT, INSTANCIA);
  assert(ehDescarte(r));
  assertEquals(r.descartar, "organico");
  // O tipo recusado vai junto: sem ele, descobrir o que esta sendo
  // descartado exigiria reproduzir o webhook.
  assertEquals(r.detalhe, "post");
});

Deno.test("descarta sem anuncio a mensagem organica, que e a maioria do trafego", async () => {
  const p = await fixture("extendedtext_ctwa_sem_chatwoot");
  delete p.data.contextInfo;

  const r = montarTouchpoint(p, TENANT, INSTANCIA);
  assert(ehDescarte(r));
  assertEquals(r.descartar, "sem_anuncio");
});

Deno.test("descarta anuncio sem id de mensagem, que nao teria como ser idempotente", async () => {
  const p = await fixture("extendedtext_ctwa_sem_chatwoot");
  delete p.data.key.id;

  const r = montarTouchpoint(p, TENANT, INSTANCIA);
  assert(ehDescarte(r));
  assertEquals(r.descartar, "sem_identificacao");
});

Deno.test("nao estoura com payload malformado", () => {
  for (const p of [null, undefined, {}, "texto solto", [1, 2, 3]]) {
    const r = montarTouchpoint(p, TENANT, INSTANCIA);
    assert(ehDescarte(r), `esperava descarte para ${JSON.stringify(p)}`);
  }
});

// ─── Telefone ausente ───────────────────────────────────────────

Deno.test("aceita o touchpoint com telefone nulo quando o JID e @lid", async () => {
  // @lid e identificador anonimo, nao telefone. Descartar o touchpoint
  // aqui perderia o ctwa_clid, que e justamente o que a Fatia C devolve
  // a Meta — a atribuicao sobrevive, so a reconciliacao com o Chatwoot
  // e que nao tem como acontecer.
  const p = await fixture("extendedtext_ctwa_sem_chatwoot");
  p.data.key.remoteJid = "98965307547698@lid";

  const r = linha(montarTouchpoint(p, TENANT, INSTANCIA));
  assertEquals(r.phone_e164, null);
  assertEquals(r.phone_match_key, null);
  assertNotEquals(r.ctwa_clid, null);
  assertEquals(r.ad_id, "120223766489610787");
});

// ─── Enxugamento do payload ─────────────────────────────────────

Deno.test("remove o thumbnail base64 e preserva o resto do payload", async () => {
  const original = await fixture("conversation_ctwa_instagram");
  const r = linha(montarTouchpoint(original, TENANT, INSTANCIA));

  // deno-lint-ignore no-explicit-any
  const ad = (r.raw_payload as any).data.contextInfo.externalAdReply;
  assertNotEquals(ad.thumbnail, original.data.contextInfo.externalAdReply.thumbnail);
  assertEquals(ad.thumbnail, "[removido: ver thumbnailUrl]");

  // A mesma imagem continua alcancavel pela URL, que e o motivo de o
  // base64 poder sair.
  assertEquals(ad.thumbnailUrl, original.data.contextInfo.externalAdReply.thumbnailUrl);
  assertEquals(ad.ctwaClid, original.data.contextInfo.externalAdReply.ctwaClid);
  // deno-lint-ignore no-explicit-any
  assertEquals((r.raw_payload as any).data.message.conversation, original.data.message.conversation);
});

Deno.test("remove a apikey da instancia do payload guardado", async () => {
  // A policy de ad_touchpoints deixa o proprio cliente ler os touchpoints
  // dele, raw_payload incluso. Como o Evolution autentica mandando a
  // apikey da instancia dentro do corpo, guardar o payload cru entregaria
  // a credencial de operacao da instancia a quem abrir o painel.
  const original = await fixture("conversation_ctwa_instagram");
  const r = linha(montarTouchpoint(original, TENANT, INSTANCIA));

  // deno-lint-ignore no-explicit-any
  const guardado = (r.raw_payload as any).apikey;
  assertNotEquals(guardado, original.apikey);
  assertEquals(guardado, "[removido: credencial da instancia]");
  // E nao some do payload recebido, que ainda vai ser validado.
  assertEquals(original.apikey, "CHAVE-ANONIMIZADA-0000-0000-000000000000");
});

Deno.test("nao modifica o payload recebido ao enxugar", async () => {
  // O payload cru ainda e lido depois da montagem — pelo log e pelo
  // proprio chamador. Enxugar no lugar transformaria a limpeza num
  // efeito colateral invisivel.
  const p = await fixture("conversation_ctwa_instagram");
  const antes = p.data.contextInfo.externalAdReply.thumbnail;

  montarTouchpoint(p, TENANT, INSTANCIA);

  assertEquals(p.data.contextInfo.externalAdReply.thumbnail, antes);
});

Deno.test("sonda: enxuga o thumbnail mesmo se o aninhamento mudar", () => {
  // Objeto sintetico. NAO afirma que o Evolution produza esta forma —
  // nos dois payloads reais o contextInfo esta em data.contextInfo. A
  // sonda existe para que a limpeza nao dependa de posicao enquanto a
  // extracao varre: se divergissem, o base64 voltaria a ser gravado sem
  // nada quebrar.
  const p = {
    data: {
      key: { remoteJid: "5511987654321@s.whatsapp.net", id: "MSG1", fromMe: false },
      message: {
        imageMessage: {
          contextInfo: {
            externalAdReply: {
              sourceId: "999",
              sourceType: "ad",
              thumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD",
            },
          },
        },
      },
    },
  };

  const r = linha(montarTouchpoint(p, TENANT, INSTANCIA));
  // deno-lint-ignore no-explicit-any
  const ad = (r.raw_payload as any).data.message.imageMessage.contextInfo
    .externalAdReply;
  assertEquals(ad.thumbnail, "[removido: ver thumbnailUrl]");
});

Deno.test("anuncio sem thumbnail nao ganha campo que nao existia", async () => {
  const p = await fixture("extendedtext_ctwa_sem_chatwoot");
  delete p.data.contextInfo.externalAdReply.thumbnail;

  const r = linha(montarTouchpoint(p, TENANT, INSTANCIA));
  // deno-lint-ignore no-explicit-any
  const ad = (r.raw_payload as any).data.contextInfo.externalAdReply;
  assertEquals("thumbnail" in ad, false);
});

// ─── Timestamp ──────────────────────────────────────────────────

Deno.test("timestamp irreconhecivel vira agora em vez de derrubar a captura", async () => {
  // new Date(NaN).toISOString() lanca RangeError. Se isso subisse, o
  // Evolution receberia 500 e reenviaria o mesmo payload para sempre,
  // e o lead se perderia por causa de um campo acessorio.
  const p = await fixture("extendedtext_ctwa_sem_chatwoot");
  p.data.messageTimestamp = "nao-e-numero";

  const r = linha(montarTouchpoint(p, TENANT, INSTANCIA));
  assertNotEquals(r.received_at, null);
  assert(!Number.isNaN(new Date(r.received_at).getTime()));
});
