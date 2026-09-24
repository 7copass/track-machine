import "server-only";
import { cache } from "react";
import { servidor } from "./supabase";

export type Resumo = {
  /** Gasto do período pedido, inteiro — é o que o card de Gasto mostra. */
  gasto: number;
  /**
   * A parte do gasto que caiu dentro da janela de captura.
   *
   * É o numerador de `cplMedio`, e existe separado de `gasto` porque os dois
   * respondem perguntas diferentes: quanto se gastou no período, e quanto se
   * gastou enquanto havia como contar lead. Igual a `gasto` sempre que o
   * período pedido começar depois do início da captura — e é por essa
   * igualdade que a tela decide se precisa explicar a divisão.
   */
  gastoComCaptura: number;
  leads: number;
  anuncios: number;
  /**
   * `gastoComCaptura / leads`, truncado — nunca `gasto / leads`.
   *
   * Ver `inicioDaCaptura`: dividir os 90 dias de gasto pelos leads de 5 dias
   * dava R$ 1.084,80 onde o número é R$ 11,16.
   */
  cplMedio: number | null;
  /** Primeiro dia com lead, `YYYY-MM-DD`. Nulo enquanto não houver nenhum. */
  inicioCaptura: string | null;
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
 * O tipo admite `null` porque a coluna admite: quando um anúncio aparece
 * nos insights antes do enriquecimento resolvê-lo na Graph API, ele entra
 * no cache sem `act_id`. Hoje isso não acontece com nenhum — o backfill de
 * 23/09 resolveu os 43 que faltavam, e a medição de agora dá **0 de 840 no
 * cache, 0 de 836 na janela de 90 dias**. O nulo continua possível para
 * anúncio novo, e o nulo que chegar aqui é o do banco, não erro de
 * leitura.
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

/**
 * Primeiro dia em que houve lead — a âncora da janela de captura.
 *
 * **O problema que isto existe para resolver.** O gasto tem 90 dias porque
 * veio de um backfill da Meta; lead só existe a partir do dia em que a
 * captura entrou no ar, e a Meta não guarda quem mandou mensagem antes.
 * Dividir um pelo outro mistura duas janelas: medido em 23/09/2026,
 * R$ 31.459,21 ÷ 29 = R$ 1.084,80, contra R$ 323,86 ÷ 29 = R$ 11,16 na
 * janela em que havia captura. Só 1,0% do gasto é de quando dava para
 * contar lead — o card errava por 97x, e quem olhasse concluiria que as
 * campanhas são um desastre.
 *
 * **A consulta não filtra por período, de propósito.** A âncora é o início
 * real da captura, não o primeiro dia com lead *dentro* da janela pedida.
 * Com a segunda leitura, pedir 4 dias — janela que já começa depois da
 * captura — jogaria fora o gasto dos dias sem lead ali dentro (medido:
 * R$ 5,70 em 19/09) e a tela exibiria uma ressalva sobre uma janela que não
 * tem nada de misturado.
 *
 * **A ressalva que o leitor futuro precisa conhecer: isto é um proxy.** O
 * banco não registra em que dia a captura foi ligada; registra o primeiro
 * lead. Se a captura tivesse subido alguns dias antes do primeiro lead
 * chegar, o gasto desses dias ficaria de fora do numerador e o CPL sairia
 * **otimista** — mais barato do que é. Aqui as duas datas coincidem
 * (primeiro touchpoint em `ad_touchpoints` e primeiro dia com lead são
 * ambos 2026-09-18), então o proxy serve. O dia em que deixarem de
 * coincidir, o número passa a ter esse viés sem nada na tela indicando.
 *
 * Nem `min(received_at)` de `ad_touchpoints` resolveria: também é a
 * primeira mensagem, não o momento em que se passou a escutar — e ainda
 * discordaria do que a view chama de lead, que é o touchpoint casado com
 * uma linha de insight do mesmo dia.
 */
export const inicioDaCaptura = cache(async function (): Promise<
  string | null
> {
  const db = servidor();

  const { data, error } = await db
    .from("desempenho_por_anuncio")
    .select("dia")
    .gt("leads", 0)
    .order("dia", { ascending: true })
    .limit(1);

  // Sem lead nenhum a resposta é uma lista vazia, que é um dado. Erro de
  // rede ou de permissão também devolveria lista vazia se não se olhasse
  // para `error` — e o painel diria "a captura ainda não começou" para uma
  // consulta que quebrou.
  if (error) {
    throw new Error(`Falha ao ler o inicio da captura: ${error.message}`);
  }

  const dia = data?.[0]?.dia;
  return dia === undefined || dia === null ? null : String(dia).slice(0, 10);
});

export async function resumo(dias: number): Promise<Resumo> {
  const [linhas, inicioCaptura] = await Promise.all([
    linhasDoPeriodo(dias),
    inicioDaCaptura(),
  ]);

  let gasto = 0;
  let gastoComCaptura = 0;
  let leads = 0;
  const ads = new Set<string>();

  for (const l of linhas) {
    const centavos = Number(l.gasto_centavos);
    const dia = String(l.dia).slice(0, 10);

    gasto += centavos;
    // `YYYY-MM-DD` ordena lexicograficamente igual ao calendário, então a
    // comparação é direta — e não passa por `Date`, que interpretaria a
    // string como meia-noite UTC e deslocaria o dia a oeste de Greenwich.
    if (inicioCaptura !== null && dia >= inicioCaptura) {
      gastoComCaptura += centavos;
    }
    leads += Number(l.leads ?? 0);
    ads.add(l.ad_id);
  }

  // Sobre os totais, nunca a média dos CPLs individuais — e sobre o gasto da
  // janela que tem lead, nunca o do período inteiro.
  const cplMedio = leads > 0 ? Math.floor(gastoComCaptura / leads) : null;

  return {
    gasto,
    gastoComCaptura,
    leads,
    anuncios: ads.size,
    cplMedio,
    inicioCaptura,
  };
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

export type LinhaCriativo = {
  nome: string | null;
  /** Quantos objetos de anúncio entraram nesta linha. */
  vezes: number;
  /** A campanha, quando é uma só; `null` quando o criativo rodou em várias. */
  campanha: string | null;
  campanhas: number;
  contas: number;
  /**
   * Se faz sentido cobrar lead deste criativo.
   *
   * Decidido no agrupamento e não na tela, porque o grupo pode misturar
   * destinos: o mesmo criativo pode ter rodado numa campanha de mensagem
   * e numa de visita ao perfil.
   */
  geraLead: boolean;
  gasto: number;
  leads: number;
  cpl: number | null;
};

const DESTINOS_COM_LEAD = new Set([
  "WHATSAPP",
  "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP",
]);

/**
 * Uma linha por criativo, agrupando os anúncios pelo nome.
 *
 * **Por que nome e não `ad_id`.** Medido na base em 24/09/2026, com 836
 * anúncios no período: por `ad_id` são 836 linhas, todas distintas e todas
 * ilegíveis — o rótulo é um número de 17 dígitos. Por nome são 249 linhas,
 * e nenhum nome se repete. Nenhuma combinação de rótulos legíveis separa
 * os 836: por nome + conta ficam 742 ambíguos, e somando campanha e
 * conjunto ainda ficam 291. `AD03 - IMG - INFOR` são 20 anúncios, em duas
 * contas.
 *
 * Reusar o mesmo criativo em vários conjuntos é a prática normal na Meta, e
 * a pergunta que o operador faz é "esse criativo funciona?", não "esse
 * objeto de anúncio funciona?". O que impede o agrupamento de esconder
 * informação é a coluna `vezes`.
 */
export function criativos(linhas: LinhaAnuncio[]): LinhaCriativo[] {
  // Anúncio sem nome fica sozinho, na chave do próprio id: agrupar todos
  // os nulos juntos somaria gastos de anúncios sem relação nenhuma.
  const chave = (l: LinhaAnuncio) =>
    l.nome === null ? `id:${l.adId}` : `nome:${l.nome}`;

  const grupos = new Map<string, LinhaAnuncio[]>();
  for (const l of linhas) {
    const k = chave(l);
    const g = grupos.get(k);
    if (g) g.push(l);
    else grupos.set(k, [l]);
  }

  return [...grupos.values()]
    .map((g) => {
      const gasto = g.reduce((s, l) => s + l.gasto, 0);
      const leads = g.reduce((s, l) => s + l.leads, 0);
      const camps = new Set(g.map((l) => l.campanha));
      return {
        nome: g[0].nome,
        vezes: g.length,
        campanha: camps.size === 1 ? g[0].campanha : null,
        campanhas: camps.size,
        contas: new Set(g.map((l) => l.conta)).size,
        geraLead: g.some(
          (l) => l.destino !== null && DESTINOS_COM_LEAD.has(l.destino),
        ),
        gasto,
        leads,
        // Sobre o total. A média dos CPLs de cada anúncio dá outro número,
        // e o errado: pesa igual um anúncio de R$ 1 e um de R$ 900.
        cpl: leads > 0 ? Math.floor(gasto / leads) : null,
      };
    })
    .sort((a, b) => b.gasto - a.gasto);
}
