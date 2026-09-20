/**
 * Busca de insights na Marketing API.
 *
 * Três recortes, três chamadas: o grão base (anúncio × dia), posicionamento
 * e demografia. A API não combina recortes arbitrários numa chamada só.
 *
 * Este módulo não lê o ambiente — a versão da API chega por parâmetro. É o
 * que o mantém testável sem permissão, como `phone.ts` e `ad_reply.ts`.
 *
 * A função recebe `actId` por parâmetro e é chamada uma vez por conta: o
 * tenant real tem duas contas de anúncio, e várias contas por cliente é o
 * caso normal aqui, não exceção.
 */

import {
  acoesParaObjeto,
  type LinhaInsight,
  normalizarLinha,
  paraCentavos,
} from "./insights_norm.ts";

/**
 * Versão usada quando o chamador não informa outra.
 *
 * Mesmo motivo de `meta.ts`: versão da Graph API tem prazo de validade, e
 * quando esta sair de suporte a chamada passa a ser recusada. Fica como
 * parâmetro para que quem roda na plataforma passe `META_API_VERSION` sem
 * este módulo precisar ler o ambiente.
 */
const VERSAO_PADRAO = "v21.0";

/**
 * Teto de páginas por chamada.
 *
 * A condição de parada normal é `paging.next` vir ausente. O teto existe
 * para o caso de ele NÃO vir ausente: uma resposta que sempre aponta para
 * a próxima página deixaria a Edge Function girando até o limite de
 * execução, e o sintoma seria a sincronização inteira não terminar nunca —
 * sem nenhuma linha gravada e sem erro.
 */
const MAX_PAGINAS = 100;

export type Recorte = "base" | "posicionamento" | "demografia";

export type LinhaRecorte = {
  ad_id: string;
  dia: string;
  chave: Record<string, string>;
  gasto_centavos: number;
  impressoes: number;
  alcance: number;
  cliques: number;
  acoes: Record<string, number>;
};

/** Motivo da última falha, para quem chama poder contar e alertar. */
export type FalhaInsights = "http" | "erro_api" | "rede" | null;
export let ultimaFalha: FalhaInsights = null;

const CAMPOS_BASE = [
  "ad_id", "date_start", "spend", "impressions", "reach",
  "clicks", "inline_link_clicks", "actions",
].join(",");

const CAMPOS_RECORTE = [
  "ad_id", "date_start", "spend", "impressions", "reach", "clicks", "actions",
].join(",");

/**
 * O `breakdowns` é o que faz a Meta quebrar a linha por posicionamento ou
 * por faixa etária. Sem ele a resposta volta no grão base e toda linha
 * sairia daqui com a chave vazia — `{platform:"",position:""}` para todas —
 * colidindo na chave primária do recorte e sobrescrevendo uma à outra até
 * sobrar uma linha só, em silêncio.
 */
const BREAKDOWNS: Record<Recorte, string | null> = {
  base: null,
  posicionamento: "publisher_platform,platform_position",
  demografia: "age,gender",
};

/**
 * Forma da resposta, declarada em vez de inferida.
 *
 * Não é preciosismo de tipo: sem a anotação, `corpo` sai de `r.json()` como
 * `any`, `url` recebe `corpo.paging?.next` e o compilador entra em ciclo —
 * `url` depende de `corpo`, que depende de `r`, que depende de `url` — e
 * recusa o arquivo com TS7022. Declarar aqui quebra o ciclo e de quebra
 * tira o `any` do caminho de erro.
 */
type RespostaInsights = {
  data?: Record<string, unknown>[];
  paging?: { next?: string };
  error?: { code?: number; message?: string };
};

function chaveDoRecorte(
  recorte: Recorte, bruto: Record<string, unknown>,
): Record<string, string> {
  if (recorte === "posicionamento") {
    return {
      platform: String(bruto["publisher_platform"] ?? ""),
      position: String(bruto["platform_position"] ?? ""),
    };
  }
  return {
    idade: String(bruto["age"] ?? ""),
    genero: String(bruto["gender"] ?? ""),
  };
}

export async function buscarInsights(opts: {
  token: string;
  actId: string;
  desde: string;
  ate: string;
  recorte: Recorte;
  versao?: string;
}): Promise<{ base: LinhaInsight[]; recortes: LinhaRecorte[] } | null> {
  ultimaFalha = null;

  const versao = opts.versao ?? VERSAO_PADRAO;
  const ehBase = opts.recorte === "base";
  const params = new URLSearchParams({
    // Sem level=ad a API responde no grao da conta, sem ad_id — e toda
    // linha seria descartada aqui por falta de chave primaria, deixando a
    // sincronizacao "bem-sucedida" com zero linhas.
    level: "ad",
    time_range: JSON.stringify({ since: opts.desde, until: opts.ate }),
    // Sem time_increment=1 a Meta agrega o periodo inteiro numa linha e o
    // grao diario — que e o da chave primaria — se perde.
    time_increment: "1",
    fields: ehBase ? CAMPOS_BASE : CAMPOS_RECORTE,
    limit: "500",
    access_token: opts.token,
  });

  const bd = BREAKDOWNS[opts.recorte];
  if (bd) params.set("breakdowns", bd);

  let url: string | null =
    `https://graph.facebook.com/${versao}/${opts.actId}/insights?${params}`;

  const base: LinhaInsight[] = [];
  const recortes: LinhaRecorte[] = [];

  try {
    for (let p = 0; p < MAX_PAGINAS && url; p++) {
      const r = await fetch(url);

      if (!r.ok) {
        ultimaFalha = "http";
        // O `.catch` no json() nao e enfeite: um 502 de proxy vem com
        // corpo em HTML, `r.json()` estoura, e sem ele o catch de fora
        // assumiria e marcaria como "rede" — mandando procurar queda de
        // conexao quando o que houve foi a Meta recusar.
        const corpo: RespostaInsights = await r.json().catch(() => ({}));
        const err = corpo?.error;
        if (err) ultimaFalha = "erro_api";
        console.warn(
          `Insights recusados para ${opts.actId} (${opts.recorte}): ` +
            `status=${r.status} code=${err?.code} ${err?.message ?? ""}`,
        );
        return null;
      }

      const corpo: RespostaInsights = await r.json();
      // A Meta responde 200 com erro no corpo em alguns casos. Sem esta
      // ramificacao, `corpo.data ?? []` devolveria lista vazia e o erro
      // viraria "nao havia nada a buscar".
      if (corpo.error) {
        ultimaFalha = "erro_api";
        console.warn(
          `Insights com erro para ${opts.actId}: code=${corpo.error.code} ` +
            corpo.error.message,
        );
        return null;
      }

      for (const bruto of corpo.data ?? []) {
        if (ehBase) {
          const linha = normalizarLinha(bruto);
          if (linha) base.push(linha);
          continue;
        }
        const adId = bruto["ad_id"];
        const dia = bruto["date_start"];
        if (typeof adId !== "string" || typeof dia !== "string") continue;
        recortes.push({
          ad_id: adId,
          dia,
          chave: chaveDoRecorte(opts.recorte, bruto),
          gasto_centavos: paraCentavos(bruto["spend"]),
          impressoes: Number(bruto["impressions"] ?? 0) || 0,
          alcance: Number(bruto["reach"] ?? 0) || 0,
          cliques: Number(bruto["clicks"] ?? 0) || 0,
          acoes: acoesParaObjeto(bruto["actions"]),
        });
      }

      url = corpo.paging?.next ?? null;

      // Bater no teto significa resposta truncada. Nao ha variante no
      // tipo para isso e inventar uma quebraria quem consome, mas sair
      // daqui sem dizer nada deixaria dado faltando parecer dado completo.
      if (url && p === MAX_PAGINAS - 1) {
        console.warn(
          `Insights de ${opts.actId} (${opts.recorte}) pararam no teto de ` +
            `${MAX_PAGINAS} paginas; o periodo pode estar truncado`,
        );
      }
    }

    return { base, recortes };
  } catch (e) {
    // Rede fora, DNS, timeout, corpo que nao e JSON.
    //
    // A atribuicao aqui nao e detalhe: sem ela ultimaFalha ficaria null
    // depois de uma queda de rede, e null significa "nenhuma falha" para
    // quem le. O campo passaria a mentir justamente quando mais importa —
    // foi o bug que apareceu de verdade em meta.ts.
    ultimaFalha = "rede";
    console.warn(`Falha de rede nos insights de ${opts.actId}`, e);
    return null;
  }
}
