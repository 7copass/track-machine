import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Track Machine",
  description: "Quanto foi gasto, em quais anúncios, e quanto custou cada lead.",
};

/**
 * O `lang` não é formalidade: a tela é toda em português, e com `en` o
 * leitor de tela pronuncia "Anúncios" e "R$ 31.459,21" com as regras do
 * inglês.
 *
 * As fontes Geist que o scaffold carregava saíram junto: `globals.css`
 * define a fonte do `body` na pilha do sistema, então as duas variáveis
 * `--font-geist-*` não eram lidas por ninguém — só custavam duas famílias
 * baixadas do Google a cada build.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
