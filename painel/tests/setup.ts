// Os testes de consulta falam com o banco de verdade, então precisam das
// mesmas variáveis que o servidor usa. O Next carrega `.env.local`
// sozinho; o Vitest não.
import { config } from "dotenv";
import { vi } from "vitest";

config({ path: ".env.local" });

/**
 * O roteador que o Next monta em volta da página, e que `renderToStaticMarkup`
 * não monta.
 *
 * `useRouter()` de `next/navigation` lê um contexto que só existe dentro do
 * runtime do Next — fora dele levanta "invariant expected app router to be
 * mounted" e derruba a renderização inteira, inclusive a dos blocos que não
 * têm nada a ver com navegação.
 *
 * O dublê é do ARREDOR, não do que está sob teste: o que o botão decide a
 * partir da resposta da sincronização vive em `lib/sincronizacao.ts` e é
 * exercitado direto, sem passar por aqui. O que este dublê permite é apenas
 * que a página inteira renderize num teste.
 */
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
}));
