import { diaCurto } from "@/lib/formato";

/**
 * Explica por que quase nenhum anúncio tem custo por lead.
 *
 * O gasto tem 90 dias de histórico porque veio da Meta; lead só existe a
 * partir do dia em que a captura entrou no ar, e a Meta não guarda quem
 * mandou mensagem antes disso.
 *
 * Sem este aviso, o operador vê centenas de linhas sem CPL e a primeira
 * hipótese é que o cruzamento quebrou — quando o dado é que está
 * começando.
 */
export function AvisoCaptura({ desde }: { desde: string }) {
  return (
    <div style={{
      background: "var(--superficie-alta)",
      border: "1px solid var(--borda)",
      borderLeft: "3px solid var(--azul)",
      borderRadius: "var(--raio)",
      padding: "12px 16px",
      color: "var(--texto-secundario)",
      fontSize: 13,
    }}>
      Captura de leads ativa desde <strong style={{ color: "var(--texto)" }}>
      {diaCurto(desde)}</strong>. O gasto tem histórico maior porque vem da
      Meta — custo por lead só existe a partir dessa data.
    </div>
  );
}
