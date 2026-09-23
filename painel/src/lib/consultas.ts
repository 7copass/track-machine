import "server-only";
import { cache } from "react";
import { servidor } from "./supabase";

export type Resumo = {
  gasto: number;
  leads: number;
  anuncios: number;
  cplMedio: number | null;
};

export type PontoDia = { dia: string; gasto: number };

export type LinhaAnuncio = {
  adId: string;
  nome: string | null;
  campanha: string | null;
  /**
   * De qual conta de anúncio o anúncio veio.
   *
   * Não é decoração: o tenant real tem duas contas, e existem anúncios com
   * o MESMO nome em cada uma — dois `ad01`, em contas diferentes, ambos na
   * campanha `VAGA`. Sem mostrar a conta, a tabela exibe duas linhas
   * idênticas no rótulo e o operador conclui que o painel duplicou.
   */
  conta: string | null;
  destino: string | null;
  gasto: number;
  leads: number;
  cpl: number | null;
};

/** Uma linha da view, como o PostgREST a devolve. */
type LinhaView = {
  ad_id: string;
  ad_name: string | null;
  campaign_name: string | null;
  destination_type: string | null;
  dia: string;
  // `bigint` chega como string para não perder precisão.
  gasto_centavos: number | string;
  leads: number | string | null;
};

/**
 * Data de corte do período, no formato que a coluna `dia` usa.
 *
 * Calculado em UTC, e é por isso que a conferência contra o SQL direto usa
 * `(now() at time zone 'UTC')::date - N` e não `current_date - N`:
 * `current_date` segue o fuso do banco. Perto da virada do dia os dois
 * discordam de um dia inteiro, e a divergência parece bug de agregação
 * quando é só de referencial.
 */
function desde(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/**
 * O PostgREST corta toda resposta em 1000 linhas.
 *
 * O teto é do servidor (`db-max-rows`), não do pedido: `.limit(50000)` é
 * aceito sem reclamar e devolve 1000 mesmo assim. Não vem erro, não vem
 * aviso — vem um subconjunto com cara de resposta inteira. A view tem
 * 4.163 linhas, então uma leitura ingênua enxerga menos de um quarto do
 * gasto e o painel mostra um número errado com toda a confiança.
 *
 * Pior: ler menos linhas mantém o painel **coerente consigo mesmo**. A
 * soma dos dias continua batendo com a soma dos anúncios, porque as duas
 * saem das mesmas 1000 linhas. Só a conferência contra o SQL direto pega.
 */
const TAMANHO_PAGINA = 1000;

type Pagina<T> = {
  data: T[] | null;
  count: number | null;
  error: { message: string } | null;
};

/**
 * Lê uma consulta inteira, página por página.
 *
 * Duas coisas fazem isso funcionar e nenhuma é opcional:
 *
 * 1. **Ordem total.** Página sem `ORDER BY` é um recorte arbitrário do
 *    plano de execução: duas páginas podem repetir linha e pular outra, e
 *    o total sai errado sem nada indicar. Quem chama precisa ordenar por
 *    uma chave única.
 * 2. **Conferir o total.** O `count` exato do PostgREST diz quantas linhas
 *    existem. Se o que se leu não bater com ele, isto **levanta** em vez de
 *    devolver uma leitura curta — número errado em silêncio é o único
 *    desfecho que este painel não pode ter.
 */
async function lerTudo<T>(
  rotulo: string,
  buscar: (de: number, ate: number) => PromiseLike<Pagina<T>>,
): Promise<T[]> {
  const todas: T[] = [];
  let total: number | null = null;

  for (let de = 0; ; ) {
    const { data, count, error } = await buscar(de, de + TAMANHO_PAGINA - 1);
    if (error) throw new Error(`Falha ao ler ${rotulo}: ${error.message}`);
    if (count !== null) total = count;

    const pagina = data ?? [];
    todas.push(...pagina);
    // Avança pelo que veio, não pelo que se pediu: se o teto do servidor
    // baixar, um passo fixo de 1000 pularia linhas em silêncio.
    de += pagina.length;

    if (pagina.length === 0) break;
    if (total !== null && todas.length >= total) break;
  }

  if (total !== null && todas.length !== total) {
    throw new Error(
      `Leitura incompleta de ${rotulo}: ${todas.length} de ${total} linhas.`,
    );
  }
  return todas;
}

/**
 * Lê a view inteira do período — uma vez por carregamento.
 *
 * O `cache` do React deduplica dentro da mesma renderização: as três
 * funções abaixo chamam esta, e sem ele a página buscaria as mesmas
 * ~4 mil linhas **três vezes** para exibi-las uma. Com ele, a primeira
 * chamada busca e as outras duas recebem o mesmo resultado.
 *
 * Se o volume crescer a ponto de incomodar, o caminho é agregar no
 * Postgres — não paginar mais fino aqui.
 */
const linhasDoPeriodo = cache(async function (dias: number) {
  const db = servidor();
  const corte = desde(dias);

  // `(dia, ad_id)` é único nas 4.163 linhas da view, então a ordem é
  // total e a paginação não repete nem pula linha.
  return lerTudo<LinhaView>("desempenho_por_anuncio", (de, ate) =>
    db
      .from("desempenho_por_anuncio")
      .select(
        "ad_id, ad_name, campaign_name, destination_type, dia, gasto_centavos, leads",
        { count: "exact" },
      )
      .gte("dia", corte)
      .order("dia", { ascending: true })
      .order("ad_id", { ascending: true })
      .range(de, ate),
  );
});

/**
 * De qual conta é cada anúncio.
 *
 * Vem numa segunda consulta porque a view `desempenho_por_anuncio` **não
 * projeta `act_id`**: ela faz o join com `ad_accounts` só para descobrir o
 * fuso com que datar os leads, e não carrega a conta para a saída. Pedir
 * `act_id` na view devolve erro do PostgREST, não `null`.
 *
 * A alternativa seria alterar a view, mas isso é migração de banco — fora
 * do escopo desta tarefa, e caro para uma coluna que só a tabela usa.
 *
 * Nem todo anúncio tem conta conhecida: 42 dos 840 estão no cache sem
 * `act_id`. O nulo aqui é o do banco, não um erro de leitura.
 */
const contaPorAnuncio = cache(async function () {
  const db = servidor();

  const linhas = await lerTudo<{ ad_id: string; act_id: string | null }>(
    "ad_metadata_cache",
    (de, ate) =>
      db
        .from("ad_metadata_cache")
        .select("ad_id, act_id", { count: "exact" })
        .order("ad_id", { ascending: true })
        .range(de, ate),
  );

  const mapa = new Map<string, string | null>();
  for (const l of linhas) mapa.set(l.ad_id, l.act_id ?? null);
  return mapa;
});

export async function resumo(dias: number): Promise<Resumo> {
  const linhas = await linhasDoPeriodo(dias);

  let gasto = 0;
  let leads = 0;
  const ads = new Set<string>();

  for (const l of linhas) {
    gasto += Number(l.gasto_centavos);
    leads += Number(l.leads ?? 0);
    ads.add(l.ad_id);
  }

  // Sobre os totais, nunca a média dos CPLs individuais.
  const cplMedio = leads > 0 ? Math.floor(gasto / leads) : null;

  return { gasto, leads, anuncios: ads.size, cplMedio };
}

export async function gastoPorDia(dias: number): Promise<PontoDia[]> {
  const linhas = await linhasDoPeriodo(dias);

  const porDia = new Map<string, number>();
  for (const l of linhas) {
    const d = String(l.dia).slice(0, 10);
    porDia.set(d, (porDia.get(d) ?? 0) + Number(l.gasto_centavos));
  }

  return [...porDia.entries()]
    .map(([dia, gasto]) => ({ dia, gasto }))
    .sort((a, b) => a.dia.localeCompare(b.dia));
}

export async function anuncios(dias: number): Promise<LinhaAnuncio[]> {
  const [linhas, contas] = await Promise.all([
    linhasDoPeriodo(dias),
    contaPorAnuncio(),
  ]);

  const porAd = new Map<string, LinhaAnuncio>();
  for (const l of linhas) {
    const atual = porAd.get(l.ad_id) ?? {
      adId: l.ad_id,
      nome: l.ad_name,
      campanha: l.campaign_name,
      conta: contas.get(l.ad_id) ?? null,
      destino: l.destination_type,
      gasto: 0,
      leads: 0,
      cpl: null,
    };
    atual.gasto += Number(l.gasto_centavos);
    atual.leads += Number(l.leads ?? 0);
    // O nome chega pelo enriquecimento e pode faltar em algumas linhas do
    // mesmo anúncio; a primeira que tiver vale.
    atual.nome ??= l.ad_name;
    atual.campanha ??= l.campaign_name;
    atual.destino ??= l.destination_type;
    porAd.set(l.ad_id, atual);
  }

  return [...porAd.values()]
    .map((a) => ({
      ...a,
      // Nulo quando não há lead — nunca infinito, nunca divisão por zero.
      cpl: a.leads > 0 ? Math.floor(a.gasto / a.leads) : null,
    }))
    .sort((a, b) => b.gasto - a.gasto);
}

/** Carimbo de "atualizado às", ignorando as execuções de carga histórica. */
export async function ultimaAtualizacao(): Promise<string | null> {
  const db = servidor();
  const { data } = await db
    .from("sync_runs")
    .select("iniciado_em")
    .in("tipo", ["recorrente", "manual"])
    .eq("status", "ok")
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.iniciado_em ?? null;
}
