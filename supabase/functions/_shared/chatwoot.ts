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

// ─── Por que uma saida nao gravou nada ──────────────────────────────

/**
 * Saídas que respondem 200 sem gravar linha nenhuma.
 *
 * `sem_telefone` foi renomeado para `contato_sem_telefone` porque o rótulo
 * antigo cobria duas causas — telefone ausente e conta ausente — e, nos 7
 * eventos medidos em 23/09, ele saía com `telefone=presente`. Reaproveitar
 * o nome seria pior que trocá-lo: log de plataforma fica retido por
 * semanas, e as linhas antigas com `ramo=sem_telefone` continuam lá
 * querendo dizer outra coisa.
 */
export type RamoSemGravar = "evento_ignorado" | "contato_sem_telefone";

/** Quantas chaves de topo cabem na linha antes de o resto virar contagem. */
const MAXIMO_DE_CHAVES = 40;

/** Teto de cada pedaço de texto vindo do payload, que é de fora. */
const MAXIMO_POR_CAMPO = 64;

/** Corta declarando o corte: truncar calado já custou caro neste projeto. */
function cortar(texto: string, limite: number): string {
  return texto.length > limite ? texto.slice(0, limite) + "+cortado" : texto;
}

/**
 * As chaves de um objeto do payload, em ordem e sem os valores.
 *
 * `Object.keys` de uma string devolve os índices dos caracteres, e de um
 * array os índices dos itens: enumerar às cegas transformaria o próprio
 * valor em log. Só objeto simples é enumerado.
 */
function listaDeChaves(valor: unknown): string {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    return "<nao-e-objeto>";
  }
  const todas = Object.keys(valor).sort();
  const cabem = todas.slice(0, MAXIMO_DE_CHAVES)
    .map((k) => cortar(k, MAXIMO_POR_CAMPO));
  const sobra = todas.length - cabem.length;
  return "[" + [...cabem, ...(sobra > 0 ? [`+${sobra}`] : [])].join(",") + "]";
}

/**
 * As chaves da primeira mensagem, que é o único aninhado que o webhook tem.
 *
 * O topo do payload medido em produção não traz `account_id` — e a conta é
 * justamente o campo que faltava. Saber o que existe DENTRO de `messages`
 * é o que decide se alguma conferência de configuração pode ser feita, e
 * nenhuma leitura da API REST responde isso: o webhook tem forma própria.
 *
 * Só as chaves, nunca os valores, e aqui isso é mais grave que no topo:
 * `messages[0]` carrega o texto da mensagem, o nome e o telefone juntos.
 */
function chavesDeMessages0(evento: unknown): string {
  const ms = (evento as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(ms) || ms.length === 0) return "<sem-messages>";
  return listaDeChaves(ms[0]);
}

/**
 * Última garantia de uma linha só.
 *
 * Nome de chave também vem de fora, e nenhum escape de valor cobre o que
 * estiver dentro dele: uma quebra de linha picaria o registro em várias
 * linhas no coletor, e o filtro pelo prefixo só acharia a primeira.
 */
function umaLinhaSo(linha: string): string {
  return linha.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/**
 * O contato do webhook, pela mesma regra que o `chatwoot-events` usa.
 *
 * Exportada para o fluxo e o diagnóstico lerem pelo MESMO caminho. Se cada
 * um tivesse a sua cópia da regra, o log poderia dizer "contato ausente"
 * de um payload em que o webhook achou contato — mentindo exatamente onde
 * se vai olhar para entender o problema.
 */
export function contatoDoEvento(
  evento: unknown,
): { id?: unknown; phone_number?: string } | undefined {
  const e = evento as
    | {
      meta?: { sender?: Record<string, unknown> };
      contact?: Record<string, unknown>;
    }
    | null
    | undefined;
  return (e?.meta?.sender ?? e?.contact) as
    | { id?: unknown; phone_number?: string }
    | undefined;
}

/**
 * A conta do webhook — que, medido em produção, ele não manda.
 *
 * Os dois lugares lidos aqui são os da API REST de conversas, onde
 * `account_id` está no topo do objeto. O webhook de `conversation_created`
 * não tem nenhum dos dois: das 29 chaves de topo registradas em 23/09,
 * nenhuma é `account` nem `account_id`. A leitura fica porque outras
 * origens (e outras versões do Chatwoot) trazem o campo, e quando ele vem
 * a conferência acontece — mas não vir deixou de ser motivo de descarte.
 */
export function contaDoEvento(evento: unknown): unknown {
  const e = evento as
    | { account?: { id?: unknown }; account_id?: unknown }
    | null
    | undefined;
  return e?.account?.id ?? e?.account_id;
}

/**
 * A caixa de entrada do webhook — esta ele manda.
 *
 * `inbox_id` está entre as 29 chaves de topo medidas em produção, e é o
 * que permite ter de volta a conferência de configuração que o
 * `account_id` prometia e nunca entregou neste payload.
 */
export function inboxDoEvento(evento: unknown): unknown {
  return (evento as { inbox_id?: unknown } | null | undefined)?.inbox_id;
}

/**
 * A linha de log de uma saída que respondeu 200 sem gravar nada.
 *
 * As duas saídas silenciosas do `chatwoot-events` devolvem 200 com corpo
 * curto, e em `function_edge_logs` ficam idênticas entre si e ao caminho
 * feliz: método, URL e status são os mesmos. Medido hoje, 42 webhooks em
 * 24 h, todos 200, e `chatwoot_conversations` com zero linhas — não há
 * como saber por qual das duas eles saíram. As demais saídas não têm esse
 * problema: 400, 401, 403 e 405 se distinguem pelo próprio status.
 *
 * O que entra na linha é o suficiente para decidir sem adivinhar: o ramo,
 * o `event` recebido, e as CHAVES de topo do payload. Chaves, nunca
 * valores — o corpo carrega telefone e nome de pessoa real, em `meta.sender`
 * e de novo dentro de `messages`, e log de plataforma fica retido por
 * semanas e é lido por quem opera. Do contato registra-se só se ele veio e
 * se tinha número.
 *
 * `telefone` e `conta` saem separados de propósito, e foi essa separação
 * que revelou a causa: o `if` que levava aqui era `!telefone || !contaId`,
 * e um campo só responderia "sem telefone" aos 7 eventos medidos, que
 * tinham telefone e não tinham conta. Hoje a conta não leva mais a esta
 * saída, e o campo fica porque é ele que mostra se o Chatwoot voltou a
 * mandá-la.
 */
export function motivoDeNaoGravar(
  ramo: RamoSemGravar,
  evento: unknown,
): string {
  const e = evento as Record<string, unknown> | null | undefined;

  // JSON.stringify em vez do valor cru: escapa aspas e quebras de linha, e
  // `event` vem de fora — texto com \n picaria o registro em várias linhas
  // no coletor, e o filtro pelo prefixo só acharia a primeira.
  const evento_nome = e?.event === undefined
    ? "<ausente>"
    : cortar(JSON.stringify(e.event) ?? String(e.event), MAXIMO_POR_CAMPO);

  const contato = contatoDoEvento(evento);
  const sim = (v: unknown) => (v ? "presente" : "ausente");

  return umaLinhaSo(
    `chatwoot-events saiu sem gravar: ramo=${ramo} ` +
      `event=${evento_nome} conta=${sim(contaDoEvento(evento))} ` +
      `contato=${sim(contato)} telefone=${sim(contato?.phone_number)} ` +
      `chaves=${listaDeChaves(e)} ` +
      `chaves_de_messages0=${chavesDeMessages0(evento)}`,
  );
}

// ─── O que impede gravar, e o que só confere configuração ───────────

/**
 * Desfecho de uma conferência de configuração.
 *
 * Quatro estados, e não um booleano, porque os três motivos de não haver
 * resposta pedem condutas opostas: `diverge` é erro de configuração e
 * precisa parar tudo; as duas ausências não são erro nenhum e não podem
 * impedir a gravação. Foi exatamente essa distinção que faltou — a
 * ausência de `account_id` era tratada como reprovação, e custou 100% dos
 * leads de reconciliação enquanto respondia 200 em todos os webhooks.
 */
export type Conferencia =
  | "confere"
  | "diverge"
  | "sem_campo_no_payload"
  | "sem_valor_no_cadastro";

/**
 * Compara um campo do payload com o que está cadastrado para o tenant.
 *
 * Compara como número porque os dois lados podem vir como texto: o
 * Chatwoot serializa ids ora como número ora como string, e `bigint` do
 * Postgres chega como string no PostgREST quando passa de 2^53.
 *
 * Nada de teste por valor falso: `Number("")` e `Number(null)` valem 0, e
 * uma guarda `!valor` leria string vazia como a conta zero — ou, pior,
 * declararia iguais dois campos ausentes.
 */
export function conferir(doPayload: unknown, doCadastro: unknown): Conferencia {
  const numero = (v: unknown): number | null => {
    // Booleano fora: `Number(true)` é 1, e casaria com a conta 1.
    if (v === null || v === undefined || typeof v === "boolean") return null;
    if (typeof v === "string" && v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const a = numero(doPayload);
  if (a === null) return "sem_campo_no_payload";
  const b = numero(doCadastro);
  if (b === null) return "sem_valor_no_cadastro";
  return a === b ? "confere" : "diverge";
}

/** O que o tenant tem cadastrado em `chatwoot_configs`. */
export type CadastroDoTenant = {
  account_id?: unknown;
  /** Hoje nulo para o tenant em produção — e nulo não pode bloquear. */
  inbox_id?: unknown;
};

/**
 * O que fazer com um webhook, e o que se conseguiu conferir a caminho.
 *
 * `conta` e `inbox` vêm junto do desfecho, e não só quando reprovam,
 * porque quem grava precisa poder registrar que gravou SEM conferir.
 * Trocar "descarta calado" por "grava calado" seria trocar um ponto cego
 * por outro.
 */
export type Decisao = {
  desfecho:
    | "gravar"
    | "evento_ignorado"
    | "contato_sem_telefone"
    | "conta_divergente"
    | "inbox_divergente";
  conta: Conferencia;
  inbox: Conferencia;
};

/**
 * Decide se a conversa entra, separando a guarda real das conferências.
 *
 * A regra que esta função existe para consertar: **conferência de
 * configuração que não pôde ser feita não impede gravar**. Só telefone
 * ausente impede, porque o join com o touchpoint é por telefone e sem ele
 * não há o que casar. Conta e inbox são outra coisa — servem para pegar a
 * URL de um cliente colada no Chatwoot de outro, que gravaria conversa no
 * tenant errado em silêncio. Quando dá para conferir, confere e recusa
 * divergência com 403; quando não dá, grava e registra que não deu.
 *
 * Medido em 23/09: 42 webhooks por dia, 200 em todos, zero linhas em
 * `chatwoot_conversations`. Os 7 eventos que o log de diagnóstico pegou
 * saíam todos por `!telefone || !contaId` com `telefone=presente` e
 * `conta=ausente` — uma conferência opcional virada requisito, custando
 * todos os leads de reconciliação.
 *
 * A ordem preserva a de antes: a saída silenciosa de 200 vem antes do 403,
 * e um payload sem telefone sai por 200 mesmo com configuração divergente.
 * Conversa sem telefone não seria gravada de qualquer modo, e o 403 existe
 * para quem gravaria no lugar errado.
 */
export function decidirGravacao(
  evento: unknown,
  cadastro: CadastroDoTenant,
): Decisao {
  const conta = conferir(contaDoEvento(evento), cadastro?.account_id);
  const inbox = conferir(inboxDoEvento(evento), cadastro?.inbox_id);
  const d = (desfecho: Decisao["desfecho"]): Decisao => ({
    desfecho,
    conta,
    inbox,
  });

  const e = evento as { event?: unknown } | null | undefined;
  if (e?.event !== "conversation_created") return d("evento_ignorado");

  // A única guarda que impede gravar. Acontece de verdade com web widget,
  // que não é o caminho do Click-to-WhatsApp.
  if (!contatoDoEvento(evento)?.phone_number) return d("contato_sem_telefone");

  if (conta === "diverge") return d("conta_divergente");
  if (inbox === "diverge") return d("inbox_divergente");
  return d("gravar");
}

/**
 * A linha de log de quem gravou sem ter conseguido conferir tudo.
 *
 * Existe para a gravação sem conferência não virar o novo ponto cego: sem
 * esta linha, ninguém saberia que a conferência de configuração parou de
 * acontecer — e o sintoma de uma URL trocada entre clientes continua
 * sendo nenhum.
 *
 * Leva também as chaves de `messages[0]`, porque a pergunta que sobra é
 * onde o `account_id` está, se é que está: o topo do webhook não o tem, e
 * `messages` é o único aninhado do payload. Chaves, nunca valores.
 *
 * Some sozinha: quando `inbox_id` for cadastrado e o payload continuar
 * trazendo `inbox_id`, a conferência passa a valer e esta linha para de
 * ser emitida.
 */
export function motivoDeNaoConferir(evento: unknown, d: Decisao): string {
  return umaLinhaSo(
    `chatwoot-events gravou sem conferir: conta=${d.conta} ` +
      `inbox=${d.inbox} chaves_de_messages0=${chavesDeMessages0(evento)}`,
  );
}
