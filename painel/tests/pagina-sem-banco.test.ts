import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PontoDia, Resumo } from "@/lib/consultas";

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
vi.mock("@/lib/consultas", () => ({
  resumo: vi.fn(),
  gastoPorDia: vi.fn(),
}));

const { default: Pagina } = await import("@/app/page");
const { gastoPorDia, resumo } = await import("@/lib/consultas");

const PONTOS: PontoDia[] = [
  { dia: "2026-07-02", gasto: 12345 },
  { dia: "2026-07-03", gasto: 6789 },
];

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
});
