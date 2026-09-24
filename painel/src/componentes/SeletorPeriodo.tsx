import Link from "next/link";
import { PERIODOS } from "@/lib/periodo";

/**
 * Troca a janela de dias que a tela inteira mostra.
 *
 * Link e não botão: o período é o estado da página, e estado de página mora
 * na URL. Assim a tela de 7 dias é um endereço — compartilhável, recarre-
 * gável, e com o botão voltar funcionando de graça.
 *
 * `aria-current="page"` é o que diz qual está ativo para quem não enxerga a
 * cor de fundo. É também o que os testes leem, porque marcar por cor
 * obrigaria o teste a conhecer o valor do azul — e aí trocar o tema
 * quebraria o teste em vez do contraste.
 */
export function SeletorPeriodo({ atual }: { atual: number }) {
  return (
    <div style={{
      display: "inline-flex",
      background: "var(--superficie)",
      border: "1px solid var(--borda)",
      borderRadius: "var(--raio)",
      padding: 3,
      gap: 3,
    }}>
      {PERIODOS.map((d) => {
        const ativo = d === atual;
        return (
          <Link
            key={d}
            href={`/?dias=${d}`}
            aria-current={ativo ? "page" : undefined}
            style={{
              padding: "5px 12px",
              borderRadius: 8,
              fontSize: 12,
              textDecoration: "none",
              background: ativo ? "var(--azul)" : "transparent",
              color: ativo ? "#fff" : "var(--texto-secundario)",
            }}
          >
            {d}d
          </Link>
        );
      })}
    </div>
  );
}
