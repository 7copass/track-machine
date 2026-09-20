/**
 * Gravação dos insights e registro das execuções.
 *
 * O upsert é o que faz a janela móvel funcionar: como a Meta reescreve o
 * passado por dias, a mesma linha chega várias vezes com valores
 * diferentes. A chave primária composta garante correção no lugar.
 *
 * Este módulo não lê o ambiente: o cliente de banco chega por parâmetro,
 * como em `meta_insights.ts` e `chatwoot.ts`. É o que permite provar o
 * mapeamento das colunas com um dublê, sem banco e sem permissão.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { LinhaInsight } from "./insights_norm.ts";
import type { LinhaRecorte, Recorte } from "./meta_insights.ts";

const INTERVALO_MANUAL_SEGUNDOS = 300;

const LIBERADO = { pode: true, faltamSegundos: 0 };

/**
 * Decide se a atualização manual pode rodar.
 *
 * Função pura recebendo o timestamp que veio do banco, em vez de consultar
 * ela mesma: Edge Function não guarda estado entre invocações, então uma
 * trava em variável de módulo seria zerada a cada chamada e não travaria
 * nada.
 *
 * Todo caminho estranho libera, nunca trava. Travar seria pior: o operador
 * não teria como destravar, e o botão ficaria morto — sem nada no sistema
 * dizendo por quê. Os dois caminhos estranhos registram o motivo, porque o
 * sintoma de uma trava que nunca trava é idêntico ao de tudo funcionando.
 */
export function podeRodarManual(
  ultimaEm: string | null,
  agora: Date = new Date(),
): { pode: boolean; faltamSegundos: number } {
  if (!ultimaEm) return { ...LIBERADO };

  const t = Date.parse(ultimaEm);
  if (!Number.isFinite(t)) {
    console.warn(
      `sync_runs.iniciado_em ilegivel (${ultimaEm}): liberando o manual. ` +
        `Travar deixaria o botao morto sem como destravar.`,
    );
    return { ...LIBERADO };
  }

  const decorrido = (agora.getTime() - t) / 1000;

  // Timestamp no futuro além do que dá para explicar por defasagem de
  // relógio. `Number.isFinite` não pega isto — "2126-01-01" é data
  // perfeitamente válida — e sem tratar, o botão passaria cem anos
  // recusando: a mesma morte permanente do ramo acima, entrando por outra
  // porta.
  //
  // O limite é o próprio intervalo, e não zero, porque `iniciado_em` vem
  // do `now()` do banco enquanto `agora` vem do relógio da função: são
  // máquinas diferentes, e liberar a qualquer segundo no futuro deixaria
  // a trava sem efeito justamente logo depois de uma rodada, que é quando
  // ela existe para agir.
  if (decorrido < -INTERVALO_MANUAL_SEGUNDOS) {
    console.warn(
      `Ultima rodada manual marcada no futuro (${ultimaEm}): relogio ` +
        `errado ou valor corrompido. Liberando em vez de travar por tempo ` +
        `indeterminado.`,
    );
    return { ...LIBERADO };
  }

  if (decorrido >= INTERVALO_MANUAL_SEGUNDOS) return { ...LIBERADO };

  return {
    pode: false,
    // Arredonda para cima: para baixo, faltando meio segundo, o operador
    // leria "faltam 0 segundos" com o botão ainda recusando — número que
    // contradiz o próprio comportamento.
    faltamSegundos: Math.ceil(INTERVALO_MANUAL_SEGUNDOS - decorrido),
  };
}

export async function abrirExecucao(
  db: SupabaseClient,
  opts: {
    tenantId: string;
    tipo: "recorrente" | "manual" | "backfill";
    desde: string;
    ate: string;
  },
): Promise<number> {
  const { data, error } = await db.from("sync_runs").insert({
    tenant_id: opts.tenantId,
    tipo: opts.tipo,
    janela_inicio: opts.desde,
    janela_fim: opts.ate,
  }).select("id").single();

  // Seguir sem id gravaria insights sem execução correspondente, e a trava
  // do manual — que lê `sync_runs` — deixaria de travar em silêncio.
  if (error || !data) {
    throw new Error(
      `Nao consegui abrir sync_run para ${opts.tenantId}: ` +
        (error?.message ?? "insert devolveu linha vazia"),
    );
  }
  return data.id as number;
}

export async function fecharExecucao(
  db: SupabaseClient,
  id: number,
  opts: { linhas: number; erro?: string },
): Promise<void> {
  const { error } = await db.from("sync_runs").update({
    terminado_em: new Date().toISOString(),
    linhas_gravadas: opts.linhas,
    status: opts.erro ? "falhou" : "ok",
    erro: opts.erro ?? null,
  }).eq("id", id);

  // Não estoura: esta função é chamada depois do catch de quem sincroniza,
  // e estourar aqui trocaria o erro real — o que se quer registrar — por
  // um erro secundário de escrita.
  //
  // Mas também não engole: sem esta linha, a execução ficaria `rodando`
  // para sempre e nada diria por quê. Uma fila de execuções eternamente
  // abertas é exatamente o alarme falso que faria o operador parar de
  // olhar para `sync_runs`.
  if (error) {
    console.error(
      `Nao consegui fechar a sync_run ${id} (ela fica 'rodando'): ` +
        error.message,
    );
  }
}

/** Grava o grão base. Upsert porque a Meta reescreve o passado. */
export async function gravarBase(
  db: SupabaseClient,
  tenantId: string,
  linhas: LinhaInsight[],
): Promise<number> {
  if (linhas.length === 0) return 0;

  // Um `atualizado_em` só para o lote inteiro: as linhas foram gravadas na
  // mesma operação, e um timestamp por linha sugeriria uma ordem que não
  // existe.
  const agora = new Date().toISOString();

  const { error } = await db.from("meta_insights_diario").upsert(
    linhas.map((l) => ({
      tenant_id: tenantId,
      ad_id: l.ad_id,
      dia: l.dia,
      gasto_centavos: l.gasto_centavos,
      impressoes: l.impressoes,
      alcance: l.alcance,
      cliques: l.cliques,
      cliques_link: l.cliques_link,
      acoes: l.acoes,
      // A coluna tem default now(), mas default não reaplica em UPDATE: a
      // linha reescrita ficaria com a hora da primeira gravação.
      atualizado_em: agora,
    })),
    { onConflict: "tenant_id,ad_id,dia" },
  );

  if (error) throw new Error(`Falha ao gravar insights: ${error.message}`);
  return linhas.length;
}

export async function gravarRecortes(
  db: SupabaseClient,
  tenantId: string,
  tipo: Exclude<Recorte, "base">,
  linhas: LinhaRecorte[],
): Promise<number> {
  if (linhas.length === 0) return 0;

  const agora = new Date().toISOString();

  // Sem `cliques_link`: essa coluna existe no grão base e não nesta tabela.
  // Mandada aqui, o PostgREST recusa o lote inteiro e todos os recortes da
  // conta se perdem.
  const { error } = await db.from("meta_insights_recorte").upsert(
    linhas.map((l) => ({
      tenant_id: tenantId,
      ad_id: l.ad_id,
      dia: l.dia,
      tipo_recorte: tipo,
      chave: l.chave,
      gasto_centavos: l.gasto_centavos,
      impressoes: l.impressoes,
      alcance: l.alcance,
      cliques: l.cliques,
      acoes: l.acoes,
      atualizado_em: agora,
    })),
    { onConflict: "tenant_id,ad_id,dia,tipo_recorte,chave" },
  );

  if (error) throw new Error(`Falha ao gravar recortes: ${error.message}`);
  return linhas.length;
}
