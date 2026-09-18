/**
 * Extração dos dados de anúncio da primeira mensagem de um lead.
 *
 * Nos dois payloads reais capturados, o externalAdReply está sempre em
 * `data.contextInfo.externalAdReply` — irmão de `message`, e na mesma
 * posição apesar de `messageType` diferente (`conversation` e
 * `extendedTextMessage`). O Evolution normaliza o lugar do campo; ele não
 * migra para `imageMessage`/`audioMessage` conforme o tipo da resposta.
 *
 * Ainda assim a busca varre o objeto procurando a chave, em vez de assumir
 * posição: acesso por caminho fixo quebra silenciosamente se uma versão
 * futura do Evolution mudar o aninhamento, e o custo de varrer um payload
 * deste tamanho é irrelevante perto de perder a atribuição de um lead.
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

/**
 * Deduz a plataforma do anúncio.
 *
 * `sourceApp` seria o campo óbvio, mas ele não existe em versões mais
 * antigas do Evolution — confirmado comparando dois payloads reais. O
 * `sourceUrl` está nos dois.
 *
 * Não usar `mediaUrl`: ele aponta para facebook.com mesmo em anúncio que
 * rodou no Instagram, porque é só onde o vídeo está hospedado.
 */
export function derivarPlataforma(no: Record<string, unknown>): string | null {
  const app = texto(no["sourceApp"]);
  if (app) return app.toLowerCase();

  const url = (texto(no["sourceUrl"]) ?? "").toLowerCase();
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("facebook.com") || url.includes("fb.com")) return "facebook";
  return null;
}

export function extrairAdReply(payload: unknown): AdReply | null {
  const no = acharNo(payload);
  if (!no) return null;

  return {
    ctwaClid: texto(no["ctwaClid"]),
    adId: texto(no["sourceId"]),
    sourceUrl: texto(no["sourceUrl"]),
    sourceApp: derivarPlataforma(no),
    title: texto(no["title"]),
    body: texto(no["body"]),
  };
}
