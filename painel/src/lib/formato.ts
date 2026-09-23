/**
 * Formatação para a tela.
 *
 * Módulo puro: é onde o erro de dinheiro aparece, e é por isso que ele é
 * o único da interface com teste.
 */

const MOEDA = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const MILHAR = new Intl.NumberFormat("pt-BR");

/**
 * O espaço que o `Intl` põe entre "R$" e o número.
 *
 * Não é o espaço comum: é U+00A0 (e U+202F em algumas versões do ICU).
 * Invisível no terminal, invisível no diff, e faz `toBe("R$ 18,64")` falhar
 * exibindo duas strings idênticas na tela — `expected 'R$ 18,64' to be
 * 'R$ 18,64'`. Normalizar aqui, uma vez, poupa esse mistério de quem for
 * escrever o próximo teste ou comparar o valor com qualquer outra coisa.
 *
 * A tela não perde nada: cada valor vive na sua própria célula ou card, sem
 * risco de "R$" quebrar linha sozinho.
 */
const ESPACO_DO_INTL = /[  ]/g;

/**
 * Centavos inteiros para moeda.
 *
 * O PostgREST devolve `bigint` como **string**, para não perder precisão —
 * tratar como número sem converter daria `NaN` na tela.
 */
export function reais(centavos: number | string | null): string {
  if (centavos === null || centavos === undefined) return "—";
  const n = Number(centavos);
  if (!Number.isFinite(n)) return "—";
  return MOEDA.format(n / 100).replace(ESPACO_DO_INTL, " ");
}

export function numero(v: number | string | null): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? MILHAR.format(n) : "—";
}

/**
 * Data de uma coluna `date`, sem deslocar pelo fuso.
 *
 * `new Date("2026-09-18")` é interpretado como meia-noite UTC; a oeste de
 * Greenwich isso vira 17/09 às 21h e a tela mostra o dia errado. Como a
 * coluna não tem hora, o certo é fatiar a string.
 */
export function diaCurto(iso: string): string {
  const [, mes, dia] = iso.slice(0, 10).split("-");
  return `${dia}/${mes}`;
}

export function horaCurta(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
