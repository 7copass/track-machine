import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "jsr:@std/assert";
import {
  buscarContatoPorTelefone,
  conferir,
  contaDoEvento,
  contatoDoEvento,
  decidirGravacao,
  gravarAtributosDeOrigem,
  motivoDeNaoConferir,
  motivoDeNaoGravar,
  normalizarCriadaEm,
  ultimaFalha,
} from "../../supabase/functions/_shared/chatwoot.ts";

// Nao ha Chatwoot no circuito de teste, e nem deveria haver: o que precisa
// ser provado aqui e a leitura da resposta e o comportamento diante de
// falha, nao a API do Chatwoot. Por isso o fetch e trocado por um duble e
// restaurado no finally de cada caso -- deixar o global trocado
// contaminaria o teste seguinte.
const cfg = {
  baseUrl: "https://chat.exemplo.com",
  accountId: 1,
  token: "token-de-teste",
};

function mockFetch(resposta: unknown, status = 200) {
  const original = globalThis.fetch;
  const chamadas: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(resposta), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { chamadas, restaurar: () => { globalThis.fetch = original; } };
}

/** Rede fora, DNS, timeout: o fetch rejeita em vez de responder. */
function mockFetchQueEstoura() {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(new TypeError("error sending request"))) as typeof fetch;
  return { restaurar: () => { globalThis.fetch = original; } };
}

// ─── Caminho feliz e formato da chamada ─────────────────────────

Deno.test("busca contato e devolve o id", async () => {
  const m = mockFetch({ payload: [{ id: 77, phone_number: "+5511900000000" }] });
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+5511900000000"), 77);
  } finally { m.restaurar(); }
});

Deno.test("envia o token no header esperado pelo Chatwoot", async () => {
  const m = mockFetch({ payload: [] });
  try {
    await buscarContatoPorTelefone(cfg, "+5511900000000");
    const headers = new Headers(m.chamadas[0].init!.headers);
    assertEquals(headers.get("api_access_token"), "token-de-teste");
  } finally { m.restaurar(); }
});

Deno.test("escapa o + do telefone na query da busca", async () => {
  // "+" cru em query string e lido como espaco do outro lado, e a busca
  // devolveria vazio para todo mundo — silenciosamente, porque contato
  // nao encontrado e um caso normal e nao levanta suspeita.
  const m = mockFetch({ payload: [] });
  try {
    await buscarContatoPorTelefone(cfg, "+5511900000000");
    assertStringIncludes(m.chamadas[0].url, "q=%2B5511900000000");
  } finally { m.restaurar(); }
});

Deno.test("grava os atributos de origem no contato", async () => {
  const m = mockFetch({ id: 77 });
  try {
    const ok = await gravarAtributosDeOrigem(cfg, 77, {
      ctwa_clid: "clid_x", ad_id: "ad_1",
      campaign_id: null, veio_de_anuncio: true,
    });
    assertEquals(ok, true);
    assertEquals(m.chamadas.length, 1);
    assertEquals(m.chamadas[0].init!.method, "PUT");
    const corpo = JSON.parse(m.chamadas[0].init!.body as string);
    assertEquals(corpo.custom_attributes.ad_id, "ad_1");
    assertEquals(corpo.custom_attributes.veio_de_anuncio, true);
  } finally { m.restaurar(); }
});

// ─── Falha graciosa: null/false, nunca excecao ──────────────────

Deno.test("devolve null quando o contato nao existe", async () => {
  // Acontece quando o Evolution chega antes do Chatwoot criar o contato.
  // Nao e erro: a reconciliacao da Tarefa 7 resolve depois.
  const m = mockFetch({ payload: [] });
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+5511900000000"), null);
  } finally { m.restaurar(); }
});

Deno.test("devolve null quando o Chatwoot esta fora do ar", async () => {
  // Chatwoot indisponivel nao pode derrubar a captura: o touchpoint
  // ja foi gravado e a reconciliacao recupera
  const m = mockFetch({ erro: "indisponivel" }, 503);
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+5511900000000"), null);
  } finally { m.restaurar(); }
});

Deno.test("devolve null sem estourar quando a rede cai", async () => {
  const m = mockFetchQueEstoura();
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+5511900000000"), null);
    assertEquals(
      await gravarAtributosDeOrigem(cfg, 77, {
        ctwa_clid: null, ad_id: null, campaign_id: null, veio_de_anuncio: true,
      }),
      false,
    );
  } finally { m.restaurar(); }
});

Deno.test("devolve false quando o Chatwoot recusa a gravacao", async () => {
  const m = mockFetch({ erro: "sem permissao" }, 403);
  try {
    assertEquals(
      await gravarAtributosDeOrigem(cfg, 77, {
        ctwa_clid: "clid_x", ad_id: "ad_1",
        campaign_id: null, veio_de_anuncio: true,
      }),
      false,
    );
  } finally { m.restaurar(); }
});

// ─── O motivo da falha fica registrado ──────────────────────────
//
// Falha 100% silenciosa esconde pane: na Tarefa 9 um token expirado
// produziu "zero processados", indistinguivel de "nada a fazer". Aqui o
// retorno continua sendo null nos dois casos — porque quem chama nao deve
// se comportar diferente — mas o motivo fica legivel para quem conta e
// alerta.

Deno.test("contato inexistente nao e registrado como falha", async () => {
  // A distincao que importa: sem ela, "nenhum contato enriquecido" nao
  // diz se o Chatwoot esta quebrado ou se os leads ainda nao chegaram la.
  const m = mockFetch({ payload: [] });
  try {
    await buscarContatoPorTelefone(cfg, "+5511900000000");
    assertEquals(ultimaFalha, null);
  } finally { m.restaurar(); }
});

Deno.test("token recusado e registrado como falha de autenticacao", async () => {
  // Token do Chatwoot revogado para de enriquecer todo lead, nao so este.
  const m = mockFetch({ erro: "nao autorizado" }, 401);
  try {
    await buscarContatoPorTelefone(cfg, "+5511900000000");
    assertEquals(ultimaFalha, "auth");
  } finally { m.restaurar(); }
});

Deno.test("indisponibilidade e registrada como falha de http", async () => {
  const m = mockFetch({ erro: "indisponivel" }, 503);
  try {
    await buscarContatoPorTelefone(cfg, "+5511900000000");
    assertEquals(ultimaFalha, "http");
  } finally { m.restaurar(); }
});

Deno.test("rede fora e registrada como falha de rede", async () => {
  const m = mockFetchQueEstoura();
  try {
    await buscarContatoPorTelefone(cfg, "+5511900000000");
    assertEquals(ultimaFalha, "rede");
  } finally { m.restaurar(); }
});

Deno.test("gravacao recusada tambem registra o motivo", async () => {
  const m = mockFetch({ erro: "sem permissao" }, 403);
  try {
    await gravarAtributosDeOrigem(cfg, 77, {
      ctwa_clid: "clid_x", ad_id: "ad_1",
      campaign_id: null, veio_de_anuncio: true,
    });
    assertEquals(ultimaFalha, "auth");
  } finally { m.restaurar(); }
});

Deno.test("chamada bem sucedida limpa a falha anterior", async () => {
  // Sem a limpeza, uma falha antiga ficaria colada para sempre e o
  // alerta dispararia muito depois do Chatwoot ter voltado.
  const quebrado = mockFetch({ erro: "indisponivel" }, 503);
  try {
    await buscarContatoPorTelefone(cfg, "+5511900000000");
    assertEquals(ultimaFalha, "http");
  } finally { quebrado.restaurar(); }

  const ok = mockFetch({ payload: [{ id: 77 }] });
  try {
    await buscarContatoPorTelefone(cfg, "+5511900000000");
    assertEquals(ultimaFalha, null);
  } finally { ok.restaurar(); }
});

// ─── Normalizacao do created_at do webhook ──────────────────────────
//
// O Chatwoot manda created_at como epoch em segundos no payload de
// conversation_created -- os vizinhos agent_last_seen_at e
// contact_last_seen_at sao inteiros tambem. A coluna criada_em e
// timestamptz, e o Postgres recusa o numero cru: verificado no banco,
// "select '1726660000'::timestamptz" devolve 22008 (date/time field value
// out of range). Sem esta normalizacao o upsert do webhook falharia em
// toda conversa e nada seria reconciliado.

Deno.test("epoch em segundos vira timestamp que o Postgres aceita", () => {
  assertEquals(normalizarCriadaEm(1726660000), "2024-09-18T11:46:40.000Z");
});

Deno.test("epoch zero nao e confundido com ausencia", () => {
  // 0 e falsy: um "valor || agora" trocaria 1970 por hoje em silencio.
  assertEquals(normalizarCriadaEm(0), "1970-01-01T00:00:00.000Z");
});

Deno.test("timestamp ja em texto passa sem ser reinterpretado", () => {
  assertEquals(
    normalizarCriadaEm("2026-09-18T10:00:00.000Z"),
    "2026-09-18T10:00:00.000Z",
  );
});

Deno.test("epoch entregue como texto ainda e epoch", () => {
  // Proxy que serializa tudo como string nao pode virar ano 1726660000.
  assertEquals(normalizarCriadaEm("1726660000"), "2024-09-18T11:46:40.000Z");
});

Deno.test("sem created_at, a conversa entra com a hora de agora", () => {
  // Cair para agora e melhor que recusar o evento: uma conversa com hora
  // aproximada ainda reconcilia, uma conversa nao gravada nunca.
  const antes = Date.now();
  const r = normalizarCriadaEm(undefined);
  assertEquals(Number.isNaN(Date.parse(r)), false);
  assertEquals(Date.parse(r) >= antes - 1000, true);
});

Deno.test("valor malformado nao derruba o webhook", () => {
  for (const lixo of [null, {}, [], "ontem", "", NaN, Infinity, 1e308 * 10]) {
    assertEquals(Number.isNaN(Date.parse(normalizarCriadaEm(lixo))), false);
  }
});

// ─── As duas grafias do nono digito, e a conferencia do telefone ────
//
// Medido em producao contra a API real do Chatwoot, com os 35 telefones
// capturados: 35 de 35 existem la como contato, e so 5 tinham sido
// encontrados — exatamente os 5 em que o Chatwoot por acaso guarda a
// mesma grafia de 12 digitos que a Evolution nos deu. Nos outros, o
// Chatwoot guarda a grafia de 13: o nosso +559391597627 esta la como
// +5593991597627. A busca so acertava por coincidencia.
//
// A segunda metade do problema e que /contacts/search e DIFUSA: casa com
// nome, e-mail e telefone parcial. Pegar o primeiro resultado as cegas
// ligaria o lead a outra pessoa, e o painel mostraria uma atribuicao
// confiante e errada — pior que nenhuma.

/** Uma resposta por chamada, na ordem. */
function mockFetchSequencia(respostas: { corpo: unknown; status?: number }[]) {
  const original = globalThis.fetch;
  const chamadas: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const i = chamadas.length;
    chamadas.push({ url: String(url), init });
    const r = respostas[i] ?? { corpo: { payload: [] } };
    return Promise.resolve(
      new Response(JSON.stringify(r.corpo), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { chamadas, restaurar: () => { globalThis.fetch = original; } };
}

Deno.test("acha o contato na grafia de 13 digitos que o Chatwoot guarda", async () => {
  const m = mockFetchSequencia([
    { corpo: { payload: [] } },
    { corpo: { payload: [{ id: 42, phone_number: "+5593991597627" }] } },
  ]);
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+559391597627"), 42);
    assertEquals(m.chamadas.length, 2);
    assertStringIncludes(m.chamadas[0].url, "q=%2B559391597627");
    assertStringIncludes(m.chamadas[1].url, "q=%2B5593991597627");
  } finally { m.restaurar(); }
});

Deno.test("para na primeira grafia quando ela ja acha", async () => {
  // Cada grafia e uma requisicao a mais no rate limit do Chatwoot, em
  // cima de um webhook que roda a cada lead.
  const m = mockFetchSequencia([
    { corpo: { payload: [{ id: 7, phone_number: "+559391648044" }] } },
  ]);
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+559391648044"), 7);
    assertEquals(m.chamadas.length, 1);
  } finally { m.restaurar(); }
});

Deno.test("recusa contato que a busca difusa trouxe com outro telefone", async () => {
  // /contacts/search casa nome e e-mail tambem. Aceitar o primeiro
  // resultado as cegas gravaria a origem do anuncio no contato errado.
  const m = mockFetchSequencia([
    { corpo: { payload: [{ id: 999, phone_number: "+5511999999999" }] } },
    { corpo: { payload: [{ id: 999, phone_number: "+5511999999999" }] } },
  ]);
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+559391597627"), null);
  } finally { m.restaurar(); }
});

Deno.test("contato recusado por telefone divergente nao e falha", async () => {
  // Mesma razao de a lista vazia nao ser falha: o Chatwoot respondeu. Se
  // isso contasse como falha, o alerta dispararia no caminho normal.
  const m = mockFetchSequencia([
    { corpo: { payload: [{ id: 999, phone_number: "+5511999999999" }] } },
  ]);
  try {
    await buscarContatoPorTelefone(cfg, "+559391597627");
    assertEquals(ultimaFalha, null);
  } finally { m.restaurar(); }
});

Deno.test("aceita contato cujo telefone difere so pelo nono digito", async () => {
  // A conferencia e pela chave normalizada, nao por igualdade de string:
  // senao ela rejeitaria justamente o contato que a segunda grafia achou.
  const m = mockFetchSequencia([
    { corpo: { payload: [{ id: 42, phone_number: "+5593991597627" }] } },
  ]);
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+559391597627"), 42);
  } finally { m.restaurar(); }
});

Deno.test("escolhe o contato certo quando a busca difusa mistura resultados", async () => {
  // O homonimo vem primeiro na resposta do Chatwoot; o dono do telefone
  // vem depois. Ler so o primeiro perderia o certo E pegaria o errado.
  const m = mockFetchSequencia([
    {
      corpo: {
        payload: [
          { id: 900, phone_number: "+5511988887777" },
          { id: 42, phone_number: "+5593991597627" },
        ],
      },
    },
  ]);
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+559391597627"), 42);
  } finally { m.restaurar(); }
});

Deno.test("recusa contato sem telefone nenhum", async () => {
  // Contato so com e-mail casa com a busca difusa e nao da para conferir.
  const m = mockFetchSequencia([
    { corpo: { payload: [{ id: 55 }, { id: 56, phone_number: null }] } },
  ]);
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+559391597627"), null);
  } finally { m.restaurar(); }
});

Deno.test("nao tenta a segunda grafia quando o numero e estrangeiro", async () => {
  const m = mockFetchSequencia([{ corpo: { payload: [] } }]);
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+351912345678"), null);
    assertEquals(m.chamadas.length, 1);
  } finally { m.restaurar(); }
});

Deno.test("nao tenta a segunda grafia quando o numero e fixo brasileiro", async () => {
  // Acrescentar o nono digito a um fixo produz numero que nao existe.
  const m = mockFetchSequencia([{ corpo: { payload: [] } }]);
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+551133334444"), null);
    assertEquals(m.chamadas.length, 1);
  } finally { m.restaurar(); }
});

Deno.test("credencial recusada interrompe as demais grafias", async () => {
  // Token revogado nao vira melhor na segunda tentativa, e insistir so
  // multiplicaria requisicao recusada.
  const m = mockFetchSequencia([
    { corpo: { erro: "nao autorizado" }, status: 401 },
    { corpo: { payload: [{ id: 42, phone_number: "+5593991597627" }] } },
  ]);
  try {
    assertEquals(await buscarContatoPorTelefone(cfg, "+559391597627"), null);
    assertEquals(m.chamadas.length, 1);
    assertEquals(ultimaFalha, "auth");
  } finally { m.restaurar(); }
});

// ─── Saidas que nao gravam nada dizem por que ───────────────────────

/**
 * Telefone e nome de uma pessoa, como o Chatwoot os manda no payload.
 *
 * Existem aqui para os dois lados do teste: o log precisa dizer SE o
 * contato veio e SE ele tinha telefone, e nao pode deixar escapar nem o
 * numero nem o nome. Log de plataforma fica retido por semanas e e lido
 * por quem opera; dado pessoal nao tem o que fazer la.
 */
const TELEFONE_DA_PESSOA = "+5511987654321";
const NOME_DA_PESSOA = "Fulano de Tal";

/** Payload de `conversation_created` no formato do Chatwoot. */
function eventoDeConversa(
  sobrepor: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event: "conversation_created",
    id: 4242,
    account: { id: 6, name: "Conta de Teste" },
    inbox_id: 31,
    channel: "Channel::Api",
    status: "open",
    created_at: 1758600000,
    meta: {
      sender: {
        id: 99,
        name: NOME_DA_PESSOA,
        phone_number: TELEFONE_DA_PESSOA,
        email: null,
        type: "contact",
      },
      assignee: null,
    },
    messages: [
      {
        id: 1,
        content: `Oi, aqui e ${NOME_DA_PESSOA}`,
        sender: { phone_number: TELEFONE_DA_PESSOA },
      },
    ],
    ...sobrepor,
  };
}

Deno.test("o log diz qual dos dois ramos silenciosos foi tomado", () => {
  // Os dois respondem 200 com corpo curto, e no log da plataforma ficam
  // indistinguiveis um do outro e do caminho feliz. Saber qual foi e a
  // primeira pergunta de qualquer diagnostico.
  assertStringIncludes(
    motivoDeNaoGravar("evento_ignorado", eventoDeConversa()),
    "ramo=evento_ignorado",
  );
  assertStringIncludes(
    motivoDeNaoGravar("contato_sem_telefone", eventoDeConversa()),
    "ramo=contato_sem_telefone",
  );
});

Deno.test("o log tem prefixo fixo, para dar para consultar depois", () => {
  // Sem um prefixo estavel nao ha como filtrar `function_logs` por estas
  // linhas — e um log que nao da para achar nao vale mais que silencio.
  assert(
    motivoDeNaoGravar("evento_ignorado", eventoDeConversa())
      .startsWith("chatwoot-events saiu sem gravar:"),
  );
});

Deno.test("o log registra o event que chegou", () => {
  const m = motivoDeNaoGravar(
    "evento_ignorado",
    eventoDeConversa({ event: "message_created" }),
  );
  assertStringIncludes(m, 'event="message_created"');
});

Deno.test("event ausente aparece como ausente, nao some", () => {
  // `event=undefined` impresso a toa seria lido como "o campo veio vazio".
  // A distincao entre "nao veio a chave" e "veio outro nome" e justamente
  // o que este ramo precisa responder.
  const semEvento = eventoDeConversa();
  delete semEvento.event;
  assertStringIncludes(
    motivoDeNaoGravar("evento_ignorado", semEvento),
    "event=<ausente>",
  );
});

Deno.test("o log lista as chaves de topo do payload", () => {
  const m = motivoDeNaoGravar("contato_sem_telefone", eventoDeConversa());
  assertStringIncludes(m, "chaves=[");
  for (const k of ["account", "event", "id", "messages", "meta"]) {
    assertStringIncludes(m, k);
  }
});

Deno.test("o log carrega as chaves, nunca os valores", () => {
  // O corpo tem telefone e nome de pessoa real em mais de um lugar:
  // meta.sender, e de novo dentro de messages. Imprimir o payload para
  // diagnosticar resolveria o diagnostico e criaria um vazamento.
  for (const ramo of ["evento_ignorado", "contato_sem_telefone"] as const) {
    const m = motivoDeNaoGravar(ramo, eventoDeConversa());
    assertFalse(m.includes(TELEFONE_DA_PESSOA), `${ramo} vazou o telefone`);
    assertFalse(m.includes("5511987654321"), `${ramo} vazou os digitos`);
    assertFalse(m.includes(NOME_DA_PESSOA), `${ramo} vazou o nome`);
    assertFalse(m.includes("Conta de Teste"), `${ramo} vazou o nome da conta`);
  }
});

Deno.test("o log diz que o contato veio e que tinha telefone", () => {
  const m = motivoDeNaoGravar("contato_sem_telefone", eventoDeConversa());
  assertStringIncludes(m, "contato=presente");
  assertStringIncludes(m, "telefone=presente");
});

Deno.test("contato sem telefone e diferente de contato ausente", () => {
  // Os dois caem no mesmo `if`, e so o log separa "o Chatwoot mandou um
  // contato sem numero" de "o Chatwoot nao mandou contato nenhum" — que
  // apontam para consertos diferentes.
  const semNumero = eventoDeConversa({
    meta: { sender: { id: 99, name: NOME_DA_PESSOA, type: "contact" } },
  });
  const m1 = motivoDeNaoGravar("contato_sem_telefone", semNumero);
  assertStringIncludes(m1, "contato=presente");
  assertStringIncludes(m1, "telefone=ausente");

  const semContato = eventoDeConversa({ meta: { assignee: null } });
  const m2 = motivoDeNaoGravar("contato_sem_telefone", semContato);
  assertStringIncludes(m2, "contato=ausente");
  assertStringIncludes(m2, "telefone=ausente");
});

Deno.test("falta de conta e registrada a parte da falta de telefone", () => {
  // `!telefone || !contaId` funde duas causas numa saida so. Sem separar,
  // o log responderia "sem telefone" a um payload que tinha telefone.
  const semConta = eventoDeConversa();
  delete semConta.account;
  const m = motivoDeNaoGravar("contato_sem_telefone", semConta);
  assertStringIncludes(m, "conta=ausente");
  assertStringIncludes(m, "telefone=presente");

  assertStringIncludes(
    motivoDeNaoGravar("contato_sem_telefone", eventoDeConversa()),
    "conta=presente",
  );
});

Deno.test("payload que nao e objeto nao vira lista de indices", () => {
  // `Object.keys("+5511...")` devolve os indices dos caracteres: enumerar
  // as chaves as cegas transformaria o proprio valor em log.
  for (const cru of ["+5511987654321", 42, true, []]) {
    const m = motivoDeNaoGravar("evento_ignorado", cru);
    assertStringIncludes(m, "chaves=<nao-e-objeto>");
    assertFalse(m.includes("5511987654321"));
  }
});

Deno.test("event descomunal e cortado, e o corte e declarado", () => {
  // Truncar em silencio ja custou caro neste projeto. Se cortar, dizer.
  const m = motivoDeNaoGravar(
    "evento_ignorado",
    eventoDeConversa({ event: "x".repeat(5000) }),
  );
  assertStringIncludes(m, "+cortado");
  assertFalse(m.includes("x".repeat(200)));
});

Deno.test("excesso de chaves e cortado dizendo quantas sobraram", () => {
  const muitas: Record<string, unknown> = { event: "conversation_created" };
  for (let i = 0; i < 60; i++) muitas[`campo_${i}`] = i;
  const m = motivoDeNaoGravar("evento_ignorado", muitas);
  // 61 chaves, 40 cabem: as 21 restantes precisam aparecer como numero.
  assertStringIncludes(m, "+21");
});

Deno.test("o log cabe numa linha so", () => {
  // Quebra de linha vinda do payload picaria o registro em varias linhas
  // no coletor, e o filtro pelo prefixo so acharia a primeira.
  const m = motivoDeNaoGravar(
    "evento_ignorado",
    { "chave\ncom\nquebra": 1, event: "linha1\nlinha2" },
  );
  assertFalse(m.includes("\n"));
  assertFalse(m.includes("\r"));
});

// ─── O log le o payload pela mesma regra que o webhook ──────────────

Deno.test("o contato sai de meta.sender, com queda para contact", () => {
  // O `index.ts` usa `meta.sender ?? contact`. Se o log lesse por outra
  // regra, ele diria "contato ausente" de um payload em que o webhook
  // achou contato — e mentiria justamente no diagnostico.
  assertEquals(
    contatoDoEvento(eventoDeConversa())?.phone_number,
    TELEFONE_DA_PESSOA,
  );
  assertEquals(
    contatoDoEvento({ contact: { id: 7, phone_number: "+5511111111111" } })
      ?.phone_number,
    "+5511111111111",
  );
  assertEquals(contatoDoEvento({ meta: {} }), undefined);
  assertEquals(contatoDoEvento(null), undefined);
});

Deno.test("a conta sai de account.id, com queda para account_id", () => {
  assertEquals(contaDoEvento(eventoDeConversa()), 6);
  assertEquals(contaDoEvento({ account_id: 6 }), 6);
  assertEquals(contaDoEvento({}), undefined);
  assertEquals(contaDoEvento(null), undefined);
});

Deno.test("o que o log afirma bate com o que o webhook enxerga", () => {
  // Trava a consistencia entre as duas leituras: qualquer divergencia
  // futura entre a regra do log e a do fluxo quebra aqui.
  for (
    const ev of [
      eventoDeConversa(),
      eventoDeConversa({ meta: { assignee: null } }),
      eventoDeConversa({ meta: { sender: { id: 1, name: NOME_DA_PESSOA } } }),
      { contact: { id: 7, phone_number: TELEFONE_DA_PESSOA }, account_id: 6 },
      {},
    ]
  ) {
    const m = motivoDeNaoGravar("contato_sem_telefone", ev);
    const contato = contatoDoEvento(ev);
    assertStringIncludes(
      m,
      `contato=${contato ? "presente" : "ausente"}`,
    );
    assertStringIncludes(
      m,
      `telefone=${contato?.phone_number ? "presente" : "ausente"}`,
    );
    assertStringIncludes(
      m,
      `conta=${contaDoEvento(ev) ? "presente" : "ausente"}`,
    );
  }
});

// ─── O que impede gravar, e o que so confere configuracao ───────────

/**
 * O payload de `conversation_created` como o Chatwoot manda DE VERDADE.
 *
 * Nao e inventado: sao as 29 chaves de topo que o log de diagnostico
 * registrou em producao em 23/09, nos 7 eventos medidos entre 21h35 e
 * 23h06 UTC — todos identicos entre si. O que importa nelas e o que NAO
 * esta la: nao existe `account` nem `account_id` em lugar nenhum do topo.
 * Existe `inbox_id`, e existe `messages`.
 *
 * Qualquer fixture com `account` — como o `eventoDeConversa` acima — deixa
 * o caso decisivo verde sem nunca exercita-lo: a conta esta la, a guarda
 * passa, e o teste nao toca no que quebrou. Os 42 webhooks/dia que
 * responderam 200 e gravaram zero saiam exatamente por essa diferenca.
 * (A conta existe na API REST de conversas do mesmo Chatwoot, com
 * `account_id` no topo. E o webhook que nao a traz.)
 */
function eventoRealDoWebhook(
  sobrepor: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    additional_attributes: {},
    agent_last_seen_at: 0,
    applied_sla: null,
    can_reply: true,
    channel: "Channel::Api",
    contact_inbox: { source_id: "5511987654321" },
    contact_last_seen_at: 0,
    created_at: 1758600000,
    custom_attributes: {},
    enable_captain: false,
    event: "conversation_created",
    first_reply_created_at: null,
    flowise_session: null,
    id: 4242,
    inbox_id: 31,
    labels: [],
    last_activity_at: 1758600000,
    messages: [
      {
        id: 1,
        content: `Oi, aqui e ${NOME_DA_PESSOA}`,
        account_id: 6,
        inbox_id: 31,
        conversation_id: 4242,
        sender: { phone_number: TELEFONE_DA_PESSOA, name: NOME_DA_PESSOA },
      },
    ],
    meta: {
      sender: {
        id: 99,
        name: NOME_DA_PESSOA,
        phone_number: TELEFONE_DA_PESSOA,
        type: "contact",
      },
      assignee: null,
    },
    priority: null,
    sla_events: [],
    sla_policy_id: null,
    snoozed_until: null,
    status: "open",
    timestamp: 1758600000,
    typebot_session: null,
    unread_count: 1,
    updated_at: 1758600000,
    waiting_since: 0,
    ...sobrepor,
  };
}

/** O cadastro do tenant como ele esta hoje: conta preenchida, inbox nula. */
const CADASTRO = { account_id: 6, inbox_id: null };

Deno.test("payload real, sem account_id e com telefone, e gravado", () => {
  // O caso que custou todos os leads de reconciliacao: 42 webhooks por
  // dia, 200 em todos, zero linhas em chatwoot_conversations. A guarda
  // era `!telefone || !contaId`, e `contaId` nao existe neste payload.
  const d = decidirGravacao(eventoRealDoWebhook(), CADASTRO);
  assertEquals(d.desfecho, "gravar");
});

Deno.test("nao dar para conferir a conta e registrado, nao bloqueia", () => {
  // A conferencia continua existindo — o que muda e que a AUSENCIA do
  // campo deixa de ser motivo de descarte. Gravar sem conferir e pior que
  // gravar conferindo, e infinitamente melhor que nao gravar.
  const d = decidirGravacao(eventoRealDoWebhook(), CADASTRO);
  assertEquals(d.conta, "sem_campo_no_payload");
  assertEquals(d.inbox, "sem_valor_no_cadastro");
});

Deno.test("telefone ausente continua impedindo a gravacao", () => {
  // Esta guarda e legitima e nao muda: o join com o touchpoint e por
  // telefone, e conversa sem numero nao casa com nada.
  const semTelefone = eventoRealDoWebhook({
    meta: { sender: { id: 99, name: NOME_DA_PESSOA, type: "contact" } },
  });
  assertEquals(
    decidirGravacao(semTelefone, CADASTRO).desfecho,
    "contato_sem_telefone",
  );
});

Deno.test("falta de conta nao e mais contada como falta de telefone", () => {
  // As duas causas estavam no mesmo `if` e no mesmo rotulo, e o rotulo
  // dizia "contato_sem_telefone" de um payload que tinha telefone.
  const d = decidirGravacao(eventoRealDoWebhook(), CADASTRO);
  assertFalse(d.desfecho === "contato_sem_telefone");
});

Deno.test("evento que nao e conversation_created nao grava", () => {
  assertEquals(
    decidirGravacao(
      eventoRealDoWebhook({ event: "message_created" }),
      CADASTRO,
    ).desfecho,
    "evento_ignorado",
  );
});

// ─── A conferencia de configuracao, quando da para faze-la ──────────

Deno.test("conta divergente ainda recusa: e URL trocada entre clientes", () => {
  // O unico sintoma de uma URL de um cliente colada no Chatwoot de outro
  // seria conversa gravada no tenant errado, em silencio.
  const d = decidirGravacao(
    eventoRealDoWebhook({ account: { id: 99 } }),
    CADASTRO,
  );
  assertEquals(d.desfecho, "conta_divergente");
  assertEquals(d.conta, "diverge");
});

Deno.test("conta que confere grava, e diz que conferiu", () => {
  const d = decidirGravacao(
    eventoRealDoWebhook({ account: { id: 6 } }),
    CADASTRO,
  );
  assertEquals(d.desfecho, "gravar");
  assertEquals(d.conta, "confere");
});

Deno.test("inbox_id cadastrado e divergente recusa", () => {
  // `inbox_id` esta no payload do webhook, e `account_id` nao: e ele que
  // consegue ser a conferencia de configuracao que o outro nunca foi.
  const d = decidirGravacao(eventoRealDoWebhook(), {
    account_id: 6,
    inbox_id: 77,
  });
  assertEquals(d.desfecho, "inbox_divergente");
  assertEquals(d.inbox, "diverge");
});

Deno.test("inbox_id cadastrado e igual grava, e diz que conferiu", () => {
  const d = decidirGravacao(eventoRealDoWebhook(), {
    account_id: 6,
    inbox_id: 31,
  });
  assertEquals(d.desfecho, "gravar");
  assertEquals(d.inbox, "confere");
});

Deno.test("inbox_id nulo no cadastro nao bloqueia nada", () => {
  // A coluna existe e esta nula para este tenant. Exigir o que nao foi
  // cadastrado repetiria o erro que se esta consertando.
  const d = decidirGravacao(eventoRealDoWebhook(), CADASTRO);
  assertEquals(d.desfecho, "gravar");
  assertEquals(d.inbox, "sem_valor_no_cadastro");
});

Deno.test("inbox_id que falta no payload nao bloqueia o cadastrado", () => {
  const semInbox = eventoRealDoWebhook();
  delete semInbox.inbox_id;
  const d = decidirGravacao(semInbox, { account_id: 6, inbox_id: 31 });
  assertEquals(d.desfecho, "gravar");
  assertEquals(d.inbox, "sem_campo_no_payload");
});

Deno.test("telefone ausente vence a conferencia divergente", () => {
  // Preserva a ordem de hoje: a saida silenciosa de 200 vem antes do 403.
  const d = decidirGravacao(
    eventoRealDoWebhook({ account: { id: 99 }, meta: { assignee: null } }),
    CADASTRO,
  );
  assertEquals(d.desfecho, "contato_sem_telefone");
});

// ─── conferir: ausencia e divergencia sao coisas diferentes ─────────

Deno.test("conferir separa ausencia de divergencia", () => {
  assertEquals(conferir(6, 6), "confere");
  assertEquals(conferir(9, 6), "diverge");
  assertEquals(conferir(undefined, 6), "sem_campo_no_payload");
  assertEquals(conferir(null, 6), "sem_campo_no_payload");
  assertEquals(conferir(6, null), "sem_valor_no_cadastro");
  assertEquals(conferir(6, undefined), "sem_valor_no_cadastro");
});

Deno.test("conferir aceita numero em texto, que e como JSON as vezes vem", () => {
  assertEquals(conferir("6", 6), "confere");
  assertEquals(conferir(6, "6"), "confere");
  assertEquals(conferir("9", 6), "diverge");
});

Deno.test("conferir nao confunde zero com ausencia", () => {
  // `Number("")` e `Number(null)` valem 0: uma guarda por valor falso
  // leria string vazia como a conta zero e as declararia iguais.
  assertEquals(conferir(0, 0), "confere");
  assertEquals(conferir("", 6), "sem_campo_no_payload");
  assertEquals(conferir(6, ""), "sem_valor_no_cadastro");
  assertEquals(conferir("abc", 6), "sem_campo_no_payload");
});

// ─── O log de quem gravou sem conferir tudo ─────────────────────────

Deno.test("quem grava sem conferir registra o que nao conferiu", () => {
  // Gravar calado seria trocar um ponto cego por outro: ninguem saberia
  // que a conferencia de configuracao parou de acontecer.
  const d = decidirGravacao(eventoRealDoWebhook(), CADASTRO);
  const m = motivoDeNaoConferir(eventoRealDoWebhook(), d);
  assert(m.startsWith("chatwoot-events gravou sem conferir:"));
  assertStringIncludes(m, "conta=sem_campo_no_payload");
  assertStringIncludes(m, "inbox=sem_valor_no_cadastro");
});

Deno.test("o log de gravacao lista as chaves de dentro de messages[0]", () => {
  // O topo do webhook nao tem `account_id`. Saber se ele existe DENTRO de
  // `messages` e o que decide se a conferencia da para ser restaurada, e
  // so um evento real responde isso.
  const m = motivoDeNaoConferir(eventoRealDoWebhook(), {
    desfecho: "gravar",
    conta: "sem_campo_no_payload",
    inbox: "sem_valor_no_cadastro",
  });
  assertStringIncludes(m, "chaves_de_messages0=[");
  assertStringIncludes(m, "account_id");
  assertStringIncludes(m, "conversation_id");
});

Deno.test("sem messages o log diz que nao havia, em vez de mentir", () => {
  const sem = eventoRealDoWebhook({ messages: [] });
  const d = decidirGravacao(sem, CADASTRO);
  assertStringIncludes(
    motivoDeNaoConferir(sem, d),
    "chaves_de_messages0=<sem-messages>",
  );
});

Deno.test("o log de gravacao nao vaza telefone, nome nem conteudo", () => {
  // `messages[0]` e o pior lugar do payload para imprimir: tem o texto da
  // mensagem, o nome e o telefone da pessoa, tudo junto.
  const ev = eventoRealDoWebhook();
  const m = motivoDeNaoConferir(ev, decidirGravacao(ev, CADASTRO));
  assertFalse(m.includes(TELEFONE_DA_PESSOA));
  assertFalse(m.includes("5511987654321"));
  assertFalse(m.includes(NOME_DA_PESSOA));
  assertFalse(m.includes("Oi, aqui e"));
});

Deno.test("o log de gravacao cabe numa linha so", () => {
  const ev = eventoRealDoWebhook({
    messages: [{ "chave\ncom\nquebra": 1, conteudo: "a\nb" }],
  });
  const m = motivoDeNaoConferir(ev, decidirGravacao(ev, CADASTRO));
  assertFalse(m.includes("\n"));
  assertFalse(m.includes("\r"));
});

Deno.test("o log de quem nao gravou tambem lista messages[0]", () => {
  // Quando o contato vem sem numero, a pergunta seguinte e se o telefone
  // estaria em outro lugar do payload — e `messages` e o unico aninhado
  // que ele tem. Sem as chaves de dentro dele, o diagnostico para no
  // mesmo lugar em que parou hoje.
  const m = motivoDeNaoGravar("contato_sem_telefone", eventoRealDoWebhook());
  assertStringIncludes(m, "chaves_de_messages0=[");
  assertStringIncludes(m, "conversation_id");
  assertFalse(m.includes(TELEFONE_DA_PESSOA));
  assertFalse(m.includes(NOME_DA_PESSOA));
});
