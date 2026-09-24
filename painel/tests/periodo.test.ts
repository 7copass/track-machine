import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinhaAnuncio, PontoDia, Resumo } from "@/lib/consultas";

// O período é o único parâmetro que a tela aceita, e o critério da spec é
// que trocá-lo mude **os três blocos juntos** — cards, gráfico e tabela.
//
// O modo de falhar que isto existe para pegar não é o período chegar
// errado: é chegar em dois dos três. Passar `dias` para `resumo` e deixar
// `gastoPorDia(90)` chumbado produz uma tela coerente à primeira vista, com
// o seletor marcando 7d, os cards de 7 dias e um gráfico de 90 — e ninguém
// percebe olhando, porque o gráfico não tem eixo de data legendado dia a
// dia.
//
// Por isso cada período recebe aqui um dado com impressão digital própria, e
// cada caso afirma as três marcas do período pedido E a ausência das marcas
// dos outros dois. Só afirmar a presença ficaria verde com qualquer bloco
// chumbado em 90.

vi.mock("@/lib/consultas", async (original) => ({
  ...(await original<typeof import("@/lib/consultas")>()),
  resumo: vi.fn(),
  gastoPorDia: vi.fn(),
  anuncios: vi.fn(),
  ultimaAtualizacao: vi.fn(),
}));

const { default: Pagina } = await import("@/app/page");
const { anuncios, gastoPorDia, resumo, ultimaAtualizacao } = await import(
  "@/lib/consultas"
);

const PERIODOS = [7, 30, 90] as const;
type Periodo = (typeof PERIODOS)[number];

/**
 * Um dado distinto por período.
 *
 * Os números vêm da base real (medidos em 24/09/2026), mas aqui são
 * ditados: o que o caso prova é o caminho do parâmetro, não o valor. Contra
 * o banco de verdade quem confere é `pagina.test.ts`.
 */
const DADO: Record<Periodo, {
  resumo: Resumo;
  pontos: PontoDia[];
  ads: LinhaAnuncio[];
}> = {
  7: {
    resumo: {
      gasto: 53595, gastoComCaptura: 33895, leads: 32,
      anuncios: 40, cplMedio: 1059, inicioCaptura: "2026-09-18",
    },
    pontos: [
      { dia: "2026-09-17", gasto: 19700 },
      { dia: "2026-09-23", gasto: 5072 },
    ],
    ads: [{
      adId: "a7", nome: "CRIATIVO-DE-7D", campanha: "VAGA", conta: "act_1",
      destino: "WHATSAPP", gasto: 53595, leads: 32, cpl: 1674,
    }],
  },
  30: {
    resumo: {
      gasto: 1631110, gastoComCaptura: 33895, leads: 32,
      anuncios: 300, cplMedio: 1059, inicioCaptura: "2026-09-18",
    },
    pontos: [
      { dia: "2026-08-25", gasto: 41234 },
      { dia: "2026-09-23", gasto: 5072 },
    ],
    ads: [{
      adId: "a30", nome: "CRIATIVO-DE-30D", campanha: "VAGA", conta: "act_1",
      destino: "WHATSAPP", gasto: 1631110, leads: 32, cpl: 50972,
    }],
  },
  90: {
    resumo: {
      gasto: 3130567, gastoComCaptura: 33895, leads: 32,
      anuncios: 836, cplMedio: 1059, inicioCaptura: "2026-09-18",
    },
    pontos: [
      { dia: "2026-06-26", gasto: 77777 },
      { dia: "2026-09-23", gasto: 5072 },
    ],
    ads: [{
      adId: "a90", nome: "CRIATIVO-DE-90D", campanha: "VAGA", conta: "act_1",
      destino: "WHATSAPP", gasto: 3130567, leads: 32, cpl: 97830,
    }],
  },
};

/**
 * As três marcas de um período, uma por bloco da tela.
 *
 * Uma marca só não bastaria: é justamente a divergência ENTRE os blocos que
 * o caso persegue.
 */
const MARCAS: Record<Periodo, string[]> = {
  7: ["R$ 535,95", "17/09", "CRIATIVO-DE-7D"],
  30: ["R$ 16.311,10", "25/08", "CRIATIVO-DE-30D"],
  90: ["R$ 31.305,67", "26/06", "CRIATIVO-DE-90D"],
};

function ehPeriodo(d: number): d is Periodo {
  return (PERIODOS as readonly number[]).includes(d);
}

/**
 * O dado do período pedido — e uma explosão para qualquer outro.
 *
 * Devolver um dado vazio faria a página renderizar sem reclamar, e o caso
 * acusaria "marca ausente" sem dizer que o período pedido foi 42.
 */
function dado(dias: number) {
  if (!ehPeriodo(dias)) throw new Error(`Periodo inesperado: ${dias}`);
  return DADO[dias];
}

/** O que cada consulta recebeu, na ordem em que a página as declara. */
function pedidos(): number[] {
  return [resumo, gastoPorDia, anuncios].map((f) => {
    const chamadas = vi.mocked(f).mock.calls;
    expect(chamadas).toHaveLength(1);
    return chamadas[0][0];
  });
}

/** Cada opção do seletor: para onde aponta, o que escreve e se está marcada. */
function opcoes(markup: string): Array<{
  href: string;
  rotulo: string;
  marcada: boolean;
}> {
  return [...markup.matchAll(/<a([^>]*)>([^<]*)<\/a>/g)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1])?.[1] ?? "",
    rotulo: m[2],
    marcada: /aria-current="page"/.test(m[1]),
  }));
}

/** O período que o seletor mostra como atual, lido do markup. */
function periodoMarcado(markup: string): number {
  const marcadas = opcoes(markup).filter((o) => o.marcada);
  expect(marcadas).toHaveLength(1);
  return Number(/dias=(\d+)/.exec(marcadas[0].href)?.[1]);
}

async function tela(dias?: string | string[]): Promise<string> {
  const busca = dias === undefined ? {} : { dias };
  return renderToStaticMarkup(
    await Pagina({ searchParams: Promise.resolve(busca) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resumo).mockImplementation(async (d) => dado(d).resumo);
  vi.mocked(gastoPorDia).mockImplementation(async (d) => dado(d).pontos);
  vi.mocked(anuncios).mockImplementation(async (d) => dado(d).ads);
  vi.mocked(ultimaAtualizacao).mockResolvedValue("2026-09-24T01:18:07.953Z");
});

describe("o periodo chega aos tres blocos", () => {
  it.each(PERIODOS)("com ?dias=%i, os tres blocos sao desse periodo", async (p) => {
    const markup = await tela(String(p));

    for (const marca of MARCAS[p]) expect(markup).toContain(marca);

    // E nenhuma marca dos outros dois. É esta metade que fica vermelha
    // quando um bloco continua chumbado em 90.
    for (const outro of PERIODOS.filter((o) => o !== p)) {
      for (const marca of MARCAS[outro]) expect(markup).not.toContain(marca);
    }
  });

  it.each(PERIODOS)("as tres consultas recebem o mesmo %i", async (p) => {
    await tela(String(p));
    expect(pedidos()).toEqual([p, p, p]);
  });

  it.each(PERIODOS)("o seletor marca o periodo que foi consultado (%i)", async (p) => {
    // O par: o que o seletor afirma e o que as consultas receberam. Separados,
    // os dois podem discordar — seletor em 7d sobre uma tela de 90 dias —, e
    // é a discordância que faz o operador ler o número errado achando que
    // trocou de período.
    const markup = await tela(String(p));
    expect(pedidos()).toEqual([periodoMarcado(markup), periodoMarcado(markup), p]);
  });
});

describe("periodo que nao existe", () => {
  // Qualquer outro valor cairia em 90 em silêncio, com o seletor mostrando
  // um período diferente do exibido.
  const RUINS: Array<[string, string | string[] | undefined]> = [
    ["ausente", undefined],
    ["vazio", ""],
    ["fora da lista", "999"],
    ["nao numerico", "abc"],
    ["zero", "0"],
    ["negativo", "-7"],
    ["fracionario", "7.5"],
    // `?dias=7&dias=30` chega como lista. `Number(["7"])` vale 7 por coerção
    // de array, então tratar lista como string deixaria a URL repetida
    // decidir o período por acidente.
    ["repetido", ["7", "30"]],
    ["lista de um", ["7"]],
  ];

  it.each(RUINS)("%s cai em 90, e o seletor concorda", async (_nome, bruto) => {
    const markup = await tela(bruto);

    expect(pedidos()).toEqual([90, 90, 90]);
    expect(periodoMarcado(markup)).toBe(90);
  });
});

describe("o seletor", () => {
  it("oferece 7, 30 e 90, cada rotulo com o seu link", async () => {
    // Casa href e rótulo no mesmo objeto: trocar dois de lugar fica
    // vermelho, o que uma busca por "7d" no markup não pegaria — os três
    // rótulos estão sempre lá.
    expect(await tela("30").then(opcoes)).toEqual([
      { href: "/?dias=7", rotulo: "7d", marcada: false },
      { href: "/?dias=30", rotulo: "30d", marcada: true },
      { href: "/?dias=90", rotulo: "90d", marcada: false },
    ]);
  });
});
