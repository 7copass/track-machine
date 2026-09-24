import { AvisoCaptura } from "@/componentes/AvisoCaptura";
import { BotaoAtualizar } from "@/componentes/BotaoAtualizar";
import { Cards } from "@/componentes/Cards";
import { GraficoGasto } from "@/componentes/GraficoGasto";
import { SeletorPeriodo } from "@/componentes/SeletorPeriodo";
import { TabelaCriativos } from "@/componentes/TabelaCriativos";
import {
  anuncios,
  criativos,
  gastoPorDia,
  resumo,
  ultimaAtualizacao,
} from "@/lib/consultas";
import { periodoPedido } from "@/lib/periodo";

export const dynamic = "force-dynamic";

export default async function Pagina(
  { searchParams }: {
    searchParams: Promise<{ [chave: string]: string | string[] | undefined }>;
  },
) {
  const { dias: bruto } = await searchParams;
  // A validação mora em `lib/periodo.ts`, junto da lista que o seletor
  // desenha: as duas têm de concordar, e separadas um dia discordam.
  const dias = periodoPedido(bruto);

  // As três leituras caem na mesma leitura da view: `linhasDoPeriodo` é
  // `cache()`, e a primeira a chamar registra a promessa que as outras
  // recebem. Em paralelo pelo mesmo motivo — não há uma segunda ida à rede
  // para esperar em fila. (`anuncios` faz uma segunda consulta, a das
  // contas, e é justamente por estar em paralelo que ela não empilha.)
  //
  // As três recebem o MESMO `dias`. Passar o período a duas delas e deixar a
  // terceira chumbada em 90 produz uma tela coerente à primeira vista, com o
  // seletor marcando 7d e um dos blocos mostrando outra janela.
  const [r, pontos, linhas, em] = await Promise.all([
    resumo(dias),
    gastoPorDia(dias),
    anuncios(dias),
    ultimaAtualizacao(),
  ]);

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: 32 }}>
      <header style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 24,
        gap: 16,
        flexWrap: "wrap",
      }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
          Track Machine
        </h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <SeletorPeriodo atual={dias} />
          <BotaoAtualizar em={em} />
        </div>
      </header>

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
