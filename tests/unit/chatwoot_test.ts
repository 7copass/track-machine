import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  buscarContatoPorTelefone,
  gravarAtributosDeOrigem,
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
