/**
 * Carga histórica de insights.
 *
 * Processa a janela em blocos de 7 dias e grava UMA LINHA DE sync_runs POR
 * BLOCO, não uma por execução. É isso que dá o ponto de retomada: rodar de
 * novo pula os blocos que já têm linha com status 'ok'. Sem isso, falhar
 * aos 80 dias de 90 custaria refazer tudo.
 *
 * Consequência para quem lê a tabela: um backfill de 90 dias produz ~13
 * linhas de tipo 'backfill', enquanto uma sincronização recorrente produz
 * uma. O carimbo de "atualizado às" da tela usa a mais recente de tipo
 * 'recorrente' ou 'manual', ignorando as de 'backfill'.
 *
 * O bloco é a unidade de retomada, e o bloco é POR TENANT, cobrindo TODAS
 * as contas dele. Não é detalhe de arrumação: `sync_runs` não tem coluna de
 * conta, então a consulta de retomada só sabe casar tenant + janela. Com um
 * laço de contas por fora, a primeira conta gravaria a linha 'ok' do bloco
 * e a segunda conta DO MESMO TENANT encontraria essa linha e pularia o
 * bloco inteiro — nunca recebendo gasto nenhum, em silêncio e para sempre,
 * porque a retomada continuaria pulando nas execuções seguintes.
 *
 * Não é hipótese: o tenant real tem duas contas (`act_269873128000933` e
 * `act_1229418598976392`) sob o mesmo `tenant_id`, e a primeira versão
 * deste CLI perdeu a segunda exatamente assim. É o mesmo tropeço que
 * `travasPorTenant` documenta na Edge Function, entrando por outra porta.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  buscarInsights,
  ultimaFalha,
} from "../supabase/functions/_shared/meta_insights.ts";
import {
  abrirExecucao,
  fecharExecucao,
  gravarBase,
  gravarRecortes,
} from "../supabase/functions/_shared/insights_store.ts";

/**
 * Tamanho do bloco — medido, não estimado.
 *
 * A densidade real da conta é de 7,5 linhas de demografia e 4,5 de
 * posicionamento por anúncio-dia. Medido aqui: um bloco de 7 dias com ~100
 * anúncios ativos/dia deu 10.273 linhas gravadas. Se um bloco falhar por
 * tamanho, reduza ESTE número antes de mexer em qualquer outra coisa — o
 * desenho de blocos existe exatamente para isso.
 */
const DIAS_POR_BLOCO = 7;

/** Base primeiro: é o grão que a view de desempenho usa. */
const RECORTES = ["base", "posicionamento", "demografia"] as const;

type Conta = { tenant_id: string; act_id: string; token_ref: string };

function carregarEnv(): Record<string, string> {
  const texto = Deno.readTextFileSync(new URL("../.env", import.meta.url));
  const env: Record<string, string> = {};
  for (const linha of texto.split("\n")) {
    const t = linha.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, v] = t.split(/=(.*)/s);
    env[k.trim()] = v.trim();
  }
  return env;
}

function dia(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const env = carregarEnv();
  // A forma com `=` é a única que funciona: o parser junta Deno.args com
  // `&`, então `--dias 90` vira `dias&90` e o valor se perde. A guarda
  // logo abaixo transforma isso em falha explícita.
  const args = new URLSearchParams(
    Deno.args.join("&").replaceAll("--", ""),
  );
  const totalDias = Number(args.get("dias") ?? 90);

  // `--dias 90`, com espaco, vira `dias&90` no join e `args.get("dias")`
  // devolve string vazia — nao null — entao o `?? 90` nao entra e
  // `Number("")` da 0. Medido: o laco de blocos nao roda nenhuma vez e o
  // CLI sai em silencio, com cara de sucesso. Sem esta guarda o operador
  // acharia que os 90 dias entraram.
  if (!Number.isFinite(totalDias) || totalDias < 1) {
    console.error(
      `--dias invalido (${JSON.stringify(args.get("dias"))}). Use a forma ` +
        `com "=", por exemplo --dias=90: com espaco o valor se perde.`,
    );
    Deno.exit(2);
  }

  const db = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: contas, error: erroContas } = await db
    .from("ad_accounts").select("tenant_id, act_id, token_ref").order("act_id");

  // Consulta quebrada respondendo "nenhuma cadastrada" mandaria o operador
  // conferir o cadastro, que está certo — foi exatamente o que este CLI fez
  // na primeira execução, com a chave de serviço ainda ausente do `.env`.
  // Aqui o erro derruba a carga em vez de continuar: seguir marcaria um
  // backfill inteiro como "nada a fazer".
  if (erroContas) {
    console.error(`Nao consegui listar as contas: ${erroContas.message}`);
    Deno.exit(1);
  }

  if (!contas?.length) {
    console.log("Nenhuma conta cadastrada.");
    return;
  }

  const versao = env.META_API_VERSION ?? "v21.0";

  const porTenant = new Map<string, Conta[]>();
  for (const c of contas as Conta[]) {
    const lista = porTenant.get(c.tenant_id) ?? [];
    lista.push(c);
    porTenant.set(c.tenant_id, lista);
  }

  for (const [tenantId, contasDoTenant] of porTenant) {
    console.log(
      `\ntenant ${tenantId} — ${contasDoTenant.length} conta(s), ` +
        `${totalDias} dias em blocos de ${DIAS_POR_BLOCO}`,
    );

    for (let inicio = totalDias; inicio > 0; inicio -= DIAS_POR_BLOCO) {
      const desde = dia(inicio);
      const ate = dia(Math.max(inicio - DIAS_POR_BLOCO + 1, 1));

      // Retomada: bloco que já terminou com 'ok' é pulado.
      const { data: feito, error: erroFeito } = await db
        .from("sync_runs")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("tipo", "backfill")
        .eq("janela_inicio", desde)
        .eq("janela_fim", ate)
        .eq("status", "ok")
        .maybeSingle();

      // Consulta de retomada quebrada não pode virar "não estava feito":
      // refazer é caro mas correto, então avisa e refaz, nunca pula.
      if (erroFeito) {
        console.error(
          `  ${desde} → ${ate}  nao consegui checar a retomada ` +
            `(vou refazer o bloco): ${erroFeito.message}`,
        );
      }

      if (feito) {
        console.log(`  ${desde} → ${ate}  já feito, pulando`);
        continue;
      }

      const execId = await abrirExecucao(db, {
        tenantId,
        tipo: "backfill",
        desde,
        ate,
      });

      let linhas = 0;
      let erro: string | undefined;
      const porConta: string[] = [];

      try {
        for (const conta of contasDoTenant) {
          // `token_ref` é o NOME do segredo, nunca o segredo. Token ausente
          // ESTOURA o bloco em vez de pular a conta: um bloco marcado 'ok'
          // sem os dados dela seria pulado para sempre pela retomada.
          const token = env[conta.token_ref];
          if (!token) {
            throw new Error(
              `token ${conta.token_ref} ausente no .env (conta ` +
                `${conta.act_id})`,
            );
          }

          let daConta = 0;
          for (const recorte of RECORTES) {
            const r = await buscarInsights({
              token,
              actId: conta.act_id,
              desde,
              ate,
              recorte,
              versao,
            });
            // Inclui `truncado`: período que não coube no teto de páginas
            // volta como null, e gravar o que deu tempo subestimaria o
            // gasto em silêncio.
            if (!r) {
              throw new Error(`${conta.act_id}/${recorte}: ${ultimaFalha}`);
            }
            daConta += recorte === "base"
              ? await gravarBase(db, tenantId, r.base)
              : await gravarRecortes(db, tenantId, recorte, r.recortes);
          }

          linhas += daConta;
          porConta.push(`${conta.act_id}:${daConta}`);
        }
      } catch (e) {
        // `gravarBase` e `gravarRecortes` estouram quando o lote tem duas
        // linhas diferentes para a mesma chave. A mensagem nomeia a chave,
        // e é ela que precisa chegar a `sync_runs`.
        erro = e instanceof Error ? e.message : String(e);
      }

      await fecharExecucao(db, execId, { linhas, erro });
      console.log(
        `  ${desde} → ${ate}  ` +
          (erro ? `✗ ${erro}` : `${linhas} linhas (${porConta.join(", ")})`),
      );

      // Respira entre blocos: a carga histórica não tem pressa e não pode
      // consumir a cota que as sincronizações agendadas precisam.
      if (!erro) await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

if (import.meta.main) await main();
