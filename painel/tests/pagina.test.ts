import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Pagina from "@/app/page";
import { resumo } from "@/lib/consultas";
import { diaCurto, numero, reais } from "@/lib/formato";

// A tela montada por inteiro, contra o banco de verdade.
//
// Os testes de `componentes.test.ts` provam que cada peça sabe desenhar o que
// recebe; nenhum deles olha para o que a página entrega às peças. A data da
// captura estava chumbada em `page.tsx` — `desde="2026-09-18"` — e o painel
// continuaria afirmando 18/09 depois de qualquer recarga do banco, com todos
// os testes de componente verdes.

/**
 * Orçamento por teste, generoso de propósito.
 *
 * Esta suíte fala com o banco de produção pela rede: uma leitura completa
 * da view são 5 páginas de 1000 linhas, medidas em ~1,4s cada, e há caso
 * que faz duas leituras concorrentes. Com 30s o caso de `gastoPorDia` vs
 * `resumo` ficava em ~25s — passava quase sempre e falhava quando a rede
 * respirava, que é o pior dos mundos: vermelho intermitente ensina a
 * ignorar vermelho.
 *
 * Em produção o custo é outro: o `cache()` do React deduplica dentro do
 * mesmo request, então a página faz UMA leitura. Aqui cada teste chama as
 * funções isoladamente, de fora de um request, e nada deduplica.
 */
const TEMPO = 90_000;

/** O markup da página, renderizado uma vez por caso. */
async function tela(): Promise<string> {
  // `Pagina` é async: devolve a árvore já resolvida, e o que sobra dentro
  // dela é síncrono. Por isso `renderToStaticMarkup` dá conta.
  return renderToStaticMarkup(await Pagina());
}

describe("a pagina inteira", () => {
  it(
    "tira a data da captura do dado, e nao de uma constante",
    async () => {
      const [markup, r] = await Promise.all([tela(), resumo(90)]);

      expect(r.inicioCaptura).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(markup).toContain(diaCurto(r.inicioCaptura!));
    },
    TEMPO,
  );

  it(
    "o aviso e a ressalva do card nunca apontam datas diferentes",
    async () => {
      // As duas falam da mesma data por motivos diferentes — o aviso explica
      // a tabela, a ressalva explica a divisão. Se saírem de fontes
      // diferentes, um dia discordam, e a tela passa a se contradizer sobre
      // quando a captura começou. Só uma delas pode estar certa, e o
      // operador não tem como saber qual.
      const markup = await tela();

      const noAviso = /<strong[^>]*>\s*(\d{2}\/\d{2})<\/strong>/.exec(markup);
      const naRessalva = /<div class="ressalva"[^>]*>[^<]*desde (\d{2}\/\d{2})<\/div>/
        .exec(markup);

      expect(noAviso).not.toBeNull();
      expect(naRessalva).not.toBeNull();
      expect(naRessalva![1]).toBe(noAviso![1]);
    },
    TEMPO,
  );

  it(
    "o custo por lead na tela e o da janela de captura",
    async () => {
      const [markup, r] = await Promise.all([tela(), resumo(90)]);

      // O número que o operador lê, conferido contra o número que a consulta
      // devolve — e contra o número que o card mostrava antes do conserto.
      expect(markup).toContain(reais(r.cplMedio));
      expect(reais(r.cplMedio)).not.toBe(reais(Math.floor(r.gasto / r.leads)));

      // A conta da ressalva, lida da tela e refeita.
      const nota = /<div class="ressalva"[^>]*>([^<]*)<\/div>/.exec(markup);
      expect(nota).not.toBeNull();
      expect(nota![1]).toBe(
        `${reais(r.gastoComCaptura)} ÷ ${numero(r.leads)} · desde ${diaCurto(
          r.inicioCaptura!,
        )}`,
      );
    },
    TEMPO,
  );
});
