import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import {
  buscarInsights,
  ultimaFalha,
} from "../../supabase/functions/_shared/meta_insights.ts";

function mockFetch(resposta: unknown, status = 200) {
  const original = globalThis.fetch;
  const chamadas: string[] = [];
  globalThis.fetch = ((url: string | URL | Request) => {
    chamadas.push(String(url));
    return Promise.resolve(
      new Response(JSON.stringify(resposta), {
        status, headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { chamadas, restaurar: () => { globalThis.fetch = original; } };
}

const OPTS = {
  token: "tok", actId: "act_1",
  desde: "2026-09-14", ate: "2026-09-20",
};

Deno.test("traz o grao base normalizado", async () => {
  const m = mockFetch({
    data: [{
      ad_id: "1", date_start: "2026-09-18", spend: "340.00",
      impressions: "12000", inline_link_clicks: "340",
    }],
  });
  try {
    const r = await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(r!.base.length, 1);
    assertEquals(r!.base[0].gasto_centavos, 34000);
    assertEquals(r!.recortes.length, 0);
  } finally { m.restaurar(); }
});

Deno.test("monta a chave do recorte de posicionamento", async () => {
  const m = mockFetch({
    data: [{
      ad_id: "1", date_start: "2026-09-18", spend: "120.00",
      publisher_platform: "instagram", platform_position: "story",
    }],
  });
  try {
    const r = await buscarInsights({ ...OPTS, recorte: "posicionamento" });
    assertEquals(r!.recortes[0].chave,
      { platform: "instagram", position: "story" });
    assertEquals(r!.recortes[0].gasto_centavos, 12000);
  } finally { m.restaurar(); }
});

Deno.test("monta a chave do recorte de demografia", async () => {
  const m = mockFetch({
    data: [{
      ad_id: "1", date_start: "2026-09-18", spend: "90.00",
      age: "25-34", gender: "female",
    }],
  });
  try {
    const r = await buscarInsights({ ...OPTS, recorte: "demografia" });
    assertEquals(r!.recortes[0].chave, { idade: "25-34", genero: "female" });
  } finally { m.restaurar(); }
});

Deno.test("pede time_increment=1 para vir dia a dia", async () => {
  // Sem isso a Meta devolve o periodo agregado numa linha so, e o grao
  // diario — que e o da chave primaria — se perde.
  const m = mockFetch({ data: [] });
  try {
    await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(m.chamadas[0].includes("time_increment=1"), true);
  } finally { m.restaurar(); }
});

Deno.test("segue a paginacao ate o fim", async () => {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (() => {
    n++;
    const corpo = n === 1
      ? { data: [{ ad_id: "1", date_start: "2026-09-18", spend: "10" }],
          paging: { next: "https://graph.facebook.com/proxima" } }
      : { data: [{ ad_id: "2", date_start: "2026-09-18", spend: "20" }] };
    return Promise.resolve(new Response(JSON.stringify(corpo), { status: 200 }));
  }) as typeof fetch;
  try {
    const r = await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(r!.base.length, 2);
  } finally { globalThis.fetch = original; }
});

Deno.test("devolve null e registra o motivo quando o token expira", async () => {
  // Token revogado para de trazer dado para TODAS as contas, nao so uma.
  // Sem registrar o motivo, o sintoma e igual ao de "nao havia nada".
  const m = mockFetch({ error: { code: 190, message: "expirado" } }, 401);
  try {
    assertEquals(await buscarInsights({ ...OPTS, recorte: "base" }), null);
    const mod = await import(
      "../../supabase/functions/_shared/meta_insights.ts"
    );
    assertEquals(mod.ultimaFalha, "erro_api");
  } finally { m.restaurar(); }
});

Deno.test("registra falha de rede", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(new TypeError("conexao recusada"))) as typeof fetch;
  try {
    assertEquals(await buscarInsights({ ...OPTS, recorte: "base" }), null);
    const mod = await import(
      "../../supabase/functions/_shared/meta_insights.ts"
    );
    assertEquals(mod.ultimaFalha, "rede");
  } finally { globalThis.fetch = original; }
});

Deno.test("sucesso limpa a falha anterior", async () => {
  // Falha velha colada faria o alerta disparar para sempre depois que a
  // Meta voltasse.
  const m = mockFetch({ data: [] });
  try {
    await buscarInsights({ ...OPTS, recorte: "base" });
    const mod = await import(
      "../../supabase/functions/_shared/meta_insights.ts"
    );
    assertEquals(mod.ultimaFalha, null);
  } finally { m.restaurar(); }
});

// ─── Acrescentados ao plano ─────────────────────────────────────
//
// Os oito de cima sao os do plano. Os de baixo cobrem caminhos que eles
// deixam passar: dois deles passariam com a implementacao errada, e tres
// cobrem codigo que o plano escreve e nunca exercita.

function mockPaginas(
  paginas: Array<Record<string, unknown>>,
) {
  const original = globalThis.fetch;
  const chamadas: string[] = [];
  globalThis.fetch = ((url: string | URL | Request) => {
    const corpo = paginas[Math.min(chamadas.length, paginas.length - 1)];
    chamadas.push(String(url));
    return Promise.resolve(
      new Response(JSON.stringify(corpo), { status: 200 }),
    );
  }) as typeof fetch;
  return { chamadas, restaurar: () => { globalThis.fetch = original; } };
}

Deno.test("manda breakdowns no recorte e nao manda no base", async () => {
  // Sem breakdowns a Meta responde no grao base, e toda linha sairia daqui
  // com chave vazia — {platform:"",position:""} para todas. Como a chave
  // entra na primaria do recorte, elas colidiriam e sobrescreveriam umas as
  // outras ate sobrar uma, sem erro nenhum.
  const m = mockFetch({ data: [] });
  try {
    await buscarInsights({ ...OPTS, recorte: "posicionamento" });
    assertEquals(
      decodeURIComponent(m.chamadas[0])
        .includes("breakdowns=publisher_platform,platform_position"),
      true,
    );
    await buscarInsights({ ...OPTS, recorte: "demografia" });
    assertEquals(
      decodeURIComponent(m.chamadas[1]).includes("breakdowns=age,gender"),
      true,
    );
    await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(m.chamadas[2].includes("breakdowns"), false);
  } finally { m.restaurar(); }
});

Deno.test("recorte nao contamina o grao base", async () => {
  // O grao base e o recorte vao para tabelas diferentes. Uma chamada de
  // recorte que tambem enchesse `base` duplicaria o gasto do dia.
  const m = mockFetch({
    data: [{
      ad_id: "1", date_start: "2026-09-18", spend: "120.00",
      publisher_platform: "facebook", platform_position: "feed",
    }],
  });
  try {
    const r = await buscarInsights({ ...OPTS, recorte: "posicionamento" });
    assertEquals(r!.base.length, 0);
    assertEquals(r!.recortes.length, 1);
  } finally { m.restaurar(); }
});

Deno.test("leva level=ad para a linha vir com ad_id", async () => {
  // Sem level=ad a resposta volta no grao da conta, sem ad_id — e cada
  // linha seria descartada aqui por falta de chave. A sincronizacao
  // terminaria "com sucesso" e zero linhas gravadas.
  const m = mockFetch({ data: [] });
  try {
    await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(m.chamadas[0].includes("level=ad"), true);
  } finally { m.restaurar(); }
});

Deno.test("segue exatamente a url que veio em paging.next", async () => {
  // O teste de paginacao do plano nao olha para onde a segunda chamada
  // foi: um laco que repetisse a MESMA url tambem devolveria duas linhas
  // e passaria. Aqui a segunda chamada precisa ser a url do paging.
  const m = mockPaginas([
    { data: [{ ad_id: "1", date_start: "2026-09-18", spend: "10" }],
      paging: { next: "https://graph.facebook.com/v21.0/act_1/insights?after=X" } },
    { data: [{ ad_id: "2", date_start: "2026-09-18", spend: "20" }] },
  ]);
  try {
    const r = await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(r!.base.length, 2);
    assertEquals(m.chamadas.length, 2);
    assertEquals(
      m.chamadas[1],
      "https://graph.facebook.com/v21.0/act_1/insights?after=X",
    );
  } finally { m.restaurar(); }
});

Deno.test("para no teto de paginas em vez de girar para sempre", async () => {
  // Resposta que sempre aponta para a proxima pagina deixaria a Edge
  // Function girando ate o limite de execucao: nada gravado, nenhum erro,
  // e a sincronizacao simplesmente nao termina nunca.
  const m = mockPaginas([
    { data: [{ ad_id: "1", date_start: "2026-09-18", spend: "1" }],
      paging: { next: "https://graph.facebook.com/proxima" } },
  ]);
  try {
    const r = await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(m.chamadas.length, 100);
    assertEquals(r!.base.length, 100);
  } finally { m.restaurar(); }
});

Deno.test("http sem corpo de erro registra http, nao erro_api", async () => {
  // O tipo declara "http" e nenhum teste do plano chega nele: todos os
  // casos de falha la tem corpo de erro. Sem cobertura, a variante poderia
  // nunca ser atribuida e ninguem notaria.
  const m = mockFetch({}, 500);
  try {
    assertEquals(await buscarInsights({ ...OPTS, recorte: "base" }), null);
    assertEquals(ultimaFalha, "http");
    assertNotEquals(ultimaFalha, "erro_api");
  } finally { m.restaurar(); }
});

Deno.test("502 com corpo em HTML e falha http, nao de rede", async () => {
  // Proxy e CDN devolvem HTML. Se o json() estourasse sem tratamento, o
  // catch de fora marcaria "rede" e mandaria procurar queda de conexao
  // quando o que houve foi a Meta (ou o proxy dela) recusar.
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    )) as typeof fetch;
  try {
    assertEquals(await buscarInsights({ ...OPTS, recorte: "base" }), null);
    assertEquals(ultimaFalha, "http");
  } finally { globalThis.fetch = original; }
});

Deno.test("usa a versao recebida em vez da padrao", async () => {
  // Versao da Graph API tem prazo de validade. Se o parametro fosse
  // ignorado, trocar META_API_VERSION nao mudaria nada e a descoberta
  // viria quando a Meta parasse de responder.
  const m = mockFetch({ data: [] });
  try {
    await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(
      /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/act_1\/insights\?/
        .test(m.chamadas[0]),
      true,
    );
    await buscarInsights({ ...OPTS, recorte: "base", versao: "v23.0" });
    assertEquals(m.chamadas[1].startsWith(
      "https://graph.facebook.com/v23.0/act_1/insights?",
    ), true);
  } finally { m.restaurar(); }
});

Deno.test("codifica o token na url", async () => {
  // Token de app da Meta tem a forma "{app_id}|{secret}". Interpolado cru
  // numa query string, o "|" e caractere invalido em URL: proxy recusa e a
  // chamada nunca chega — com sintoma de falha de rede intermitente.
  const m = mockFetch({ data: [] });
  try {
    await buscarInsights({
      ...OPTS, token: "1234567890|s3cr3t", recorte: "base",
    });
    assertEquals(
      m.chamadas[0].includes("access_token=1234567890%7Cs3cr3t"), true);
    assertEquals(m.chamadas[0].includes("|"), false);
  } finally { m.restaurar(); }
});

Deno.test("descarta linha de recorte sem ad_id sem levar as boas junto", async () => {
  // O caminho do recorte tem guarda propria, que nao passa por
  // normalizarLinha e por isso nao herda o teste da Tarefa 3. Uma linha de
  // total agregado sem ad_id viria a reboque das boas.
  const m = mockFetch({
    data: [
      { date_start: "2026-09-18", spend: "999.00",
        publisher_platform: "facebook", platform_position: "feed" },
      { ad_id: "1", spend: "10.00",
        publisher_platform: "facebook", platform_position: "feed" },
      { ad_id: "2", date_start: "2026-09-18", spend: "50.00",
        publisher_platform: "instagram", platform_position: "story" },
    ],
  });
  try {
    const r = await buscarInsights({ ...OPTS, recorte: "posicionamento" });
    assertEquals(r!.recortes.length, 1);
    assertEquals(r!.recortes[0].ad_id, "2");
    assertEquals(r!.recortes[0].gasto_centavos, 5000);
  } finally { m.restaurar(); }
});

Deno.test("sucesso limpa a falha sem depender da ordem dos testes", async () => {
  // A versao do plano so prova algo porque o teste anterior deixou "rede"
  // em ultimaFalha. Rodando sozinha, ou se alguem reordenasse o arquivo,
  // ela passaria comparando null com null. Aqui a falha e provocada no
  // mesmo teste.
  const quebrado = mockFetch({ error: { code: 190, message: "expirado" } }, 401);
  try {
    await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(ultimaFalha, "erro_api");
  } finally { quebrado.restaurar(); }

  const bom = mockFetch({ data: [] });
  try {
    await buscarInsights({ ...OPTS, recorte: "base" });
    assertEquals(ultimaFalha, null);
  } finally { bom.restaurar(); }
});
