"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { horaCurta } from "@/lib/formato";
import { lerSincronizacao } from "@/lib/sincronizacao";

/**
 * Dispara a sincronização manual e conta o que aconteceu.
 *
 * O botão chama a Meta e escreve no banco, então o que ele mostra depois não
 * é decoração: a trava de 5 minutos por tenant existe para não estourar a
 * cota da API, e uma recusa dela precisa aparecer na tela. Esconder o motivo
 * faria o operador clicar de novo achando que quebrou — e, pior, tomar o
 * silêncio por sucesso e decidir verba sobre um número velho.
 *
 * A leitura da resposta mora em `lib/sincronizacao.ts`, sob teste. Aqui fica
 * só o estado da interação.
 */
export function BotaoAtualizar({ em }: { em: string | null }) {
  const router = useRouter();
  const [rodando, setRodando] = useState(false);
  const [recado, setRecado] = useState<string | null>(null);

  async function atualizar() {
    setRodando(true);
    setRecado(null);
    try {
      const r = await fetch("/atualizar", { method: "POST" });
      // A rota devolve JSON em todo desfecho, inclusive nos de erro — mas um
      // 500 do próprio Next (página HTML) chegaria aqui como corpo ilegível,
      // e `r.json()` estouraria. O `catch` abaixo cobre, e `null` seria lido
      // como sucesso de zero linha se `lerSincronizacao` não recusasse
      // corpo que não é objeto.
      const recebido: unknown = await r.json();
      const { texto, atualizou } = lerSincronizacao(r.status, recebido);

      setRecado(texto);
      // Só recarrega quando algo foi escrito: um `refresh()` depois de uma
      // recusa apagaria o recado na volta do servidor, e a recusa some da
      // tela antes de ser lida.
      if (atualizou) router.refresh();
    } catch {
      setRecado("falhou");
    } finally {
      setRodando(false);
    }
  }

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span style={{ color: "var(--texto-fraco)", fontSize: 12 }}>
        {recado ?? `atualizado ${horaCurta(em)}`}
      </span>
      <button
        onClick={atualizar}
        disabled={rodando}
        style={{
          background: "var(--superficie)",
          border: "1px solid var(--borda)",
          borderRadius: "var(--raio)",
          color: rodando ? "var(--texto-fraco)" : "var(--texto)",
          padding: "6px 14px",
          fontSize: 12,
          cursor: rodando ? "default" : "pointer",
        }}
      >
        {rodando ? "atualizando…" : "↻ atualizar"}
      </button>
    </div>
  );
}
