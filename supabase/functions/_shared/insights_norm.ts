/**
 * Tradução dos valores da Marketing API para o formato do banco.
 *
 * Módulo puro: sem rede, sem banco, sem ambiente. É o que permite testar
 * todas as armadilhas de formato sem subir nada.
 */

export type LinhaInsight = {
  ad_id: string;
  dia: string;
  gasto_centavos: number;
  impressoes: number;
  alcance: number;
  cliques: number;
  cliques_link: number;
  acoes: Record<string, number>;
};

/**
 * Converte o valor monetário da Meta para centavos inteiros.
 *
 * A conversão é feita sobre a string, não multiplicando o float por 100:
 * `19.99 * 100` em ponto flutuante dá `1998.9999999999998`, e arredondar
 * isso funciona na maioria dos casos e erra em alguns — o pior tipo de bug
 * em número que o cliente confere.
 *
 * A terceira casa decimal é arredondada, não cortada. `spend` vem com duas
 * casas, mas os campos de custo da mesma resposta (`cpc`, `cpm`,
 * `cost_per_action_type`) vêm com mais — e truncar perderia até um centavo
 * por linha, sempre para baixo. O arredondamento também é feito sobre a
 * string: o vai-um sobe sozinho porque 99 + 1 entra no total em centavos.
 *
 * O sinal é aplicado à parte porque `parseInt("-0")` é `-0`, e `-0 * 100`
 * é `0`: sem o `Math.abs` com sinal separado, um estorno de "-0.50"
 * entraria no banco como +50 centavos.
 */
export function paraCentavos(valor: unknown): number {
  if (valor === null || valor === undefined) return 0;

  const texto = String(valor).trim();
  if (!/^-?\d+(\.\d+)?$/.test(texto)) return 0;

  const [inteira, decimal = ""] = texto.split(".");
  const casas = (decimal + "000").slice(0, 3);
  const sinal = inteira.startsWith("-") ? -1 : 1;

  let centavos = parseInt(casas.slice(0, 2), 10);
  if (parseInt(casas[2], 10) >= 5) centavos += 1;

  return sinal * (Math.abs(parseInt(inteira, 10)) * 100 + centavos);
}

function paraInteiro(valor: unknown): number {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Achata o array `actions` da Meta em objeto com o tipo como chave.
 *
 * Guardar o array cru obrigaria toda consulta do painel a varrê-lo; como
 * objeto, `acoes->>'link_click'` resolve com índice.
 */
export function acoesParaObjeto(raw: unknown): Record<string, number> {
  if (!Array.isArray(raw)) return {};

  const saida: Record<string, number> = {};
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const tipo = (item as Record<string, unknown>)["action_type"];
    const valor = Number((item as Record<string, unknown>)["value"]);
    if (typeof tipo !== "string" || !Number.isFinite(valor)) continue;
    saida[tipo] = valor;
  }
  return saida;
}

/** Traduz uma linha da API, ou `null` se ela não tiver chave possível. */
export function normalizarLinha(
  bruto: Record<string, unknown>,
): LinhaInsight | null {
  const adId = bruto["ad_id"];
  const dia = bruto["date_start"];

  // Sem os dois não há chave primária. Gravar linha incompleta produziria
  // lixo que só aparece muito depois, na consulta do painel.
  if (typeof adId !== "string" || typeof dia !== "string") return null;

  return {
    ad_id: adId,
    dia,
    gasto_centavos: paraCentavos(bruto["spend"]),
    impressoes: paraInteiro(bruto["impressions"]),
    alcance: paraInteiro(bruto["reach"]),
    cliques: paraInteiro(bruto["clicks"]),
    cliques_link: paraInteiro(bruto["inline_link_clicks"]),
    acoes: acoesParaObjeto(bruto["actions"]),
  };
}
