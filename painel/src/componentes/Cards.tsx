import type { Resumo } from "@/lib/consultas";
import { diaCurto, numero, reais } from "@/lib/formato";

function Cartao({
  rotulo,
  valor,
  ressalva,
}: {
  rotulo: string;
  valor: string;
  ressalva?: string;
}) {
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
      {ressalva === undefined ? null : (
        <div className="ressalva" style={{
          color: "var(--texto-fraco)",
          fontSize: 11,
          marginTop: 6,
        }}>
          {ressalva}
        </div>
      )}
    </div>
  );
}

/**
 * Por que o card de custo por lead mostra a própria conta.
 *
 * Os quatro cards ficam lado a lado, e três deles se relacionam: gasto,
 * leads, e o custo por lead que deveria ser um dividido pelo outro. Só que
 * não é — o numerador do CPL é o gasto da janela em que já havia captura, e
 * o card de Gasto mostra o gasto do período inteiro. Medido em 23/09:
 * R$ 31.459,21, 29 leads, e R$ 11,16 de CPL.
 *
 * Sem dizer o que dividiu, o card contradiz os dois vizinhos: o operador
 * refaz a conta de cabeça, não fecha, e passa a desconfiar dos três. A
 * ressalva é o que devolve a coerência — `R$ 323,86 ÷ 29 · desde 18/09`
 * fecha, e explica de onde saiu o número menor.
 *
 * Quando o período pedido já começa depois do início da captura, os dois
 * gastos são o mesmo e a divisão é a óbvia: aí a ressalva vira uma nota de
 * rodapé avisando que não há nada a explicar, e some.
 */
function contaDoCpl(r: Resumo): string | undefined {
  if (r.cplMedio === null || r.inicioCaptura === null) return undefined;
  if (r.gastoComCaptura === r.gasto) return undefined;
  return `${reais(r.gastoComCaptura)} ÷ ${numero(r.leads)} · desde ${diaCurto(
    r.inicioCaptura,
  )}`;
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
      <Cartao
        rotulo="Custo por lead"
        valor={reais(resumo.cplMedio)}
        ressalva={contaDoCpl(resumo)}
      />
      <Cartao rotulo="Anúncios" valor={numero(resumo.anuncios)} />
    </div>
  );
}
