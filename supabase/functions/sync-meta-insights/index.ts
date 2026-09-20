import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { admin } from "../_shared/db.ts";
import { buscarInsights, ultimaFalha } from "../_shared/meta_insights.ts";
import {
  abrirExecucao,
  fecharExecucao,
  gravarBase,
  gravarRecortes,
  podeRodarManual,
} from "../_shared/insights_store.ts";

const DIAS_JANELA = 7;

/** Base primeiro: é o grão que a view de desempenho usa. */
const RECORTES = ["base", "posicionamento", "demografia"] as const;

type Trava = { pode: boolean; faltamSegundos: number };

function diaISO(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/**
 * Decide a trava do manual para cada tenant ANTES de abrir qualquer
 * execução.
 *
 * A ordem é o ponto todo. `abrirExecucao` grava em `sync_runs` com
 * `tipo = 'manual'`, e é de `sync_runs` que a trava lê. Consultando dentro
 * do laço, a primeira conta abriria a execução e a segunda conta DO MESMO
 * TENANT encontraria essa execução recém-aberta e se recusaria a rodar —
 * na primeira chamada, sem nada de errado ter acontecido.
 *
 * Não é hipótese: o tenant real tem duas contas de anúncio
 * (`act_269873128000933` e `act_1229418598976392`) sob o mesmo
 * `tenant_id`. O sintoma seria a segunda conta nunca receber gasto, com o
 * painel mostrando meia verdade e a resposta dizendo `pulado: trava`, que
 * o operador leria como "acabei de atualizar" em vez de erro.
 *
 * A trava continua sendo por tenant, não global: atualizar o cliente A não
 * impede atualizar o cliente B. `sync_runs` não tem coluna de conta, então
 * tenant é o grão mais fino que o esquema guarda — e é o grão certo, porque
 * o que se quer limitar é o botão, que dispara o tenant inteiro de uma vez.
 */
async function travasPorTenant(
  db: SupabaseClient,
  tenantIds: string[],
): Promise<Map<string, Trava>> {
  const travas = new Map<string, Trava>();

  for (const tenantId of tenantIds) {
    if (travas.has(tenantId)) continue;

    const { data: ultima, error } = await db
      .from("sync_runs")
      .select("iniciado_em")
      .eq("tenant_id", tenantId)
      .eq("tipo", "manual")
      .order("iniciado_em", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Consulta falhou: libera, como faz `podeRodarManual` com timestamp
    // ilegível — travar deixaria o botão morto sem como destravar. Mas
    // diz por quê: uma trava que parou de travar tem o mesmo sintoma de
    // tudo funcionando.
    if (error) {
      console.error(
        `Nao consegui ler a ultima rodada manual do tenant ${tenantId} ` +
          `(a trava fica liberada): ${error.message}`,
      );
    }

    travas.set(tenantId, podeRodarManual(ultima?.iniciado_em ?? null));
  }

  return travas;
}

/**
 * Registra em `sync_runs` uma tentativa que nem chegou a buscar nada.
 *
 * Sem isto, token ausente vira apenas log e um campo na resposta HTTP que
 * ninguém relê. Em `sync_runs` — a tabela que o operador olha quando o
 * painel está vazio — a conta simplesmente não apareceria, e o sintoma
 * ficaria igual ao de "não havia o que buscar".
 */
async function registrarFalhaSemBusca(
  db: SupabaseClient,
  opts: {
    tenantId: string;
    tipo: "recorrente" | "manual";
    desde: string;
    ate: string;
    erro: string;
  },
): Promise<void> {
  try {
    const id = await abrirExecucao(db, {
      tenantId: opts.tenantId,
      tipo: opts.tipo,
      desde: opts.desde,
      ate: opts.ate,
    });
    await fecharExecucao(db, id, { linhas: 0, erro: opts.erro });
  } catch (e) {
    // O registro da falha falhou. Não pode derrubar o resto da varredura:
    // as outras contas ainda têm gasto a trazer.
    console.error(`Nao consegui registrar a falha em sync_runs: ${e}`);
  }
}

/**
 * Sincronização recorrente e manual.
 *
 * A janela é de 7 dias, e não só de hoje, porque a Meta reescreve o
 * passado: gasto de ontem muda nos dias seguintes por ajuste de cobrança e
 * atribuição que fecha depois. Sem reescrever a janela, o painel diverge do
 * Gerenciador — e quando o cliente comparar os dois, quem perde a discussão
 * é o operador.
 *
 * `verify_jwt` fica LIGADO nesta função: ela não é webhook. O cron a chama
 * com a service_role_key, e o botão manual também. O JWT é justamente o que
 * a protege de ser disparada por qualquer um — rate limit estourado
 * derrubaria também as sincronizações agendadas.
 *
 * Toda conta que não sincroniza sai daqui com motivo escrito em
 * `sync_runs`: trava, token ausente, falha da API, truncamento ou erro de
 * gravação. Zero linhas sem motivo registrado é o modo de falha que esta
 * função existe para não ter.
 */
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const corpo = await req.json().catch(() => ({}));
  const tipo: "recorrente" | "manual" =
    corpo?.tipo === "manual" ? "manual" : "recorrente";

  const db = admin();
  const versao = Deno.env.get("META_API_VERSION") ?? "v21.0";

  const { data: contas, error: erroContas } = await db
    .from("ad_accounts")
    .select("tenant_id, act_id, token_ref")
    .order("act_id");

  // Consulta quebrada respondendo "nenhuma cadastrada" mandaria o operador
  // conferir o cadastro, que está certo. O 500 também faz o cron registrar
  // a chamada como falha em vez de sucesso vazio.
  if (erroContas) {
    console.error(`Nao consegui listar as contas: ${erroContas.message}`);
    return Response.json(
      { ok: false, erro: `falha ao listar contas: ${erroContas.message}` },
      { status: 500 },
    );
  }

  if (!contas?.length) {
    return Response.json({ ok: true, contas: 0, motivo: "nenhuma cadastrada" });
  }

  const desde = diaISO(DIAS_JANELA);
  const ate = diaISO(0);
  const resultado: unknown[] = [];

  const travas = tipo === "manual"
    ? await travasPorTenant(db, contas.map((c) => c.tenant_id as string))
    : new Map<string, Trava>();

  for (const conta of contas) {
    // A trava do manual é por tenant, não global: um operador atualizando o
    // cliente A não deve impedir que ele atualize o cliente B. A decisão foi
    // tomada antes do laço, sobre o estado de `sync_runs` de antes desta
    // chamada — ver `travasPorTenant`.
    if (tipo === "manual") {
      const trava = travas.get(conta.tenant_id) ??
        { pode: true, faltamSegundos: 0 };
      if (!trava.pode) {
        resultado.push({
          act_id: conta.act_id,
          pulado: "trava",
          faltam_segundos: trava.faltamSegundos,
        });
        continue;
      }
    }

    // `token_ref` é o NOME do segredo, nunca o segredo. Conta cadastrada sem
    // nome nenhum é estado real durante o onboarding, e `Deno.env.get` com
    // undefined estouraria o laço inteiro.
    const ref = typeof conta.token_ref === "string" ? conta.token_ref : null;
    const token = ref ? Deno.env.get(ref) : undefined;

    if (!token) {
      // Sem isso o sintoma seria "zero linhas", igual ao de não haver o que
      // buscar — e o operador procuraria o problema no lugar errado.
      const motivo = ref
        ? `token ausente: ${ref} nao esta no ambiente da funcao`
        : "conta sem token_ref cadastrado";
      console.error(`${motivo} (conta ${conta.act_id})`);
      await registrarFalhaSemBusca(db, {
        tenantId: conta.tenant_id,
        tipo,
        desde,
        ate,
        erro: `${motivo} (conta ${conta.act_id})`,
      });
      resultado.push({ act_id: conta.act_id, linhas: 0, erro: motivo });
      continue;
    }

    let execId: number;
    try {
      execId = await abrirExecucao(db, {
        tenantId: conta.tenant_id,
        tipo,
        desde,
        ate,
      });
    } catch (e) {
      // Sem execução aberta não há onde registrar o resto, mas as outras
      // contas continuam: uma linha que não entrou em `sync_runs` não é
      // motivo para nenhum gasto chegar.
      const motivo = e instanceof Error ? e.message : String(e);
      console.error(`Conta ${conta.act_id} nao sincronizou: ${motivo}`);
      resultado.push({ act_id: conta.act_id, linhas: 0, erro: motivo });
      continue;
    }

    let linhas = 0;
    let erro: string | undefined;
    // Quantas linhas cada recorte trouxe, separadas das gravadas: a
    // diferença entre as duas é o que `semDuplicatas` colapsou, e o
    // tamanho do recorte é o que decide se a janela ainda cabe numa
    // invocação de Edge Function.
    const porRecorte: Record<
      string,
      { recebidas: number; gravadas: number }
    > = {};

    try {
      for (const recorte of RECORTES) {
        const r = await buscarInsights({
          token,
          actId: conta.act_id,
          desde,
          ate,
          recorte,
          versao,
        });

        // Inclui `truncado`: período que não coube no teto de páginas volta
        // como null, e gravar as páginas que deram tempo subestimaria o
        // gasto em silêncio.
        if (!r) {
          erro = `busca de ${recorte} falhou: ${ultimaFalha}`;
          break;
        }

        const recebidas = recorte === "base"
          ? r.base.length
          : r.recortes.length;
        const gravadas = recorte === "base"
          ? await gravarBase(db, conta.tenant_id, r.base)
          : await gravarRecortes(db, conta.tenant_id, recorte, r.recortes);

        porRecorte[recorte] = { recebidas, gravadas };
        linhas += gravadas;
      }
    } catch (e) {
      // `gravarBase` e `gravarRecortes` estouram quando o lote tem duas
      // linhas diferentes para a mesma chave. A mensagem nomeia a chave, e
      // é ela que precisa chegar a `sync_runs`.
      erro = e instanceof Error ? e.message : String(e);
    }

    await fecharExecucao(db, execId, { linhas, erro });
    resultado.push({
      act_id: conta.act_id,
      linhas,
      por_recorte: porRecorte,
      erro: erro ?? null,
    });
  }

  return Response.json({ ok: true, tipo, desde, ate, contas: resultado });
});
