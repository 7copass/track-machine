/**
 * Cliente da API do Chatwoot.
 *
 * Toda operação falha em silêncio devolvendo null/false. Isso é proposital:
 * o enriquecimento é best-effort, e Chatwoot fora do ar não pode derrubar a
 * captura — o touchpoint já está salvo e a reconciliação recupera depois.
 *
 * Este módulo não lê o ambiente, como `phone.ts`, `ad_reply.ts` e `meta.ts`:
 * a configuração chega por parâmetro, e assim ele continua testável sem
 * permissão e sem credencial nenhuma.
 */

export type ChatwootConfig = {
  baseUrl: string;
  accountId: number;
  token: string;
};

export type OrigemDoLead = {
  ctwa_clid: string | null;
  ad_id: string | null;
  campaign_id: string | null;
  veio_de_anuncio: boolean;
};

/**
 * Motivo da última falha, para quem chama poder contar e alertar.
 *
 * Existe porque falha 100% silenciosa esconde pane: na Tarefa 9 um token
 * expirado produziu "zero processados", indistinguível de "nada a fazer".
 * O retorno continua sendo null nos dois casos — quem chama não deve se
 * comportar diferente — mas o motivo fica legível.
 *
 * Contato inexistente NÃO entra aqui: é o caso normal de o Evolution
 * chegar antes de o Chatwoot criar a conversa, e contá-lo como falha
 * afogaria o alerta no ruído do caminho feliz.
 */
export type FalhaChatwoot = "auth" | "http" | "rede" | null;

export let ultimaFalha: FalhaChatwoot = null;

function headers(cfg: ChatwootConfig): HeadersInit {
  return {
    "content-type": "application/json",
    "api_access_token": cfg.token,
  };
}

function anotarFalhaHttp(status: number, contexto: string): void {
  if (status === 401 || status === 403) {
    // Token revogado ou account_id errado param o enriquecimento de todo
    // lead, não só deste. Merece nome próprio porque o sintoma visível —
    // nenhum contato enriquecido — é igual ao de "os leads ainda não
    // chegaram ao Chatwoot", que é normal.
    ultimaFalha = "auth";
    console.warn(`Chatwoot recusou a credencial (${status}) em ${contexto}`);
    return;
  }
  ultimaFalha = "http";
  console.warn(`Chatwoot respondeu ${status} em ${contexto}`);
}

function anotarFalhaDeRede(contexto: string): void {
  // Rede fora, DNS, timeout. Mesmo desfecho das demais falhas para quem
  // chama, mas registrado à parte: indisponibilidade passa sozinha,
  // credencial recusada não.
  ultimaFalha = "rede";
  console.warn(`Chatwoot inalcancavel em ${contexto}`);
}

export async function buscarContatoPorTelefone(
  cfg: ChatwootConfig,
  telefone: string,
): Promise<number | null> {
  ultimaFalha = null;
  // encodeURIComponent e obrigatorio: "+" cru em query string e lido como
  // espaco do outro lado, e a busca voltaria vazia para todo mundo.
  const url = `${cfg.baseUrl}/api/v1/accounts/${cfg.accountId}` +
    `/contacts/search?q=${encodeURIComponent(telefone)}`;
  try {
    const r = await fetch(url, { headers: headers(cfg) });
    if (!r.ok) {
      anotarFalhaHttp(r.status, "busca de contato");
      return null;
    }
    const j = await r.json();
    const primeiro = j?.payload?.[0];
    // Lista vazia não é falha: o Chatwoot respondeu, o contato é que ainda
    // não existe. A Tarefa 7 reconcilia.
    return typeof primeiro?.id === "number" ? primeiro.id : null;
  } catch {
    anotarFalhaDeRede("busca de contato");
    return null;
  }
}

export async function gravarAtributosDeOrigem(
  cfg: ChatwootConfig,
  contatoId: number,
  origem: OrigemDoLead,
): Promise<boolean> {
  ultimaFalha = null;
  const url =
    `${cfg.baseUrl}/api/v1/accounts/${cfg.accountId}/contacts/${contatoId}`;
  try {
    const r = await fetch(url, {
      method: "PUT",
      headers: headers(cfg),
      body: JSON.stringify({ custom_attributes: origem }),
    });
    if (!r.ok) {
      anotarFalhaHttp(r.status, "gravacao de atributos");
      return false;
    }
    return true;
  } catch {
    anotarFalhaDeRede("gravacao de atributos");
    return false;
  }
}
