/**
 * Consulta de metadata de anúncio na Graph API.
 *
 * O payload do Evolution traz só o ad_id. Campanha, conjunto e nomes
 * legíveis vêm daqui — uma vez por anúncio, depois é cache.
 *
 * Falha sempre devolve null: token expirado ou anúncio apagado não pode
 * derrubar a captura de leads, que já gravou o ad_id e enriquece depois.
 */

// Versão fixada de propósito: a Graph API muda o formato da resposta entre
// versões, e deixar sem versão significa ser movido para a mais nova sem
// aviso. Versão da Graph API tem prazo de validade — quando esta sair de
// suporte, o lookup passa a devolver null e o enriquecimento para em
// silêncio; trocar aqui é a única mudança necessária.
/**
 * Versão usada quando o chamador não informa outra.
 *
 * A versão tem prazo de validade: quando sai de suporte, a Meta recusa a
 * chamada e o lookup passa a devolver null para sempre — o enriquecimento
 * para sem ninguém perceber. Por isso ela é parâmetro, e quem roda na
 * plataforma passa o valor de `META_API_VERSION`.
 *
 * Este módulo não lê o ambiente de propósito: assim ele continua sendo
 * função pura de entrada→saída, testável sem permissão nenhuma, como
 * `phone.ts` e `ad_reply.ts`.
 */
const VERSAO_PADRAO = "v21.0";

export type AdMetadata = {
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  objetivo: string | null;
  /**
   * `WHATSAPP`, `INSTAGRAM_PROFILE`, `MESSAGING_INSTAGRAM_DIRECT_WHATSAPP`…
   *
   * É o que separa campanha de mensagem de campanha de seguidores — o
   * `objective` não serve, porque as duas aparecem como
   * `OUTCOME_ENGAGEMENT`. Verificado na conta real: 191 conjuntos
   * `WHATSAPP` contra 4 `INSTAGRAM_PROFILE`, todos sob o mesmo objetivo.
   * Campanha sem lead precisa de outra métrica que não custo por lead.
   */
  destinationType: string | null;
  optimizationGoal: string | null;
  /**
   * A conta de anúncio a que este anúncio pertence, já com o prefixo
   * `act_` que `ad_accounts.act_id` usa.
   *
   * Vem do próprio anúncio e não da conta que o chamador tinha em mãos:
   * um tenant com DUAS contas — que é o caso real — não permite deduzir
   * a origem do anúncio a partir de "alguma conta do tenant", e é por
   * esta coluna que a view resolve o fuso do CPL diário. Atribuir a conta
   * errada aqui não dá erro nenhum: dá número errado, e só quando as duas
   * contas estiverem em fusos diferentes.
   */
  actId: string | null;
};

/** Motivo da última falha, para quem chama poder contar e alertar. */
export type FalhaMeta = "http" | "erro_api" | "rede" | null;

export let ultimaFalha: FalhaMeta = null;

/**
 * Normaliza `account_id` para o formato de `ad_accounts.act_id`.
 *
 * A Graph API devolve o id da conta sem o prefixo (`269873128000933`),
 * enquanto a tabela guarda com (`act_269873128000933`). Gravar o formato
 * cru faria o join da view não casar nunca e o fuso cair no `coalesce`
 * permanentemente — sem erro, só com número errado quando os fusos
 * divergirem.
 */
function comPrefixoAct(bruto: unknown): string | null {
  if (typeof bruto !== "string" && typeof bruto !== "number") return null;
  const texto = String(bruto).trim();
  if (!texto) return null;
  return texto.startsWith("act_") ? texto : `act_${texto}`;
}

export async function buscarMetadataDoAnuncio(
  token: string,
  adId: string,
  versao: string = VERSAO_PADRAO,
): Promise<AdMetadata | null> {
  ultimaFalha = null;
  // `account_id`, `destination_type` e `optimization_goal` precisam estar
  // AQUI, nao so no mapeamento do retorno: a Graph API devolve exatamente
  // o que esta lista pede. Ler um campo que nao foi pedido devolve null
  // para sempre, sem erro nenhum — falha silenciosa do tipo que este
  // projeto ja pagou caro.
  const campos = "id,name,account_id," +
    "adset{id,name,destination_type,optimization_goal}," +
    "campaign{id,name,objective}";
  const url = `https://graph.facebook.com/${versao}/${adId}` +
    `?fields=${encodeURIComponent(campos)}&access_token=${
      encodeURIComponent(token)
    }`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      ultimaFalha = "http";
      console.warn(`Graph API respondeu ${r.status} para o anuncio ${adId}`);
      return null;
    }
    const j = await r.json();
    if (j.error) {
      ultimaFalha = "erro_api";
      // Codigo 190 e token expirado ou revogado: o enriquecimento para de
      // funcionar inteiro, nao so para este anuncio.
      console.warn(
        `Graph API recusou o anuncio ${adId}: code=${j.error.code} ${j.error.message}`,
      );
      return null;
    }
    return {
      adName: j.name ?? null,
      adsetId: j.adset?.id ?? null,
      adsetName: j.adset?.name ?? null,
      campaignId: j.campaign?.id ?? null,
      campaignName: j.campaign?.name ?? null,
      objetivo: j.campaign?.objective ?? null,
      destinationType: j.adset?.destination_type ?? null,
      optimizationGoal: j.adset?.optimization_goal ?? null,
      actId: comPrefixoAct(j.account_id),
    };
  } catch (e) {
    // Rede fora, DNS, timeout: mesmo tratamento das demais falhas. O
    // touchpoint continua gravado com o ad_id e a proxima varredura tenta
    // de novo.
    //
    // A atribuicao aqui nao e detalhe: sem ela, ultimaFalha fica null
    // depois de uma queda de rede, e null significa "nenhuma falha" para
    // quem le. O campo passaria a mentir justamente quando mais importa.
    ultimaFalha = "rede";
    console.warn(`Falha de rede ao consultar o anuncio ${adId}`, e);
    return null;
  }
}
