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

import { grafiasPlausiveis, toMatchKey } from "./phone.ts";

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

/**
 * Acha na resposta o contato que é mesmo o telefone procurado.
 *
 * `/contacts/search?q=` é busca DIFUSA: casa com nome, e-mail e telefone
 * parcial. Pegar o primeiro resultado às cegas ligaria o lead a outra
 * pessoa, e o erro seria silencioso — o painel mostraria uma atribuição
 * confiante e errada, que é pior que nenhuma, porque ninguém vai conferir
 * o que parece certo.
 *
 * A conferência é pela chave normalizada, não por igualdade de string: o
 * contato encontrado na segunda grafia tem, por construção, telefone
 * diferente do que se procurou, e comparar texto cru rejeitaria justamente
 * quem se foi buscar. Contato sem telefone é recusado — casou com a busca
 * por nome ou e-mail e não há como confirmar que é a mesma pessoa.
 */
function acharContatoDoTelefone(payload: unknown, procurado: string): number | null {
  if (!Array.isArray(payload)) return null;
  for (const c of payload) {
    const id = (c as { id?: unknown })?.id;
    const tel = (c as { phone_number?: unknown })?.phone_number;
    if (
      typeof id === "number" && typeof tel === "string" &&
      toMatchKey(tel) === procurado
    ) {
      return id;
    }
  }
  return null;
}

/**
 * Busca o contato tentando as grafias plausíveis do telefone, em ordem.
 *
 * Mandar só a grafia que veio da Evolution acertava por coincidência:
 * medido em produção contra a API real, dos 35 telefones capturados os 35
 * existiam como contato no Chatwoot e só 5 eram encontrados — os 5 em que
 * as duas grafias por acaso coincidem. Ver `grafiasPlausiveis`.
 *
 * Para na primeira grafia que achar: cada tentativa é uma requisição a
 * mais no rate limit do Chatwoot, em cima de um webhook que roda a cada
 * lead. Falha de HTTP ou de rede também interrompe — token revogado não
 * fica melhor na segunda tentativa.
 */
export async function buscarContatoPorTelefone(
  cfg: ChatwootConfig,
  telefone: string,
): Promise<number | null> {
  ultimaFalha = null;
  const procurado = toMatchKey(telefone);

  for (const grafia of grafiasPlausiveis(telefone)) {
    // encodeURIComponent e obrigatorio: "+" cru em query string e lido como
    // espaco do outro lado, e a busca voltaria vazia para todo mundo.
    const url = `${cfg.baseUrl}/api/v1/accounts/${cfg.accountId}` +
      `/contacts/search?q=${encodeURIComponent(grafia)}`;
    try {
      const r = await fetch(url, { headers: headers(cfg) });
      if (!r.ok) {
        anotarFalhaHttp(r.status, "busca de contato");
        return null;
      }
      const j = await r.json();
      const id = acharContatoDoTelefone(j?.payload, procurado);
      if (id !== null) return id;
    } catch {
      anotarFalhaDeRede("busca de contato");
      return null;
    }
  }

  // Nenhuma grafia achou. Isso não é falha: o Chatwoot respondeu, o
  // contato é que ainda não existe. A Tarefa 7 reconcilia.
  return null;
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

/**
 * Converte o `created_at` do webhook num timestamp que o Postgres aceita.
 *
 * O Chatwoot manda epoch em segundos no payload de `conversation_created`
 * — `agent_last_seen_at` e `contact_last_seen_at` vêm como inteiros ao lado
 * dele. A coluna `criada_em` é `timestamptz`, e o número cru não passa:
 * `select '1726660000'::timestamptz` devolve 22008 no banco. Repassar o
 * valor direto faria o upsert falhar em *toda* conversa, e a reconciliação
 * nunca teria o que casar.
 *
 * Valor irreconhecível vira agora em vez de erro. Conversa gravada com hora
 * aproximada ainda reconcilia dentro da janela; conversa não gravada é lead
 * perdido em silêncio.
 */
export function normalizarCriadaEm(valor: unknown): string {
  const iso = (d: Date): string | null =>
    Number.isNaN(d.getTime()) ? null : d.toISOString();

  // Number.isFinite exclui NaN e Infinity, que viram Invalid Date. O zero
  // passa de propósito: `valor || agora` trocaria 1970 por hoje sem aviso.
  if (typeof valor === "number" && Number.isFinite(valor)) {
    const r = iso(new Date(valor * 1000));
    if (r) return r;
  }

  if (typeof valor === "string" && valor.length > 0) {
    // Só dígitos é epoch, não ano: sem esta ramificação, um proxy que
    // serialize tudo como texto colocaria a conversa no ano 1726660000.
    const r = iso(
      /^\d+$/.test(valor) ? new Date(Number(valor) * 1000) : new Date(valor),
    );
    if (r) return r;
  }

  return new Date().toISOString();
}
