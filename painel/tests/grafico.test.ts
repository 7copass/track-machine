import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GraficoGasto } from "@/componentes/GraficoGasto";
import { MEDIDAS, desenhar, indiceMaisProximo } from "@/lib/grafico";
import type { PontoDia } from "@/lib/consultas";
import { gastoPorDia } from "@/lib/consultas";

// A geometria do gráfico é o quarto lugar onde um erro produz número errado
// em silêncio — só que aqui o número é uma coordenada, e o silêncio é pior:
// uma linha errada continua sendo uma linha bonita. Por isso a escala saiu
// de dentro do componente: função pura, testada com aritmética à mão, em
// milissegundos, sem banco e sem navegador.

/**
 * Quatro dias consecutivos, com valores escolhidos para que toda coordenada
 * seja exata e conferível de cabeça.
 *
 * Área de desenho: x de 8 a 992 (1000 - 8 - 8), y de 12 a 138 (160 - 22).
 * Com 3 dias de intervalo entre as pontas, cada dia vale 984/3 = 328.
 */
/** Roda `corpo` como se a máquina estivesse em `fuso` — igual ao de `formato.test.ts`. */
function comFuso<T>(fuso: string, corpo: () => T): T {
  const anterior = process.env.TZ;
  process.env.TZ = fuso;
  try {
    return corpo();
  } finally {
    if (anterior === undefined) delete process.env.TZ;
    else process.env.TZ = anterior;
  }
}

const QUATRO_DIAS: PontoDia[] = [
  { dia: "2026-09-01", gasto: 0 },
  { dia: "2026-09-02", gasto: 50 },
  { dia: "2026-09-03", gasto: 100 },
  { dia: "2026-09-04", gasto: 25 },
];

describe("desenhar", () => {
  it("põe cada dia na sua coordenada, e o maior gasto no topo", () => {
    const d = desenhar(QUATRO_DIAS);

    expect(d.maximo).toBe(100);
    expect(d.pontos).toEqual([
      // y = 12 + 126 * (1 - gasto/100)
      { dia: "2026-09-01", gasto: 0, x: 8, y: 138 },
      { dia: "2026-09-02", gasto: 50, x: 336, y: 75 },
      { dia: "2026-09-03", gasto: 100, x: 664, y: 12 },
      { dia: "2026-09-04", gasto: 25, x: 992, y: 106.5 },
    ]);
  });

  it("fecha a área no piso, e não no primeiro ponto", () => {
    // A área é a mesma linha descendo até o eixo e voltando. Fechar no
    // ponto inicial em vez de no piso desenha um triângulo que sombreia o
    // lado errado da curva — e continua parecendo um gráfico.
    const d = desenhar(QUATRO_DIAS);

    expect(d.linha).toBe("M8,138 L336,75 L664,12 L992,106.5");
    expect(d.area).toBe("M8,138 L336,75 L664,12 L992,106.5 L992,138 L8,138 Z");
  });

  it("dá as três linhas de grade: piso, meio e topo", () => {
    expect(desenhar(QUATRO_DIAS).grade).toEqual([138, 75, 12]);
    expect(desenhar(QUATRO_DIAS).piso).toBe(138);
  });

  it("espaça por data, não por posição na lista", () => {
    // O dado real tem buracos: 26/07, 02/08 e 20/09 não têm NENHUMA linha na
    // view (medido em 23/09/2026 — os três são domingos). Espaçando por
    // índice, esses dias somem do eixo e a distância entre dois pontos deixa
    // de significar tempo: uma semana sem sincronizar viraria um passo igual
    // ao de um dia, sem nada na tela indicando.
    const comBuraco: PontoDia[] = [
      { dia: "2026-09-01", gasto: 0 },
      { dia: "2026-09-02", gasto: 50 },
      // 03/09 não existe
      { dia: "2026-09-04", gasto: 25 },
    ];

    // Por índice o ponto do meio cairia em x=500; por data, em 336.
    expect(desenhar(comBuraco).pontos.map((p) => p.x)).toEqual([8, 336, 992]);
  });

  it("mede o vão em dias de calendário, e não em horas de relógio", () => {
    // Três dias em torno de 01/11/2026, que em Nova York tem 25 horas.
    const virada: PontoDia[] = [
      { dia: "2026-10-31", gasto: 10 },
      { dia: "2026-11-01", gasto: 10 },
      { dia: "2026-11-02", gasto: 10 },
    ];

    // Controle do aparato, no mesmo espírito do de `formato.test.ts`: sem
    // fixar o fuso este caso não exerceria nada. A suíte roda em TZ=UTC e o
    // Brasil não tem mais horário de verão, então a medida ingênua — de
    // meia-noite local a meia-noite local — dá 24h certinhas nos dois, e a
    // conta errada passaria para sempre. Em Nova York ela se denuncia.
    const ingenuo = (fuso: string) =>
      comFuso(fuso, () =>
        (new Date("2026-11-02T00:00:00").getTime() -
          new Date("2026-11-01T00:00:00").getTime()) / 86_400_000);

    expect(ingenuo("UTC")).toBe(1);
    expect(ingenuo("America/Sao_Paulo")).toBe(1);
    expect(ingenuo("America/New_York")).toBeCloseTo(1.0417, 4);

    // E o desenho não se mexe em nenhum dos dois: o ponto do meio fica no
    // meio. Medindo por relógio ele cairia em 489,9 no fuso com virada.
    for (const fuso of ["UTC", "America/New_York"]) {
      expect(comFuso(fuso, () => desenhar(virada).pontos.map((p) => p.x)))
        .toEqual([8, 500, 992]);
    }
  });

  it("não divide por zero quando ninguém gastou nada", () => {
    // Dia com linha e gasto 0 existe no dado real (15/09, dez linhas
    // somando R$ 0,00). Um período inteiro assim é o caso degenerado: sem
    // guarda, `gasto/maximo` é 0/0 e todo o caminho vira "M8,NaN".
    const d = desenhar([
      { dia: "2026-09-01", gasto: 0 },
      { dia: "2026-09-02", gasto: 0 },
    ]);

    expect(d.pontos.map((p) => p.y)).toEqual([138, 138]);
    expect(d.linha).toBe("M8,138 L992,138");
    // E o topo da escala continua valendo zero: a guarda é do divisor, não
    // do número que a tela exibe. Trocar um pelo outro põe "máx R$ 0,01" no
    // cabeçalho de um período em que ninguém gastou um centavo.
    expect(d.maximo).toBe(0);
  });

  it("desenha o dia único como um ponto no meio, e não um caminho vazio", () => {
    // Um só dia não tem intervalo: espaçar por data daria 0/0. E um caminho
    // só com `M` não renderiza nada — o cartão ficaria vazio afirmando que
    // não há gasto, quando há um dia inteiro dele.
    const d = desenhar([{ dia: "2026-09-01", gasto: 700 }]);

    expect(d.pontos).toEqual([{ dia: "2026-09-01", gasto: 700, x: 500, y: 12 }]);
    expect(d.linha).toBe("M500,12 L500,12");
  });

  it("devolve caminho vazio para lista vazia, em vez de quebrar", () => {
    const d = desenhar([]);

    expect(d.pontos).toEqual([]);
    expect(d.linha).toBe("");
    expect(d.area).toBe("");
  });
});

describe("indiceMaisProximo", () => {
  const pontos = desenhar(QUATRO_DIAS).pontos;

  it("escolhe o ponto mais perto do x do mouse", () => {
    // Pontos em 8, 336, 664, 992. O meio entre os dois primeiros é 172.
    expect(indiceMaisProximo(171, pontos)).toBe(0);
    expect(indiceMaisProximo(173, pontos)).toBe(1);
    expect(indiceMaisProximo(664, pontos)).toBe(2);
  });

  it("acha o dia certo por cima de um buraco no eixo", () => {
    // O eixo não tem passo constante — é aí que a conta do plano, dividir
    // pelo passo e arredondar, para de funcionar. Com os pontos em 8, 336 e
    // 992, dividir pelo primeiro passo (328) manda x=900 para o índice 3,
    // que não existe: o componente leria `pontos[3].gasto` de undefined.
    const comBuraco = desenhar([
      { dia: "2026-09-01", gasto: 0 },
      { dia: "2026-09-02", gasto: 50 },
      { dia: "2026-09-04", gasto: 25 },
    ]).pontos;

    expect(indiceMaisProximo(900, comBuraco)).toBe(2);
    expect(indiceMaisProximo(340, comBuraco)).toBe(1);
  });

  it("prende nas pontas em vez de sair da lista", () => {
    // Fora do desenho o mouse ainda está sobre o SVG: sem prender, o índice
    // sai da lista e o componente lê `pontos[-1]`.
    expect(indiceMaisProximo(-500, pontos)).toBe(0);
    expect(indiceMaisProximo(50_000, pontos)).toBe(3);
  });
});

/**
 * Cada `<path>` com o papel que ele desempenha, na ordem em que sai.
 *
 * Casa o caminho com o preenchimento e o traço do MESMO elemento em vez de
 * procurar a string solta no markup: a área começa com a linha inteira, então
 * um `toContain` do caminho da série fica verde mesmo com os dois trocados de
 * path — a série desenhada como mancha e a área como traço. Medido: essa
 * troca passava por todas as asserções desta suíte.
 */
function caminhos(markup: string) {
  const atributo = (tag: string, nome: string) =>
    new RegExp(`${nome}="([^"]*)"`).exec(tag)?.[1] ?? null;
  return [...markup.matchAll(/<path\b[^>]*>/g)].map((m) => ({
    d: atributo(m[0], "d"),
    preenchimento: atributo(m[0], "fill"),
    traco: atributo(m[0], "stroke"),
  }));
}

describe("GraficoGasto", () => {
  it("desenha a série como traço e a área como preenchimento", () => {
    const LINHA = "M8,138 L336,75 L664,12 L992,106.5";
    const markup = renderToStaticMarkup(
      createElement(GraficoGasto, { pontos: QUATRO_DIAS }),
    );

    expect(caminhos(markup)).toEqual([
      { d: `${LINHA} L992,138 L8,138 Z`, preenchimento: "url(#gasto-por-dia-area)", traco: null },
      { d: LINHA, preenchimento: "none", traco: "#3b82f6" },
    ]);
  });

  it("rotula as duas pontas do eixo, na ordem", () => {
    const markup = renderToStaticMarkup(
      createElement(GraficoGasto, { pontos: QUATRO_DIAS }),
    );

    expect(markup.indexOf("01/09")).toBeGreaterThan(-1);
    expect(markup.indexOf("04/09")).toBeGreaterThan(markup.indexOf("01/09"));
  });

  it("diz quanto vale o topo da escala, sem depender do hover", () => {
    // Sem isto o gráfico é um desenho sem unidade: o pico pode ser R$ 1 ou
    // R$ 100.000 e o leitor não tem como saber sem passar o mouse — e num
    // relance ninguém passa o mouse.
    const markup = renderToStaticMarkup(
      createElement(GraficoGasto, { pontos: QUATRO_DIAS }),
    );

    expect(markup).toContain("R$ 1,00");
  });

  it("usa o viewBox que a geometria descreve", () => {
    // Se o viewBox e as MEDIDAS discordarem, todo ponto é desenhado no lugar
    // errado — e a conta do hover, que converte pixel em unidade de viewBox,
    // erra junto, na mesma proporção.
    const markup = renderToStaticMarkup(
      createElement(GraficoGasto, { pontos: QUATRO_DIAS }),
    );

    expect(markup).toContain(`viewBox="0 0 ${MEDIDAS.larg} ${MEDIDAS.alt}"`);
  });

  it("deixa a altura seguir a largura, senão o hover erra o dia", () => {
    // Com altura fixa, o desenho só é escalado até caber na altura: passada
    // a largura de 1000 o navegador para de esticar e CENTRALIZA o quadro,
    // com folga dos dois lados (`preserveAspectRatio` padrão). A conta do
    // hover — fração da largura vezes 1000 — ignora essa folga e erra.
    //
    // Medido no cartão real, viewport de 1440: o pixel do último ponto
    // voltava como 949,7 em vez de 992 — o crosshair 3,8 dias à esquerda do
    // mouse. Num viewport de 1024 o cartão tem 918 de largura, ainda abaixo
    // de 1000, e o erro não aparece: é o tipo de bug que some justamente na
    // janela estreita em que se costuma testar.
    const markup = renderToStaticMarkup(
      createElement(GraficoGasto, { pontos: QUATRO_DIAS }),
    );
    const svg = /<svg[^>]*>/.exec(markup)![0];

    expect(svg).not.toMatch(/height:\s*\d/);
    expect(svg).toMatch(/height:\s*auto/);
  });

  it("avisa que não há gasto, em vez de desenhar um cartão vazio", () => {
    const markup = renderToStaticMarkup(
      createElement(GraficoGasto, { pontos: [] }),
    );

    expect(markup).toContain("Sem gasto no período");
    expect(markup).not.toContain("<svg");
  });
});

/**
 * Orçamento generoso: esta suíte lê a view inteira pela rede (5 páginas de
 * 1000 linhas). Mesmo motivo — e mesmo número — de `pagina.test.ts`.
 */
const TEMPO = 90_000;

describe("o desenho contra o dado real", () => {
  it(
    "cabe no quadro, sobe até o topo no dia de maior gasto e anda no tempo",
    async () => {
      const pontos = await gastoPorDia(90);

      // As asserções abaixo falam de um gráfico com mais de um dia. Dizer a
      // condição em voz alta em vez de supô-la: se a base for zerada, este
      // caso fica vermelho aqui, e não numa asserção de coordenada que
      // pareceria bug de geometria.
      expect(pontos.length).toBeGreaterThan(1);

      const d = desenhar(pontos);
      const maiorGasto = Math.max(...pontos.map((p) => p.gasto));

      // A escala é o maior gasto do período, e nada além dele.
      expect(d.maximo).toBe(maiorGasto);
      // Quem toca o topo é exatamente quem gastou o máximo — nem mais dias,
      // nem outro dia.
      expect(d.pontos.filter((p) => p.y === MEDIDAS.topo).map((p) => p.dia))
        .toEqual(pontos.filter((p) => p.gasto === maiorGasto).map((p) => p.dia));

      // Nenhum ponto sai do quadro, e nenhum é NaN.
      for (const p of d.pontos) {
        expect(p.y).toBeGreaterThanOrEqual(MEDIDAS.topo);
        expect(p.y).toBeLessThanOrEqual(d.piso);
        expect(p.x).toBeGreaterThanOrEqual(MEDIDAS.esq);
        expect(p.x).toBeLessThanOrEqual(MEDIDAS.larg - MEDIDAS.dir);
      }

      // As pontas encostam nas bordas: o desenho usa a largura inteira.
      expect(d.pontos[0].x).toBe(MEDIDAS.esq);
      expect(d.pontos[d.pontos.length - 1].x).toBe(MEDIDAS.larg - MEDIDAS.dir);

      // E o eixo é tempo: o passo entre dois dias vizinhos é proporcional
      // aos dias entre eles, inclusive por cima dos buracos da view.
      //
      // `Date.parse` de `YYYY-MM-DD` é UTC por especificação, e a divisão
      // por 86.4e6 é exata porque não há segundo bissexto em UTC posix —
      // conta independente da que `grafico.ts` faz, de propósito.
      const dia = (iso: string) => Date.parse(iso) / 86_400_000;
      const vao = (d.pontos[d.pontos.length - 1].x - d.pontos[0].x) /
        (dia(pontos[pontos.length - 1].dia) - dia(pontos[0].dia));
      //
      // A folga de 0,02 é o arredondamento de duas casas das duas pontas do
      // passo, e nada além disso: espaçado por índice, o passo por cima de
      // um buraco de dois dias erraria por ~11 unidades, não por 0,02.
      for (let i = 1; i < d.pontos.length; i++) {
        const dias = dia(d.pontos[i].dia) - dia(d.pontos[i - 1].dia);
        expect(dias).toBeGreaterThan(0);
        const passo = d.pontos[i].x - d.pontos[i - 1].x;
        expect(Math.abs(passo - vao * dias)).toBeLessThanOrEqual(0.02);
      }

      // Quantos dias do calendário a view não tem nenhuma linha. Não é
      // asserção sobre o número — é o que diz se a asserção de cima
      // distingue alguma coisa hoje: com zero buracos, eixo por data e eixo
      // por índice coincidem e ela vira tautologia. Medido em 23/09/2026: 3.
      const buracos =
        dia(pontos[pontos.length - 1].dia) - dia(pontos[0].dia) + 1 -
        pontos.length;
      expect(buracos).toBeGreaterThanOrEqual(0);
    },
    TEMPO,
  );
});
