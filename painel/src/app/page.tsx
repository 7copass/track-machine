import { Cards } from "@/componentes/Cards";
import { AvisoCaptura } from "@/componentes/AvisoCaptura";
import { GraficoGasto } from "@/componentes/GraficoGasto";
import { TabelaCriativos } from "@/componentes/TabelaCriativos";
import { anuncios, criativos, gastoPorDia, resumo } from "@/lib/consultas";

export const dynamic = "force-dynamic";

export default async function Pagina() {
  // As três leituras caem na mesma leitura da view: `linhasDoPeriodo` é
  // `cache()`, e a primeira a chamar registra a promessa que as outras
  // recebem. Em paralelo pelo mesmo motivo — não há uma segunda ida à rede
  // para esperar em fila. (`anuncios` faz uma segunda consulta, a das
  // contas, e é justamente por estar em paralelo que ela não empilha.)
  const [r, pontos, linhas] = await Promise.all([
    resumo(90),
    gastoPorDia(90),
    anuncios(90),
  ]);

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: 32 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 24 }}>
        Track Machine
      </h1>

      <div style={{ display: "grid", gap: 20 }}>
        {/*
          A data sai do próprio dado — antes era a constante "2026-09-18"
          escrita aqui, que continuaria afirmando 18/09 depois de qualquer
          recarga do banco, e discordaria em silêncio da ressalva do card,
          que sempre veio do dado. `null` enquanto não houver lead nenhum:
          sem data não há o que avisar, e um aviso sem data não explica nada.
        */}
        {r.inicioCaptura === null ? null : (
          <AvisoCaptura desde={r.inicioCaptura} />
        )}
        <Cards resumo={r} />
        <GraficoGasto pontos={pontos} />
        <TabelaCriativos linhas={criativos(linhas)} />
      </div>
    </main>
  );
}
