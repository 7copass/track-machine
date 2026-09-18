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
  token: string,
  adId: string,
): Promise<AdMetadata | null> {
  const campos = "id,name,adset{id,name},campaign{id,name,objective}";
  const url = `https://graph.facebook.com/${VERSAO}/${adId}` +
    `?fields=${encodeURIComponent(campos)}&access_token=${
      encodeURIComponent(token)
    }`;
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
    // Rede fora, DNS, timeout: mesmo tratamento das demais falhas. O
    // touchpoint continua gravado com o ad_id e a proxima varredura tenta
    // de novo.
    return null;
  }
}
