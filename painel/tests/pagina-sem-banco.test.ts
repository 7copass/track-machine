import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LinhaAnuncio, PontoDia, Resumo } from "@/lib/consultas";

// A página com o dado ditado, e não o do banco.
//
// `pagina.test.ts` já a renderiza contra o banco de verdade, e tem um caso
// chamado "tira a data da captura do dado, e nao de uma constante". Só que
// ele afirma `markup.toContain(diaCurto(r.inicioCaptura))` — e a constante
// escrita no `page.tsx` era "2026-09-18", que é exatamente o que o banco
// devolve hoje. O caso passava verde com a constante intacta, e continuaria
// passando até o dia em que a primeira captura mudasse de data: um teste que
// só falharia depois de uma recarga do banco que ninguém planeja fazer.
//
// Aqui o `inicioCaptura` é ditado como um dia que a constante não tem. Sem
// banco, sem rede, e sem depender de que dia o banco está.
// Só as três leituras do banco viram dublê. `criativos` fica a de verdade:
// é função pura, e substituí-la por um `vi.fn()` faria a página desenhar o
// que o dublê mandasse — inclusive uma tabela coerente com um agrupamento
// que não existe.
vi.mock("@/lib/consultas", async (original) => ({
  ...(await original<typeof import("@/lib/consultas")>()),
  resumo: vi.fn(),
  gastoPorDia: vi.fn(),
  anuncios: vi.fn(),
}));

const { default: Pagina } = await import("@/app/page");
const { anuncios, gastoPorDia, resumo } = await import("@/lib/consultas");

const PONTOS: PontoDia[] = [
  { dia: "2026-07-02", gasto: 12345 },
  { dia: "2026-07-03", gasto: 6789 },
];

// Dois anúncios com o mesmo nome e um terceiro sozinho: é o formato em que
// a base real chega (836 anúncios, 249 nomes), no menor tamanho que ainda
// mostra o agrupamento acontecendo.
const ADS: LinhaAnuncio[] = [
  {
    adId: "1", nome: "AD01", campanha: "VAGA", conta: "act_1",
    destino: "WHATSAPP", gasto: 10000, leads: 3, cpl: 3333,
  },
  {
    adId: "2", nome: "AD01", campanha: "OUTRA", conta: "act_2",
    destino: "WHATSAPP", gasto: 20000, leads: 0, cpl: null,
  },
  {
    adId: "3", nome: "AD02", campanha: "VAGA", conta: "act_1",
    destino: "INSTAGRAM_PROFILE", gasto: 5000, leads: 0, cpl: null,
  },
];

/** Cada `<tr>` do markup como a lista das suas células, em ordem. */
function linhasDaTabela(markup: string): string[][] {
  return [...markup.matchAll(/<tr>(.*?)<\/tr>/g)].map((linha) =>
    [...linha[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/g)].map((celula) =>
      celula[1].replace(/<[^>]*>/g, ""),
    ),
  );
}

function comInicio(inicioCaptura: string | null): Resumo {
  return {
    gasto: 19134,
    gastoComCaptura: inicioCaptura === null ? 0 : 6789,
    leads: inicioCaptura === null ? 0 : 3,
    anuncios: 2,
    cplMedio: inicioCaptura === null ? null : 2263,
    inicioCaptura,
  };
}

async function tela(inicioCaptura: string | null): Promise<string> {
  vi.mocked(resumo).mockResolvedValue(comInicio(inicioCaptura));
  vi.mocked(gastoPorDia).mockResolvedValue(PONTOS);
  vi.mocked(anuncios).mockResolvedValue(ADS);
  return renderToStaticMarkup(await Pagina());
}

describe("a pagina, com o dado ditado", () => {
  it("põe no aviso a data que o dado traz, e não uma escrita no código", async () => {
    const markup = await tela("2026-07-02");

    expect(markup).toContain("02/07");
    // A constante que estava no lugar. Se ela reaparecer, este caso reclama
    // mesmo que o banco venha a concordar com ela por coincidência.
    expect(markup).not.toContain("18/09");
  });

  it("cala o aviso quando não há lead nenhum, em vez de avisar sem data", async () => {
    // Sem data não há o que avisar, e `diaCurto(null)` não é uma frase.
    const markup = await tela(null);

    expect(markup).not.toContain("Captura de leads ativa desde");
    // E o resto da tela continua de pé.
    expect(markup).toContain("R$ 191,34");
  });

  it("agrupa os anúncios antes de desenhar a tabela", async () => {
    // A tabela é o único lugar da tela que mostra os anúncios um a um, e é
    // aqui que se prova que a página não os mostra um a um: os dois `AD01`
    // saem numa linha só, com `2` em Vezes. Sem este caso, tirar o
    // `criativos(...)` do `page.tsx` não teria teste vermelho nenhum — os
    // de `criativos.test.ts` chamam a função direto.
    const markup = await tela("2026-07-02");

    expect(linhasDaTabela(markup)).toEqual([
      ["Criativo", "Onde rodou", "Vezes", "Gasto", "Leads", "CPL"],
      ["AD01", "2 campanhas · 2 contas", "2", "R$ 300,00", "3", "R$ 100,00"],
      ["AD02", "VAGA", "—", "R$ 50,00", "—", "—"],
    ]);
  });
});
