/**
 * Montagem da linha de `ad_touchpoints` a partir do payload cru do Evolution.
 *
 * Vive fora do `Deno.serve` pelo mesmo motivo de `phone.ts` e `ad_reply.ts`:
 * não há harness de Edge Function neste projeto, e lógica escrita dentro do
 * handler só se verifica mandando webhook de verdade — o que exige instância,
 * anúncio ativo e alguém clicando. Aqui mora tudo que decide o que vira lead,
 * o que é descartado e com que valores a linha entra no banco; é a parte que
 * erra, e é função pura, testada contra os dois payloads reais capturados.
 *
 * O handler fica com o que precisa de I/O: autenticar, resolver a instância,
 * marcar saúde, gravar e enriquecer.
 */

import { extrairAdReply } from "./ad_reply.ts";
import { fromJid, toMatchKey } from "./phone.ts";
import { normalizarCriadaEm } from "./chatwoot.ts";

/** Linha pronta para `insert` em `ad_touchpoints`, em snake_case como as colunas. */
export type LinhaTouchpoint = {
  tenant_id: string;
  instance_id: string;
  wa_message_id: string;
  phone_e164: string | null;
  phone_match_key: string | null;
  from_me: boolean | null;
  ctwa_clid: string | null;
  ad_id: string | null;
  platform: string | null;
  source_channel: "evolution";
  received_at: string;
  raw_payload: Record<string, unknown>;
  chatwoot_conversation_id: number | null;
  reconciled_at: string | null;
};

/**
 * Por que a mensagem não virou touchpoint.
 *
 * - `sem_anuncio`: não há `externalAdReply`. É a maioria absoluta do
 *   tráfego do webhook — toda conversa orgânica passa por aqui.
 * - `organico`: há `externalAdReply`, mas o `sourceType` não é `"ad"`.
 *   Responder a um post pelo botão de mensagem gera o campo, e ali o
 *   `sourceId` é id de post.
 * - `sem_identificacao`: anúncio de verdade, mas sem `key.id` ou
 *   `key.remoteJid`. `wa_message_id` é `not null` no schema e é a chave de
 *   idempotência; sem ele não há o que inserir.
 */
export type MotivoDescarte = "sem_anuncio" | "organico" | "sem_identificacao";

export type Descarte = {
  descartar: MotivoDescarte;
  /** O que foi recusado, quando há algo legível. Evita ter que reproduzir o webhook para descobrir. */
  detalhe: string | null;
};

export type Resultado = LinhaTouchpoint | Descarte;

export function ehDescarte(r: Resultado): r is Descarte {
  return "descartar" in r;
}

const TEXTO_THUMBNAIL_REMOVIDO = "[removido: ver thumbnailUrl]";
const TEXTO_CREDENCIAL_REMOVIDA = "[removido: credencial da instancia]";

/** Mesma profundidade de `ad_reply.ts`: os dois varrem o mesmo objeto. */
const PROFUNDIDADE_MAXIMA = 12;

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Devolve uma cópia do payload pronta para virar `raw_payload`.
 *
 * Sai o thumbnail em base64: são ~6KB por lead e a mesma imagem já está em
 * `thumbnailUrl`, então guardá-lo infla a tabela sem acrescentar informação.
 *
 * Sai também a `apikey`. O Evolution autentica mandando a chave da instância
 * dentro do corpo, e a policy de `ad_touchpoints` deixa o próprio cliente ler
 * os touchpoints dele — `raw_payload` incluso. Guardar o corpo cru entregaria
 * pelo painel a credencial com que se opera a instância no Evolution. Ela já
 * foi validada quando chega aqui, e não tem uso nenhum num reprocessamento.
 *
 * A busca é por varredura, como a extração em `ad_reply.ts`, e não por
 * caminho fixo. Se as duas discordassem, uma mudança de aninhamento faria a
 * extração continuar achando o anúncio enquanto a limpeza parava de achar o
 * thumbnail — e o base64 voltaria a ser gravado sem nada quebrar.
 *
 * A cópia é obrigatória: enxugar no lugar mutaria o payload que o chamador
 * ainda vai ler.
 */
function enxugar(payload: Record<string, unknown>): Record<string, unknown> {
  const copia = structuredClone(payload);
  const vistos = new WeakSet<object>();
  let nivel: unknown[] = [copia];

  for (let d = 0; d < PROFUNDIDADE_MAXIMA && nivel.length > 0; d++) {
    const proximo: unknown[] = [];

    for (const no of nivel) {
      if (no === null || typeof no !== "object") continue;
      if (vistos.has(no)) continue;
      vistos.add(no);

      const obj = no as Record<string, unknown>;
      const ad = obj["externalAdReply"];
      // Só substitui o que existe: criar o campo onde ele não estava faria
      // o payload gravado mentir sobre o que o Evolution mandou.
      //
      // Qualquer tipo, não só string. Capturado em produção: esta versão do
      // Evolution manda a miniatura como Buffer virado objeto — chaves
      // "0","1","2"... uma por byte. Com o guarda restrito a string, eram
      // 32 KB por lead entrando no banco sem ninguém notar. A fixture tinha
      // base64, e foi por isso que o teste não pegou.
      if (ehObjeto(ad) && ad["thumbnail"] !== undefined) {
        ad["thumbnail"] = TEXTO_THUMBNAIL_REMOVIDO;
      }
      if (typeof obj["apikey"] === "string") {
        obj["apikey"] = TEXTO_CREDENCIAL_REMOVIDA;
      }
      for (const valor of Object.values(obj)) proximo.push(valor);
    }
    nivel = proximo;
  }
  return copia;
}

/**
 * Traduz o payload do Evolution numa linha de `ad_touchpoints`, ou diz por
 * que ele não vira lead.
 *
 * `tenantId` e `instanceId` vêm de fora porque quem os resolve é o handler,
 * consultando `evolution_instances` — o payload não é fonte confiável de
 * tenant.
 */
export function montarTouchpoint(
  payload: unknown,
  tenantId: string,
  instanceId: string,
): Resultado {
  if (!ehObjeto(payload)) {
    return { descartar: "sem_anuncio", detalhe: "payload nao e objeto" };
  }

  const anuncio = extrairAdReply(payload);
  if (!anuncio) return { descartar: "sem_anuncio", detalhe: null };

  // Responder a post orgânico pelo botão de mensagem também gera
  // externalAdReply, com sourceType diferente de "ad". Gravar isso como
  // touchpoint inflaria a contagem de leads pagos do cliente, e o sourceId
  // seria id de post — o lookup na Graph API falharia nele.
  if (anuncio.sourceType !== "ad") {
    return { descartar: "organico", detalhe: anuncio.sourceType };
  }

  const dados = ehObjeto(payload["data"]) ? payload["data"] : {};
  const chave = ehObjeto(dados["key"]) ? dados["key"] : {};

  const jid = texto(chave["remoteJid"]);
  const waMessageId = texto(chave["id"]);
  if (!jid || !waMessageId) {
    return {
      descartar: "sem_identificacao",
      detalhe: waMessageId ? "sem key.remoteJid" : "sem key.id",
    };
  }

  // remoteJid é sempre a outra parte da conversa, com fromMe true ou false —
  // então é sempre o telefone do lead, quando for telefone.
  //
  // Vem null em JID @lid (identificador anônimo) ou de grupo, e aí o
  // touchpoint ainda vale: o ctwa_clid é o que a Fatia C devolve à Meta.
  // Só não haverá como reconciliar com o Chatwoot.
  const e164 = fromJid(jid);

  // Bônus opcional: instância com a integração nativa Evolution-Chatwoot
  // ligada manda o id da conversa no payload. A maioria NÃO tem, então o
  // caminho normal é o touchpoint nascer órfão e a reconciliação ligar.
  const conversaChatwoot = typeof dados["chatwootConversationId"] === "number"
    ? dados["chatwootConversationId"]
    : null;

  return {
    tenant_id: tenantId,
    instance_id: instanceId,
    wa_message_id: waMessageId,
    phone_e164: e164,
    phone_match_key: e164 ? toMatchKey(e164) : null,
    from_me: typeof chave["fromMe"] === "boolean" ? chave["fromMe"] : null,
    ctwa_clid: anuncio.ctwaClid,
    ad_id: anuncio.adId,
    platform: anuncio.sourceApp,
    source_channel: "evolution",

    // messageTimestamp é epoch em segundos. A conversão é a mesma do
    // created_at do Chatwoot, inclusive no ponto que importa: valor
    // irreconhecível vira agora em vez de estourar. `new Date(NaN)
    // .toISOString()` lança RangeError, e um RangeError aqui viraria 500
    // para o Evolution, que reenviaria o mesmo payload para sempre.
    received_at: normalizarCriadaEm(dados["messageTimestamp"]),

    raw_payload: enxugar(payload),
    chatwoot_conversation_id: conversaChatwoot,
    reconciled_at: conversaChatwoot !== null ? new Date().toISOString() : null,
  };
}
