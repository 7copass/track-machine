import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TabelaCriativos } from "@/componentes/TabelaCriativos";
import {
  anuncios,
  criativos,
  type LinhaAnuncio,
  type LinhaCriativo,
} from "@/lib/consultas";

function anuncio(p: Partial<LinhaAnuncio>): LinhaAnuncio {
  return {
    adId: "1", nome: "AD01", campanha: "C", conta: "act_1",
    destino: "WHATSAPP", gasto: 0, leads: 0, cpl: null, ...p,
  };
}

describe("criativos", () => {
  it("soma gasto e leads de anuncios com o mesmo nome", () => {
    const r = criativos([
      anuncio({ adId: "1", nome: "AD03", gasto: 1000, leads: 2 }),
      anuncio({ adId: "2", nome: "AD03", gasto: 500, leads: 1 }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].gasto).toBe(1500);
    expect(r[0].leads).toBe(3);
    expect(r[0].vezes).toBe(2);
  });

  // O erro que este teste existe para pegar: media dos CPLs em vez de CPL
  // do total. Aqui a media daria 45500 (R$ 455,00) e o certo e 9090
  // (R$ 90,90) — um erro de 5x que passaria despercebido, porque os dois
  // numeros sao plausiveis.
  it("recalcula o CPL sobre o total, nao a media dos CPLs", () => {
    const r = criativos([
      anuncio({ adId: "1", nome: "AD03", gasto: 10000, leads: 10 }),
      anuncio({ adId: "2", nome: "AD03", gasto: 90000, leads: 1 }),
    ]);
    expect(r[0].cpl).toBe(Math.floor(100000 / 11));
    expect(r[0].cpl).not.toBe((1000 + 90000) / 2);
  });

  // Anuncio novo aparece nos insights antes do enriquecimento rodar. Se
  // agrupasse por nome nulo, todos os anuncios novos de todas as contas
  // viravam UMA linha somando gastos que nao tem relacao entre si.
  it("nao junta anuncios sem nome numa linha so", () => {
    const r = criativos([
      anuncio({ adId: "1", nome: null, gasto: 100 }),
      anuncio({ adId: "2", nome: null, gasto: 200 }),
    ]);
    expect(r).toHaveLength(2);
    expect(r.map((c) => c.gasto).sort((a, b) => a - b)).toEqual([100, 200]);
  });

  it("mostra a campanha quando e uma so, e a contagem quando sao varias", () => {
    const uma = criativos([
      anuncio({ adId: "1", nome: "AD03", campanha: "VAGA" }),
      anuncio({ adId: "2", nome: "AD03", campanha: "VAGA" }),
    ]);
    expect(uma[0].campanha).toBe("VAGA");
    expect(uma[0].campanhas).toBe(1);

    const varias = criativos([
      anuncio({ adId: "1", nome: "AD03", campanha: "VAGA" }),
      anuncio({ adId: "2", nome: "AD03", campanha: "OUTRA" }),
    ]);
    expect(varias[0].campanha).toBeNull();
    expect(varias[0].campanhas).toBe(2);
  });

  // Se o mesmo criativo rodou numa campanha de mensagem e numa de visita
  // ao perfil, os leads vieram da primeira e sao reais. Esconder o numero
  // atras de um traco apagaria lead que existe.
  it("gera lead se qualquer membro do grupo gera", () => {
    const r = criativos([
      anuncio({ adId: "1", nome: "AD03", destino: "INSTAGRAM_PROFILE" }),
      anuncio({ adId: "2", nome: "AD03", destino: "WHATSAPP", leads: 4 }),
    ]);
    expect(r[0].geraLead).toBe(true);
    expect(r[0].leads).toBe(4);
  });

  it("nao gera lead quando nenhum membro gera", () => {
    const r = criativos([
      anuncio({ adId: "1", nome: "AD03", destino: "INSTAGRAM_PROFILE" }),
      anuncio({ adId: "2", nome: "AD03", destino: "INSTAGRAM_PROFILE" }),
    ]);
    expect(r[0].geraLead).toBe(false);
  });

  it("ordena por gasto, maior primeiro", () => {
    const r = criativos([
      anuncio({ adId: "1", nome: "A", gasto: 10 }),
      anuncio({ adId: "2", nome: "B", gasto: 900 }),
      anuncio({ adId: "3", nome: "C", gasto: 50 }),
    ]);
    expect(r.map((c) => c.nome)).toEqual(["B", "C", "A"]);
  });

  // O tenant real tem duas contas de anuncio, e o MESMO nome existe nas
  // duas — `ad01` da campanha VAGA sao dois anuncios, um em cada conta.
  // Agrupar por nome funde as duas linhas, e sem contar as contas o
  // operador nao tem como saber que a linha atravessa conta.
  it("conta em quantas contas o criativo rodou", () => {
    const r = criativos([
      anuncio({ adId: "1", nome: "ad01", conta: "act_111" }),
      anuncio({ adId: "2", nome: "ad01", conta: "act_222" }),
      anuncio({ adId: "3", nome: "ad01", conta: "act_222" }),
    ]);
    expect(r[0].contas).toBe(2);
    expect(r[0].vezes).toBe(3);
  });
});

/**
 * Cada `<tr>` do markup como a lista das suas celulas, em ordem.
 *
 * Procurar strings soltas no markup — `toContain("R$ 259,85")` — fica verde
 * quando duas colunas trocam de lugar, porque a string continua no
 * documento. Lendo a linha inteira, celula a celula, trocar Gasto com CPL
 * ou Leads com Vezes muda o array e fica vermelho.
 *
 * O cabecalho entra como a primeira linha, pelo mesmo motivo: e ele que
 * amarra cada valor ao rotulo certo.
 */
function linhas(markup: string): string[][] {
  return [...markup.matchAll(/<tr>(.*?)<\/tr>/g)].map((linha) =>
    [...linha[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/g)].map((celula) =>
      celula[1].replace(/<[^>]*>/g, ""),
    ),
  );
}

function criativo(p: Partial<LinhaCriativo>): LinhaCriativo {
  return {
    nome: "AD01", vezes: 1, campanha: "C", campanhas: 1, contas: 1,
    geraLead: true, gasto: 0, leads: 0, cpl: null, ...p,
  };
}

describe("TabelaCriativos", () => {
  it("poe cada numero na sua coluna, com o formatador certo", () => {
    // Numeros escolhidos para que todo erro de ligacao mude a string: com
    // `numero` o gasto viraria "121.682", com `reais` as vezes virariam
    // "R$ 0,13", e nenhum dos valores da linha se parece com outro.
    const markup = renderToStaticMarkup(
      createElement(TabelaCriativos, {
        linhas: [
          criativo({
            nome: "AD01", vezes: 13, campanha: null, campanhas: 8,
            contas: 2, gasto: 121682, leads: 0, cpl: null,
          }),
          criativo({
            nome: "ad01", vezes: 2, campanha: "VAGA", campanhas: 1,
            contas: 2, gasto: 25985, leads: 32, cpl: 812,
          }),
        ],
      }),
    );

    expect(linhas(markup)).toEqual([
      ["Criativo", "Onde rodou", "Vezes", "Gasto", "Leads", "CPL"],
      ["AD01", "8 campanhas · 2 contas", "13", "R$ 1.216,82", "0", "—"],
      ["ad01", "VAGA · 2 contas", "2", "R$ 259,85", "32", "R$ 8,12"],
    ]);
  });

  it("mostra 0 leads onde o criativo podia gerar, e traco onde nao podia", () => {
    // Regra da spec: "gastou R$ 242,75 e nao trouxe ninguem" e informacao
    // de alto valor, nao buraco no dado. O traco fica so para o criativo
    // que rodou apenas em campanha de visita ao perfil, onde lead nao
    // existe — ali o zero mentiria dizendo que a campanha fracassou.
    const markup = renderToStaticMarkup(
      createElement(TabelaCriativos, {
        linhas: [
          criativo({
            nome: "AD03 - IMG - INFOR", vezes: 20, campanha: null,
            campanhas: 2, contas: 2, gasto: 29717, leads: 0, cpl: null,
          }),
          criativo({
            nome: "AD01 GABRIEL MASTER", vezes: 2, campanha: "PERFIL",
            campanhas: 1, contas: 1, geraLead: false, gasto: 24275,
            leads: 0, cpl: null,
          }),
        ],
      }),
    );

    expect(linhas(markup).slice(1)).toEqual([
      ["AD03 - IMG - INFOR", "2 campanhas · 2 contas", "20", "R$ 297,17", "0", "—"],
      ["AD01 GABRIEL MASTER", "PERFIL", "2", "R$ 242,75", "—", "—"],
    ]);
  });

  it("nao inventa rotulo para o anuncio que ainda nao foi enriquecido", () => {
    // Anuncio novo chega nos insights antes do enriquecimento: sem nome,
    // sem campanha, e uma vez so. "1 campanhas" apareceria na coluna de
    // campanha se a contagem fosse usada sem olhar se ha nome a mostrar —
    // um rotulo gramaticalmente errado dizendo menos que um traco.
    const markup = renderToStaticMarkup(
      createElement(TabelaCriativos, {
        linhas: [
          criativo({
            nome: null, vezes: 1, campanha: null, campanhas: 1,
            contas: 1, gasto: 570, leads: 0, cpl: null,
          }),
        ],
      }),
    );

    expect(linhas(markup).slice(1)).toEqual([
      ["sem nome ainda", "—", "—", "R$ 5,70", "0", "—"],
    ]);
  });

  it("apaga o zero de lead e mantem aceso o lead que existe", () => {
    // A spec pede o zero "em cinza": ele e informacao, mas nao e a
    // informacao que o olho deve pescar primeiro numa tabela de 249
    // linhas onde quase toda linha tem zero.
    const markup = renderToStaticMarkup(
      createElement(TabelaCriativos, {
        linhas: [
          criativo({ nome: "SEM", gasto: 29717, leads: 0 }),
          criativo({ nome: "COM", gasto: 25985, leads: 32, cpl: 812 }),
        ],
      }),
    );

    const celulas = [
      ...markup.matchAll(/<td class="numero" style="([^"]*)">([^<]*)<\/td>/g),
    ].map((m) => [m[2], m[1]]);

    const cinza = celulas.find(([v]) => v === "0")![1];
    const aceso = celulas.find(([v]) => v === "32")![1];
    expect(cinza).toContain("var(--texto-fraco)");
    expect(aceso).toContain("var(--texto)");
    expect(aceso).not.toContain("var(--texto-fraco)");
  });

  it("diz quantas linhas a tabela tem", () => {
    // A tabela mostra 249 linhas onde a view tem 836 anuncios. Sem a
    // contagem no cabecalho, o operador nao tem como perceber que esta
    // olhando um agrupamento.
    const markup = renderToStaticMarkup(
      createElement(TabelaCriativos, {
        linhas: [
          criativo({ nome: "A", gasto: 3 }),
          criativo({ nome: "B", gasto: 2 }),
          criativo({ nome: "C", gasto: 1 }),
        ],
      }),
    );

    expect(markup).toContain("3 · por gasto");
  });
});

/**
 * Orçamento por teste, generoso de propósito — mesmo motivo dos outros
 * arquivos que falam com o banco: uma leitura completa da view são 5
 * páginas de 1000 linhas pela rede.
 */
const TEMPO = 90_000;

describe("criativos contra a base real", () => {
  it(
    "agrupa os anuncios do periodo sem perder gasto nem criar rotulo repetido",
    async () => {
      // UMA leitura, e todas as afirmações derivadas dela. Os crons
      // escrevem o tempo todo: reler a view para comparar dois números
      // compararia duas fotos de instantes diferentes, e a diferença
      // apareceria como erro de agregação.
      const ads = await anuncios(90);
      const linhas = criativos(ads);

      expect(ads.length).toBeGreaterThan(0);

      // Agrupar não pode perder nem inventar: todo anúncio entra em
      // exatamente uma linha, e todo centavo continua somado.
      expect(linhas.reduce((s, l) => s + l.vezes, 0)).toBe(ads.length);
      expect(linhas.reduce((s, l) => s + l.gasto, 0)).toBe(
        ads.reduce((s, a) => s + a.gasto, 0),
      );
      expect(linhas.reduce((s, l) => s + l.leads, 0)).toBe(
        ads.reduce((s, a) => s + a.leads, 0),
      );

      // O ponto inteiro de agrupar por nome: nenhum rótulo se repete. Sem
      // isto a tela mostra duas linhas visualmente idênticas e o operador
      // conclui que o painel duplicou. Não afirmo QUANTAS linhas — a base
      // é viva e o número muda — mas afirmo que cada uma é única, que é o
      // que precisa valer sempre.
      const nomes = linhas.map((l) => l.nome).filter((n) => n !== null);
      expect(new Set(nomes).size).toBe(nomes.length);
      expect(linhas.length).toBeLessThanOrEqual(ads.length);

      // Aqui está a prova de que o agrupamento faz trabalho de verdade
      // nesta base: há nome repetido entre os anúncios, e a tabela o
      // reduziu a uma linha só.
      const nomesDosAds = ads.map((a) => a.nome).filter((n) => n !== null);
      expect(new Set(nomesDosAds).size).toBeLessThan(nomesDosAds.length);

      // O CPL de cada linha sai do total da própria linha, sempre.
      for (const l of linhas) {
        expect(l.cpl).toBe(
          l.leads > 0 ? Math.floor(l.gasto / l.leads) : null,
        );
      }
    },
    TEMPO,
  );
});
