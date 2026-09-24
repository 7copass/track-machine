/**
 * A geometria do gráfico de gasto por dia.
 *
 * Está fora do componente porque é onde o erro é caro e barato de pegar: um
 * ponto na coordenada errada continua sendo um desenho bonito, e ninguém
 * olha para um gráfico desconfiando dele. Aqui a escala é função pura —
 * entra uma lista de dias, sai um caminho de SVG — e se confere com
 * aritmética à mão, em milissegundos, sem banco e sem navegador.
 *
 * Todas as coordenadas estão em unidades do `viewBox`, nunca em pixels: o
 * SVG é escalado pela largura do cartão, e quem converte pixel de volta para
 * unidade é o componente, num lugar só.
 */
import type { PontoDia } from "./consultas";

/**
 * O quadro do desenho, em unidades do `viewBox`.
 *
 * As margens não são estéticas: `topo` deixa a linha de grade de cima caber
 * sem cortar o traço de 2px no dia de pico, e `base` reserva a faixa onde
 * ficam os rótulos das pontas do eixo.
 */
export const MEDIDAS = {
  larg: 1000,
  alt: 160,
  esq: 8,
  dir: 8,
  topo: 12,
  base: 22,
} as const;

export type PontoDesenhado = {
  dia: string;
  gasto: number;
  x: number;
  y: number;
};

export type Desenho = {
  /** O maior gasto do período, em centavos — o que o topo da escala vale. */
  maximo: number;
  pontos: PontoDesenhado[];
  /** Caminho da série. */
  linha: string;
  /** O mesmo caminho, fechado no piso: a área sob a curva. */
  area: string;
  /** y das três linhas de grade, do piso ao topo. */
  grade: number[];
  /** y do eixo. */
  piso: number;
};

const MS_POR_DIA = 86_400_000;

/**
 * A data `YYYY-MM-DD` como número de dias, sem passar pelo fuso.
 *
 * `new Date("2026-09-01")` é meia-noite UTC, e a oeste de Greenwich isso é
 * 31/08 às 21h. Para uma coluna `date` — que não tem hora — o certo é
 * fatiar a string e montar o instante em UTC, como `diaCurto` já faz na
 * formatação.
 */
function emDias(iso: string): number {
  const [ano, mes, dia] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(ano, mes - 1, dia) / MS_POR_DIA;
}

/** Duas casas bastam no `viewBox`, e poupam o markup de floats de 17 dígitos. */
function arredonda(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Converte a série em coordenadas e caminhos.
 *
 * Espera `pontos` em ordem crescente de dia — é o que `gastoPorDia` devolve.
 *
 * **O eixo x é tempo, não posição na lista.** A view não tem uma linha por
 * dia de calendário: dias em que nenhum anúncio teve entrega não têm linha
 * nenhuma. Medido em 23/09/2026: 87 dias presentes num intervalo de 90, e os
 * três ausentes (26/07, 02/08, 20/09) são domingos. Espaçando por índice,
 * esses dias somem do eixo e a distância entre dois pontos deixa de
 * significar tempo — uma semana sem sincronizar viraria um passo igual ao de
 * um dia, sem nada na tela indicando.
 */
export function desenhar(pontos: PontoDia[]): Desenho {
  const { larg, alt, esq, dir, topo } = MEDIDAS;
  const piso = alt - MEDIDAS.base;
  const util = larg - esq - dir;

  const maximo = pontos.length === 0
    ? 0
    : pontos.reduce((m, p) => Math.max(m, p.gasto), 0);

  // O divisor existe separado do máximo para que um período inteiro sem
  // gasto não vire 0/0 — e para que `maximo` continue sendo o número que a
  // tela pode exibir como topo da escala, sem inventar um centavo.
  const divisor = maximo === 0 ? 1 : maximo;
  const y = (v: number) => arredonda(topo + (piso - topo) * (1 - v / divisor));

  const grade = [0, 0.5, 1].map((f) => y(divisor * f));

  if (pontos.length === 0) {
    return { maximo, pontos: [], linha: "", area: "", grade, piso };
  }

  const primeiro = emDias(pontos[0].dia);
  const vao = emDias(pontos[pontos.length - 1].dia) - primeiro;

  // Um dia só não tem intervalo: fica no meio do quadro, que é onde um
  // ponto solitário se lê como ponto e não como começo de linha cortada.
  const x = (dia: string) =>
    vao === 0
      ? arredonda(esq + util / 2)
      : arredonda(esq + ((emDias(dia) - primeiro) / vao) * util);

  const desenhados: PontoDesenhado[] = pontos.map((p) => ({
    dia: p.dia,
    gasto: p.gasto,
    x: x(p.dia),
    y: y(p.gasto),
  }));

  const passos = desenhados.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`);
  // Um caminho com um `M` só não renderiza nada: o cartão ficaria vazio
  // afirmando que não houve gasto, quando houve um dia inteiro dele. Um
  // segmento de comprimento zero com ponta redonda vira um ponto.
  const linha = desenhados.length === 1
    ? `${passos[0]} L${desenhados[0].x},${desenhados[0].y}`
    : passos.join(" ");

  const fim = desenhados[desenhados.length - 1];
  const area = `${linha} L${fim.x},${piso} L${desenhados[0].x},${piso} Z`;

  return { maximo, pontos: desenhados, linha, area, grade, piso };
}

/**
 * O índice do ponto mais perto de um x — o dia que o mouse está apontando.
 *
 * Varre a lista em vez de dividir pelo passo: com o eixo em tempo o passo
 * não é constante, e arredondar uma divisão pularia o dia vizinho de um
 * buraco. Noventa comparações por `mousemove` não se sentem.
 */
export function indiceMaisProximo(x: number, pontos: PontoDesenhado[]): number {
  let melhor = 0;
  let menor = Infinity;
  for (let i = 0; i < pontos.length; i++) {
    const d = Math.abs(pontos[i].x - x);
    if (d < menor) {
      menor = d;
      melhor = i;
    }
  }
  return melhor;
}
