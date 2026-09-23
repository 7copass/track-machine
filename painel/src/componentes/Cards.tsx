import type { Resumo } from "@/lib/consultas";
import { numero, reais } from "@/lib/formato";

function Cartao({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="cartao">
      <div style={{
        color: "var(--texto-fraco)",
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}>
        {rotulo}
      </div>
      <div className="numero" style={{ fontSize: 28, fontWeight: 600, marginTop: 8 }}>
        {valor}
      </div>
    </div>
  );
}

export function Cards({ resumo }: { resumo: Resumo }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
      gap: 16,
    }}>
      <Cartao rotulo="Gasto" valor={reais(resumo.gasto)} />
      <Cartao rotulo="Leads" valor={numero(resumo.leads)} />
      <Cartao rotulo="Custo por lead" valor={reais(resumo.cplMedio)} />
      <Cartao rotulo="Anúncios" valor={numero(resumo.anuncios)} />
    </div>
  );
}
