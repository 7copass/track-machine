/**
 * Os períodos que a tela oferece, e a leitura do parâmetro da URL.
 *
 * Módulo próprio porque a lista é usada em dois lugares que precisam
 * concordar: o seletor, que desenha as opções, e a página, que valida o que
 * veio na URL. Se discordarem, o seletor mostra um período e a tela exibe
 * outro — e o operador lê o número errado achando que trocou.
 */

export const PERIODOS = [7, 30, 90] as const;

export const PADRAO = 90;

/**
 * O período pedido na URL, ou 90.
 *
 * Aceita só os três da lista. Qualquer outro valor cairia em 90 de qualquer
 * jeito — mas em silêncio, com o seletor marcando o que a URL pediu e a
 * tela mostrando outra coisa.
 *
 * Lista é recusada de propósito: `?dias=7&dias=30` chega como `["7","30"]`,
 * e `Number(["7"])` vale 7 por coerção de array. Sem esta guarda, uma URL
 * com o parâmetro repetido decidiria o período por acidente da coerção.
 */
export function periodoPedido(bruto: string | string[] | undefined): number {
  if (typeof bruto !== "string") return PADRAO;
  const n = Number(bruto);
  return (PERIODOS as readonly number[]).includes(n) ? n : PADRAO;
}
