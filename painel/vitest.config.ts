import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` e so um marcador: o index.js dele nao faz nada alem
      // de lancar. Quem o neutraliza e o bundler, que resolve a condicao
      // `react-server` para o empty.js do proprio pacote. O Vitest nao
      // monta grafo de Server Component, cai no index.js, e o import
      // explode antes do primeiro teste — arrastando junto qualquer
      // modulo que alcance `supabase.ts`.
      //
      // Apontar para o empty.js do proprio pacote vale so aqui dentro e
      // nao enfraquece nada: a barreira e de build, e quem a prova e o
      // Passo 6b da Tarefa 1, que cria um componente de cliente
      // importando a chave e confirma que o `next build` recusa.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
});
