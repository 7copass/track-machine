import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AvisoCaptura } from "@/componentes/AvisoCaptura";
import { Cards } from "@/componentes/Cards";
import { diaCurto, reais } from "@/lib/formato";
import type { Resumo } from "@/lib/consultas";

// O plano diz que só `formato.ts` e `consultas.ts` têm teste, porque são os
// únicos onde um erro produz número errado em silêncio. Os cards são o
// terceiro lugar onde isso acontece: trocar `reais` por `numero` num card
// não quebra nada, não avisa nada, e põe "3.145.921" onde deveria estar
// "R$ 31.459,21" — um número plausível, com a ordem de grandeza errada.
// Aqui não há banco nem fuso: só a ligação entre campo, rótulo e formatador.

/**
 * Os pares (rótulo, valor) que os cards renderizam, na ordem em que saem.
 *
 * Casa o rótulo com o valor do mesmo cartão em vez de só procurar as
 * strings no markup: assim trocar dois cards de lugar fica vermelho, o que
 * um `includes` não pegaria.
 */
function cartoes(markup: string): Array<[string, string]> {
  const padrao =
    /<div class="cartao">.*?<div[^>]*>([^<]*)<\/div>.*?<div class="numero"[^>]*>([^<]*)<\/div>/g;
  return [...markup.matchAll(padrao)].map((m) => [m[1], m[2]]);
}

describe("Cards", () => {
  it("põe cada número no seu card, com o formatador certo", () => {
    // Números escolhidos para que todo erro de ligação mude a string:
    // com `numero` o gasto viraria "3.145.921", com `reais` os anúncios
    // virariam "R$ 8,36", e nenhum dos quatro valores se parece com outro.
    const r: Resumo = {
      gasto: 3145921,
      gastoComCaptura: 3145921,
      inicioCaptura: "2026-06-25",
      leads: 29,
      anuncios: 836,
      cplMedio: 108480,
    };

    expect(cartoes(renderToStaticMarkup(createElement(Cards, { resumo: r })))).toEqual([
      ["Gasto", "R$ 31.459,21"],
      ["Leads", "29"],
      ["Custo por lead", "R$ 1.084,80"],
      ["Anúncios", "836"],
    ]);
  });

  it("mostra 0 leads, e não um traço, quando ninguém chegou", () => {
    // Regra do projeto: "gastou R$ 340 e não trouxe ninguém" é informação,
    // não buraco no dado. O traço fica só para o CPL, que de fato não
    // existe sem lead — e nunca para o zero.
    const r: Resumo = {
      gasto: 34000,
      gastoComCaptura: 34000,
      inicioCaptura: null,
      leads: 0,
      anuncios: 3,
      cplMedio: null,
    };

    expect(cartoes(renderToStaticMarkup(createElement(Cards, { resumo: r })))).toEqual([
      ["Gasto", "R$ 340,00"],
      ["Leads", "0"],
      ["Custo por lead", "—"],
      ["Anúncios", "3"],
    ]);
  });
});

/**
 * O texto secundário de cada cartão, na mesma ordem dos cartões.
 *
 * Cartão sem ressalva não aparece aqui — é assim que se afirma a supressão.
 */
function ressalvas(markup: string): string[] {
  const padrao = /<div class="ressalva"[^>]*>([^<]*)<\/div>/g;
  return [...markup.matchAll(padrao)].map((m) => m[1]);
}

describe("Cards, a ressalva do custo por lead", () => {
  // O gasto tem 90 dias porque veio de um backfill da Meta; lead só existe
  // desde 18/09. O card dividia um pelo outro e mostrava R$ 1.084,80 onde o
  // número é R$ 11,16 — 97x. Medido no banco em 23/09.
  const misturado: Resumo = {
    gasto: 3145921,
    gastoComCaptura: 32386,
    inicioCaptura: "2026-09-18",
    leads: 29,
    anuncios: 836,
    cplMedio: 1116,
  };

  it("mostra o valor da janela de captura, não o do período inteiro", () => {
    const markup = renderToStaticMarkup(
      createElement(Cards, { resumo: misturado }),
    );

    expect(cartoes(markup)).toEqual([
      ["Gasto", "R$ 31.459,21"],
      ["Leads", "29"],
      ["Custo por lead", "R$ 11,16"],
      ["Anúncios", "836"],
    ]);
    // E o card de Gasto continua mostrando o gasto do período: são duas
    // perguntas diferentes, e trocar uma pela outra esconderia 97% do gasto.
    expect(markup).toContain("R$ 31.459,21");
  });

  it("diz o que dividiu, para a conta fechar na tela", () => {
    // Sem isto o card contradiz os de Gasto e Leads ao lado: R$ 31.459,21
    // dividido por 29 não dá R$ 11,16, o operador refaz a conta de cabeça,
    // não fecha, e passa a não confiar em nenhum dos três.
    const markup = renderToStaticMarkup(
      createElement(Cards, { resumo: misturado }),
    );

    expect(ressalvas(markup)).toEqual(["R$ 323,86 ÷ 29 · desde 18/09"]);
  });

  it("a aritmética que aparece fecha com o valor que aparece", () => {
    // O caso acima prende a string inteira e ficaria verde para sempre se
    // alguém a chumbasse. Aqui a ressalva é lida de volta e refeita: o que
    // está escrito tem de produzir o número grande do mesmo cartão.
    const markup = renderToStaticMarkup(
      createElement(Cards, { resumo: misturado }),
    );
    const [nota] = ressalvas(markup);
    const m = /^R\$ ([\d.,]+) ÷ ([\d.]+) · desde (\d{2}\/\d{2})$/.exec(nota);
    expect(m).not.toBeNull();

    const centavos = Math.round(
      Number(m![1].replace(/\./g, "").replace(",", ".")) * 100,
    );
    const leads = Number(m![2].replace(/\./g, ""));
    const cpl = cartoes(markup).find(([r]) => r === "Custo por lead")![1];

    expect(cpl).toBe(reais(Math.floor(centavos / leads)));
    expect(m![3]).toBe(diaCurto(misturado.inicioCaptura!));
  });

  it("cala a ressalva quando a janela já está dentro da captura", () => {
    // Período que começa depois do início da captura: gasto e gasto-com-
    // captura são o mesmo número, a divisão é a óbvia, e a ressalva viraria
    // ruído — uma nota de rodapé explicando que não há nada a explicar.
    const dentro: Resumo = {
      gasto: 20429,
      gastoComCaptura: 20429,
      inicioCaptura: "2026-09-18",
      leads: 25,
      anuncios: 12,
      cplMedio: 817,
    };
    const markup = renderToStaticMarkup(
      createElement(Cards, { resumo: dentro }),
    );

    expect(ressalvas(markup)).toEqual([]);
    expect(cartoes(markup)).toEqual([
      ["Gasto", "R$ 204,29"],
      ["Leads", "25"],
      ["Custo por lead", "R$ 8,17"],
      ["Anúncios", "12"],
    ]);
  });

  it("não inventa ressalva quando a captura nem começou", () => {
    // Sem lead nenhum na base não há data para citar, e uma ressalva sem
    // data não explica nada.
    const semCaptura: Resumo = {
      gasto: 34000,
      gastoComCaptura: 0,
      inicioCaptura: null,
      leads: 0,
      anuncios: 3,
      cplMedio: null,
    };
    const markup = renderToStaticMarkup(
      createElement(Cards, { resumo: semCaptura }),
    );

    expect(ressalvas(markup)).toEqual([]);
    expect(cartoes(markup)[2]).toEqual(["Custo por lead", "—"]);
  });

  it("não escreve '÷ 0' ao lado de um traço", () => {
    // Guarda, não caso de uso: `resumo()` hoje não produz esta forma —
    // `leads: 0` com a captura já iniciada implica que o período inteiro
    // caiu depois dela, e aí os dois gastos são iguais e a supressão da
    // igualdade já bastaria. Quem defende a tela desse "R$ 120,00 ÷ 0" é a
    // guarda do `cplMedio === null`, e sem este caso ela some sem nenhum
    // teste reclamar — até o dia em que a forma passe a existir.
    const inconsistente: Resumo = {
      gasto: 34000,
      gastoComCaptura: 12000,
      inicioCaptura: "2026-09-18",
      leads: 0,
      anuncios: 3,
      cplMedio: null,
    };
    const markup = renderToStaticMarkup(
      createElement(Cards, { resumo: inconsistente }),
    );

    expect(ressalvas(markup)).toEqual([]);
    expect(markup).not.toContain("÷");
    expect(cartoes(markup)[2]).toEqual(["Custo por lead", "—"]);
  });
});

describe("AvisoCaptura", () => {
  it("mostra a data sem deslocar pelo fuso", () => {
    // `new Date("2026-09-18")` é meia-noite UTC: a oeste de Greenwich vira
    // 17/09 às 21h e o aviso passa a apontar o dia anterior ao da captura.
    // O erro é de um dia só, o que é exatamente o tamanho que ninguém nota.
    const markup = renderToStaticMarkup(
      createElement(AvisoCaptura, { desde: "2026-09-18" }),
    );

    expect(markup).toContain("18/09");
    expect(markup).not.toContain("17/09");
  });
});
