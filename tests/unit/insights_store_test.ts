import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  abrirExecucao,
  fecharExecucao,
  gravarBase,
  gravarRecortes,
  podeRodarManual,
} from "../../supabase/functions/_shared/insights_store.ts";
import type { LinhaInsight } from "../../supabase/functions/_shared/insights_norm.ts";
import type { LinhaRecorte } from "../../supabase/functions/_shared/meta_insights.ts";

// ─── A trava do botao ───────────────────────────────────────────

// A trava vive no banco, nao em memoria: Edge Function nao guarda estado
// entre invocacoes, entao uma trava em variavel seria zerada a cada
// chamada e nao travaria nada. Esta funcao decide a partir do timestamp
// que veio do banco.

Deno.test("libera quando nunca rodou manualmente", () => {
  assertEquals(podeRodarManual(null).pode, true);
});

Deno.test("recusa dentro dos 5 minutos", () => {
  const agora = new Date("2026-09-20T12:00:00Z");
  const haDoisMin = "2026-09-20T11:58:00Z";
  const r = podeRodarManual(haDoisMin, agora);
  assertEquals(r.pode, false);
  assertEquals(r.faltamSegundos, 180);
});

Deno.test("libera depois dos 5 minutos", () => {
  const agora = new Date("2026-09-20T12:00:00Z");
  assertEquals(podeRodarManual("2026-09-20T11:54:00Z", agora).pode, true);
});

Deno.test("libera exatamente aos 5 minutos", () => {
  const agora = new Date("2026-09-20T12:00:00Z");
  assertEquals(podeRodarManual("2026-09-20T11:55:00Z", agora).pode, true);
});

Deno.test("timestamp invalido libera em vez de travar para sempre", () => {
  // Preferir liberar: uma data corrompida travaria o botao
  // permanentemente, e o operador nao teria como destravar.
  assertEquals(podeRodarManual("nao e data").pode, true);
});

Deno.test("faltamSegundos e zero quando pode rodar", () => {
  assertEquals(podeRodarManual(null).faltamSegundos, 0);
});

// ─── Trava: o que os seis acima nao cobrem ──────────────────────

Deno.test("aceita o timestamptz que o PostgREST devolve de verdade", () => {
  // Os casos do plano usam "...Z" redondo. O banco nao devolve isso:
  // `iniciado_em` e timestamptz e chega como microssegundos com
  // deslocamento — "2026-09-20T11:58:00.123456+00:00". Se esse formato
  // caisse no ramo de data invalida, a trava LIBERARIA sempre, em
  // silencio, e o botao nao travaria nada — com os seis testes do plano
  // verdes o tempo todo.
  const agora = new Date("2026-09-20T12:00:00Z");
  const r = podeRodarManual("2026-09-20T11:58:00.123456+00:00", agora);
  assertEquals(r.pode, false);
  // 119,877s decorridos: faltam 180,123, arredondados para cima.
  assertEquals(r.faltamSegundos, 181);
});

Deno.test("nunca diz 'faltam 0 segundos' enquanto ainda recusa", () => {
  // Arredondar para baixo daria 0 aqui: o operador leria "espere 0
  // segundos" e o botao continuaria recusando. Numero que contradiz o
  // proprio comportamento e pior que numero impreciso.
  const agora = new Date("2026-09-20T12:00:00Z");
  const r = podeRodarManual("2026-09-20T11:55:00.500Z", agora);
  assertEquals(r.pode, false);
  assertEquals(r.faltamSegundos, 1);
});

Deno.test("usa o relogio real quando o chamador nao passa agora", () => {
  // A Tarefa 6 chama com um argumento so. Nenhum dos seis testes do plano
  // exercita o relogio padrao com data valida — todos passam `agora` ou
  // entram pelo ramo de null/invalido —, entao um padrao errado
  // (`new Date(0)`, por exemplo) passaria por eles inteiro.
  const dezMinAtras = new Date(Date.now() - 10 * 60_000).toISOString();
  assertEquals(podeRodarManual(dezMinAtras).pode, true);
  assertEquals(podeRodarManual(new Date().toISOString()).pode, false);
});

Deno.test("data valida mas absurda no futuro libera, nao mata o botao", () => {
  // `Number.isFinite(Date.parse(...))` nao pega isto: "2126-01-01" e data
  // perfeitamente valida. Sem tratar, o botao ficaria recusando por cem
  // anos — exatamente a morte permanente que o ramo de data invalida
  // existe para evitar, so que entrando por outra porta.
  const agora = new Date("2026-09-20T12:00:00Z");
  assertEquals(podeRodarManual("2126-01-01T00:00:00Z", agora).pode, true);
});

Deno.test("defasagem pequena de relogio nao destrava a trava", () => {
  // `iniciado_em` vem do now() do banco e `agora` do relogio da funcao:
  // maquinas diferentes, alguns segundos de diferenca. Liberar a qualquer
  // timestamp no futuro deixaria a trava sem efeito justamente quando ela
  // importa — logo depois de uma rodada.
  const agora = new Date("2026-09-20T12:00:00Z");
  const r = podeRodarManual("2026-09-20T12:00:02Z", agora);
  assertEquals(r.pode, false);
});

// ─── Gravacao: o duble de banco ─────────────────────────────────

// O upsert so e provado de verdade pela asserção pgTAP da Tarefa 1, que
// exercita o banco. O que falta provar aqui e o que a Tarefa 1 nao ve: se
// este modulo manda as colunas com o nome que a tabela tem e o onConflict
// com a chave primaria que a migration declarou. Coluna errada e recusada
// pelo PostgREST em tempo de execucao, nao de compilacao, e derruba o lote
// inteiro.

type Chamada = {
  tabela: string;
  operacao: "upsert" | "insert" | "update";
  linhas: Record<string, unknown>[];
  opcoes?: { onConflict?: string };
  filtro?: [string, unknown];
};

function dbFalso(
  resposta: { data?: Record<string, unknown>; erro?: string } = {},
) {
  const chamadas: Chamada[] = [];
  const devolucao = {
    data: resposta.data ?? null,
    error: resposta.erro ? { message: resposta.erro } : null,
  };

  const db = {
    from(tabela: string) {
      return {
        upsert(
          linhas: Record<string, unknown>[],
          opcoes?: { onConflict?: string },
        ) {
          chamadas.push({ tabela, operacao: "upsert", linhas, opcoes });
          return Promise.resolve(devolucao);
        },
        insert(linha: Record<string, unknown>) {
          chamadas.push({ tabela, operacao: "insert", linhas: [linha] });
          return { select: () => ({ single: () => Promise.resolve(devolucao) }) };
        },
        update(linha: Record<string, unknown>) {
          const c: Chamada = { tabela, operacao: "update", linhas: [linha] };
          chamadas.push(c);
          return {
            eq: (coluna: string, valor: unknown) => {
              c.filtro = [coluna, valor];
              return Promise.resolve(devolucao);
            },
          };
        },
      };
    },
  };

  return { db: db as unknown as SupabaseClient, chamadas };
}

const TENANT = "11111111-1111-1111-1111-111111111111";

const LINHA_BASE: LinhaInsight = {
  ad_id: "ad_1",
  dia: "2026-09-18",
  gasto_centavos: 34000,
  impressoes: 12000,
  alcance: 8400,
  cliques: 512,
  cliques_link: 340,
  acoes: { link_click: 340 },
};

const LINHA_RECORTE: LinhaRecorte = {
  ad_id: "ad_1",
  dia: "2026-09-18",
  chave: { idade: "25-34", genero: "female" },
  gasto_centavos: 9000,
  impressoes: 3000,
  alcance: 2000,
  cliques: 120,
  acoes: { link_click: 90 },
};

Deno.test("gravarBase manda as colunas que meta_insights_diario tem", async () => {
  const { db, chamadas } = dbFalso();
  assertEquals(await gravarBase(db, TENANT, [LINHA_BASE]), 1);
  assertEquals(chamadas.length, 1);
  assertEquals(chamadas[0].tabela, "meta_insights_diario");

  const linha = chamadas[0].linhas[0];
  assertEquals(Object.keys(linha).sort(), [
    "acoes",
    "ad_id",
    "alcance",
    "atualizado_em",
    "cliques",
    "cliques_link",
    "dia",
    "gasto_centavos",
    "impressoes",
    "tenant_id",
  ]);
  assertEquals(linha.tenant_id, TENANT);
  assertEquals(linha.ad_id, "ad_1");
  assertEquals(linha.dia, "2026-09-18");
  assertEquals(linha.gasto_centavos, 34000);
  assertEquals(linha.impressoes, 12000);
  assertEquals(linha.alcance, 8400);
  assertEquals(linha.cliques, 512);
  assertEquals(linha.cliques_link, 340);
  assertEquals(linha.acoes, { link_click: 340 });
  // Coluna tem default now(), mas default nao reaplica em UPDATE: sem
  // mandar explicito, a linha reescrita ficaria com a hora da primeira
  // gravacao e ninguem saberia quando o valor mudou.
  assertEquals(Number.isFinite(Date.parse(String(linha.atualizado_em))), true);
});

Deno.test("gravarBase corrige no lugar: onConflict e a chave primaria", async () => {
  // Sem onConflict o PostgREST tenta INSERT puro e a segunda passagem da
  // janela movel estoura com violacao de chave — ou, pior, duplicaria o
  // gasto do mesmo dia se a chave fosse outra.
  const { db, chamadas } = dbFalso();
  await gravarBase(db, TENANT, [LINHA_BASE]);
  assertEquals(chamadas[0].opcoes?.onConflict, "tenant_id,ad_id,dia");
});

Deno.test("gravarBase nao chama o banco com lista vazia", async () => {
  const { db, chamadas } = dbFalso();
  assertEquals(await gravarBase(db, TENANT, []), 0);
  assertEquals(chamadas.length, 0);
});

Deno.test("gravarBase estoura com o motivo quando o banco recusa", async () => {
  const { db } = dbFalso({ erro: "column \"gasto\" does not exist" });
  const e = await assertRejects(
    () => gravarBase(db, TENANT, [LINHA_BASE]),
    Error,
  );
  assertStringIncludes(e.message, "does not exist");
});

Deno.test("gravarRecortes manda as colunas que meta_insights_recorte tem", async () => {
  const { db, chamadas } = dbFalso();
  assertEquals(await gravarRecortes(db, TENANT, "demografia", [LINHA_RECORTE]), 1);
  assertEquals(chamadas[0].tabela, "meta_insights_recorte");

  const linha = chamadas[0].linhas[0];
  // A lista e exata de proposito. `cliques_link` existe no grao base e NAO
  // existe nesta tabela: mandado aqui, o PostgREST recusa o lote inteiro
  // com PGRST204 e todos os recortes da conta se perdem.
  assertEquals(Object.keys(linha).sort(), [
    "acoes",
    "ad_id",
    "alcance",
    "atualizado_em",
    "chave",
    "cliques",
    "dia",
    "gasto_centavos",
    "impressoes",
    "tenant_id",
    "tipo_recorte",
  ]);
  assertEquals(linha.tenant_id, TENANT);
  assertEquals(linha.chave, { idade: "25-34", genero: "female" });
  assertEquals(linha.gasto_centavos, 9000);
  assertEquals(linha.cliques, 120);
});

Deno.test("gravarRecortes marca o tipo recebido, nao um chumbado", async () => {
  // Tipo chumbado gravaria demografia como posicionamento: as duas linhas
  // cabem na tabela, a check constraint aceita, e o painel mostraria faixa
  // etaria na aba de posicionamento sem erro nenhum.
  for (const tipo of ["posicionamento", "demografia"] as const) {
    const { db, chamadas } = dbFalso();
    await gravarRecortes(db, TENANT, tipo, [LINHA_RECORTE]);
    assertEquals(chamadas[0].linhas[0].tipo_recorte, tipo);
  }
});

Deno.test("gravarRecortes usa a chave composta inteira no onConflict", async () => {
  const { db, chamadas } = dbFalso();
  await gravarRecortes(db, TENANT, "demografia", [LINHA_RECORTE]);
  assertEquals(
    chamadas[0].opcoes?.onConflict,
    "tenant_id,ad_id,dia,tipo_recorte,chave",
  );
});

Deno.test("gravarRecortes nao chama o banco com lista vazia", async () => {
  const { db, chamadas } = dbFalso();
  assertEquals(await gravarRecortes(db, TENANT, "demografia", []), 0);
  assertEquals(chamadas.length, 0);
});

Deno.test("gravarRecortes estoura com o motivo quando o banco recusa", async () => {
  const { db } = dbFalso({ erro: "violates check constraint" });
  const e = await assertRejects(
    () => gravarRecortes(db, TENANT, "demografia", [LINHA_RECORTE]),
    Error,
  );
  assertStringIncludes(e.message, "check constraint");
});

// ─── Registro das execucoes ─────────────────────────────────────

Deno.test("abrirExecucao registra a janela e devolve o id", async () => {
  const { db, chamadas } = dbFalso({ data: { id: 42 } });
  const id = await abrirExecucao(db, {
    tenantId: TENANT,
    tipo: "manual",
    desde: "2026-09-13",
    ate: "2026-09-20",
  });
  assertEquals(id, 42);
  assertEquals(chamadas[0].tabela, "sync_runs");
  assertEquals(chamadas[0].linhas[0], {
    tenant_id: TENANT,
    tipo: "manual",
    janela_inicio: "2026-09-13",
    janela_fim: "2026-09-20",
  });
});

Deno.test("abrirExecucao estoura quando nao consegue abrir", async () => {
  // Seguir sem id gravaria insights sem nenhuma execucao correspondente, e
  // a trava do manual — que le sync_runs — deixaria de travar.
  const { db } = dbFalso({ erro: "violates foreign key" });
  const e = await assertRejects(
    () =>
      abrirExecucao(db, {
        tenantId: TENANT,
        tipo: "manual",
        desde: "2026-09-13",
        ate: "2026-09-20",
      }),
    Error,
  );
  assertStringIncludes(e.message, "foreign key");
});

Deno.test("fecharExecucao marca ok quando nao houve erro", async () => {
  const { db, chamadas } = dbFalso();
  await fecharExecucao(db, 42, { linhas: 1400 });
  assertEquals(chamadas[0].tabela, "sync_runs");
  assertEquals(chamadas[0].filtro, ["id", 42]);

  const linha = chamadas[0].linhas[0];
  assertEquals(linha.status, "ok");
  assertEquals(linha.linhas_gravadas, 1400);
  assertEquals(linha.erro, null);
  assertEquals(Number.isFinite(Date.parse(String(linha.terminado_em))), true);
});

Deno.test("fecharExecucao marca falhou e guarda o motivo", async () => {
  const { db, chamadas } = dbFalso();
  await fecharExecucao(db, 42, { linhas: 0, erro: "busca de base falhou: rede" });
  assertEquals(chamadas[0].linhas[0].status, "falhou");
  assertEquals(chamadas[0].linhas[0].erro, "busca de base falhou: rede");
});

Deno.test("fecharExecucao reclama em vez de engolir quando o update falha", async () => {
  // Sem registrar, a execucao fica 'rodando' para sempre e nada diz por
  // que. E nao pode estourar: fecharExecucao e chamada depois do catch da
  // Tarefa 6, e estourar aqui trocaria o erro real da sincronizacao por
  // um erro secundario de escrita.
  const { db } = dbFalso({ erro: "connection reset" });
  const original = console.error;
  const ditos: string[] = [];
  console.error = (...a: unknown[]) => { ditos.push(a.map(String).join(" ")); };
  try {
    await fecharExecucao(db, 42, { linhas: 7 });
  } finally {
    console.error = original;
  }
  assertEquals(ditos.length, 1);
  assertStringIncludes(ditos[0], "42");
  assertStringIncludes(ditos[0], "connection reset");
});
