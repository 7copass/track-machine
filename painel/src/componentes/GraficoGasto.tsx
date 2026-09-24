"use client";

import { useState } from "react";
import type { PontoDia } from "@/lib/consultas";
import { diaCurto, reais } from "@/lib/formato";
import { MEDIDAS, desenhar, indiceMaisProximo } from "@/lib/grafico";

/**
 * Gasto por dia, em SVG inline.
 *
 * As regras que este gráfico segue, e que não são preferência: uma série só
 * e portanto nenhuma legenda — o título nomeia, e caixa de legenda para uma
 * série é ruído; eixo único, nunca dois; linha de 2px sobre grade recessiva,
 * que orienta sem competir; texto em cor de texto, nunca na cor da série; e
 * camada de hover, porque gráfico em SVG é interativo e crosshair não é
 * extra. O azul #3b82f6 foi validado contra a superfície escura — passa na
 * faixa de luminosidade, no piso de croma e no contraste. Trocar exige
 * revalidar.
 *
 * A altura do tooltip é reservada mesmo sem hover: sem isso o gráfico pula
 * quando o mouse entra, e movimento que não significa nada tira a atenção do
 * que significa.
 *
 * A geometria vive em `lib/grafico.ts`, sob teste. Aqui fica só o desenho.
 */

/** O gradiente é referenciado por id, que é global no documento. */
const ID_AREA = "gasto-por-dia-area";

export function GraficoGasto({ pontos }: { pontos: PontoDia[] }) {
  const [ativo, setAtivo] = useState<number | null>(null);

  if (pontos.length === 0) {
    return (
      <div className="cartao" style={{ color: "var(--texto-fraco)" }}>
        Sem gasto no período.
      </div>
    );
  }

  const d = desenhar(pontos);
  const p = ativo === null ? null : d.pontos[ativo];

  return (
    <div className="cartao">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span style={{
          color: "var(--texto-fraco)",
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}>
          Gasto por dia
        </span>
        {/*
          Quanto vale o topo da escala. Sem isto o desenho não tem unidade: o
          pico pode ser R$ 1 ou R$ 100.000 e o leitor só descobre passando o
          mouse — e num relance ninguém passa o mouse.
        */}
        <span className="numero" style={{ color: "var(--texto-fraco)", fontSize: 11 }}>
          máx {reais(d.maximo)}
        </span>
      </div>

      {/* Reserva a altura do tooltip para o gráfico não pular no hover */}
      <div className="numero" style={{ height: 22, fontSize: 14, marginTop: 4 }}>
        {p ? (
          <span>
            <span style={{ color: "var(--texto)" }}>{reais(p.gasto)}</span>
            <span style={{ color: "var(--texto-fraco)", marginLeft: 8 }}>
              {diaCurto(p.dia)}
            </span>
          </span>
        ) : (
          <span style={{ color: "var(--texto-fraco)" }}>
            passe o mouse para ver o dia
          </span>
        )}
      </div>

      {/*
        `height: auto` em vez de altura fixa, e o motivo é a conta do hover.
        Com altura fixa o desenho só é escalado até caber na altura: passada
        a largura de 1000, o navegador para de esticar e centraliza o quadro,
        com folga dos dois lados (`preserveAspectRatio` padrão). A conversão
        abaixo — fração da largura vezes 1000 — ignora essa folga, e o
        crosshair descola do mouse. Medido no cartão real, viewport de 1440:
        o último ponto voltava como 949,7 em vez de 992, 3,8 dias à esquerda
        do mouse. Em viewport de 1024 o cartão ainda não chega a 1000 de
        largura e o erro não aparece — some justamente na janela estreita em
        que se costuma testar. Deixando a altura seguir a proporção, o
        desenho ocupa a largura inteira e a conta é exata em qualquer uma.

        Como aí a escala do desenho varia com a largura do cartão, os traços
        levam `vector-effect: non-scaling-stroke`: sem ele a linha de 2px
        engorda no monitor largo e some no estreito.
      */}
      <svg
        viewBox={`0 0 ${MEDIDAS.larg} ${MEDIDAS.alt}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        onMouseLeave={() => setAtivo(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * MEDIDAS.larg;
          setAtivo(indiceMaisProximo(px, d.pontos));
        }}
      >
        <defs>
          <linearGradient id={ID_AREA} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Grade recessiva: orienta sem competir com a série */}
        {d.grade.map((y) => (
          <line key={y}
            x1={MEDIDAS.esq} x2={MEDIDAS.larg - MEDIDAS.dir}
            y1={y} y2={y}
            stroke="var(--borda)" strokeWidth="1"
            vectorEffect="non-scaling-stroke" />
        ))}

        <path d={d.area} fill={`url(#${ID_AREA})`} />
        <path d={d.linha} fill="none" stroke="#3b82f6" strokeWidth="2"
              strokeLinejoin="round" strokeLinecap="round"
              vectorEffect="non-scaling-stroke" />

        {p && (
          <g>
            <line x1={p.x} x2={p.x} y1={MEDIDAS.topo} y2={d.piso}
                  stroke="var(--texto-fraco)" strokeWidth="1"
                  vectorEffect="non-scaling-stroke" />
            {/* Anel da cor da superfície separa a marca da linha */}
            <circle cx={p.x} cy={p.y} r="4"
                    fill="#3b82f6" stroke="var(--superficie)" strokeWidth="2"
                    vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>

      <div style={{
        display: "flex",
        justifyContent: "space-between",
        color: "var(--texto-fraco)",
        fontSize: 11,
        marginTop: -14,
      }}>
        <span>{diaCurto(d.pontos[0].dia)}</span>
        <span>{diaCurto(d.pontos[d.pontos.length - 1].dia)}</span>
      </div>
    </div>
  );
}
