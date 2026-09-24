import type { CSSProperties } from "react";
import type { LinhaCriativo } from "@/lib/consultas";
import { numero, reais } from "@/lib/formato";

const th: CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  color: "var(--texto-fraco)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontWeight: 500,
  borderBottom: "1px solid var(--borda)",
};

const td: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--borda)",
};

/**
 * Onde o criativo rodou, em uma frase curta.
 *
 * A campanha só aparece quando é uma só — com várias, o nome de uma delas
 * seria uma meia-verdade escolhida por sorteio, e a contagem diz mais.
 *
 * A conta entra quando são duas: o tenant tem duas contas de anúncio e o
 * MESMO nome existe nas duas (`ad01` da campanha `VAGA` são dois anúncios,
 * um em cada conta). Agrupar por nome funde as duas, e sem isto a linha não
 * conta que atravessou conta.
 *
 * O `—` cobre o anúncio que chegou nos insights antes do enriquecimento:
 * sem nome e sem campanha. Usar a contagem sem olhar se há campanha a
 * mostrar escreveria "1 campanhas" ali — errado no português e dizendo
 * menos que um traço.
 */
function ondeRodou(l: LinhaCriativo): string {
  const onde =
    l.campanhas === 1 ? l.campanha ?? "—" : `${numero(l.campanhas)} campanhas`;
  return l.contas > 1 ? `${onde} · ${numero(l.contas)} contas` : onde;
}

export function TabelaCriativos({ linhas }: { linhas: LinhaCriativo[] }) {
  return (
    <div className="cartao" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px 8px" }}>
        <span style={{
          color: "var(--texto-fraco)",
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}>
          Criativos
        </span>
        <span style={{ color: "var(--texto-fraco)", fontSize: 11, marginLeft: 8 }}>
          {numero(linhas.length)} · por gasto
        </span>
      </div>

      {/* A tabela rola dentro do proprio cartao: sem isso a pagina inteira
          rola na horizontal em tela estreita. */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={th}>Criativo</th>
              <th style={th}>Onde rodou</th>
              <th style={{ ...th, textAlign: "right" }}>Vezes</th>
              <th style={{ ...th, textAlign: "right" }}>Gasto</th>
              <th style={{ ...th, textAlign: "right" }}>Leads</th>
              <th style={{ ...th, textAlign: "right" }}>CPL</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={`${l.nome ?? ""}|${l.gasto}|${l.vezes}`}>
                <td style={td}>
                  {l.nome ?? (
                    <span style={{ color: "var(--texto-fraco)" }}>sem nome ainda</span>
                  )}
                </td>
                <td style={{ ...td, color: "var(--texto-secundario)" }}>
                  {ondeRodou(l)}
                </td>
                {/* Sem esta coluna, somar 20 anuncios numa linha so seria
                    invisivel — o operador veria um gasto alto e nao saberia
                    de onde veio. */}
                <td className="numero" style={{
                  ...td,
                  textAlign: "right",
                  color: l.vezes > 1 ? "var(--texto-secundario)" : "var(--texto-fraco)",
                }}>
                  {l.vezes > 1 ? numero(l.vezes) : "—"}
                </td>
                <td className="numero" style={{ ...td, textAlign: "right" }}>
                  {reais(l.gasto)}
                </td>
                <td className="numero" style={{
                  ...td,
                  textAlign: "right",
                  // Zero lead fica cinza, mas continua sendo um zero.
                  // "Gastou e nao trouxe ninguem" e a informacao que o
                  // operador mais precisa ver; traco leria "nao se aplica".
                  color: l.leads > 0 ? "var(--texto)" : "var(--texto-fraco)",
                }}>
                  {l.geraLead ? numero(l.leads) : "—"}
                </td>
                <td className="numero" style={{
                  ...td,
                  textAlign: "right",
                  color: l.cpl !== null ? "var(--texto)" : "var(--texto-fraco)",
                }}>
                  {l.cpl !== null ? reais(l.cpl) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
