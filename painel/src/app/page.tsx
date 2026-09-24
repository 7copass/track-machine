import { Cards } from "@/componentes/Cards";
import { AvisoCaptura } from "@/componentes/AvisoCaptura";
import { resumo } from "@/lib/consultas";

export const dynamic = "force-dynamic";

export default async function Pagina() {
  const r = await resumo(90);

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
        <AvisoCaptura desde="2026-09-18" />
        <Cards resumo={r} />
      </div>
    </main>
  );
}
