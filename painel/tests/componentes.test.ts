import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AvisoCaptura } from "@/componentes/AvisoCaptura";
import { Cards } from "@/componentes/Cards";
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
    const r: Resumo = { gasto: 34000, leads: 0, anuncios: 3, cplMedio: null };

    expect(cartoes(renderToStaticMarkup(createElement(Cards, { resumo: r })))).toEqual([
      ["Gasto", "R$ 340,00"],
      ["Leads", "0"],
      ["Custo por lead", "—"],
      ["Anúncios", "3"],
    ]);
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
