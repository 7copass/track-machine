import { describe, expect, it } from "vitest";
import { diaCurto, horaCurta, numero, reais } from "@/lib/formato";

describe("reais", () => {
  it("converte centavos inteiros em moeda brasileira", () => {
    expect(reais(1864)).toBe("R$ 18,64");
    expect(reais(3169987)).toBe("R$ 31.699,87");
    expect(reais(0)).toBe("R$ 0,00");
  });

  it("aceita string, que e como o PostgREST devolve bigint", () => {
    // bigint vira string no JSON para nao perder precisao. Tratar como
    // numero sem converter daria NaN na tela.
    expect(reais("3169987")).toBe("R$ 31.699,87");
  });

  it("nao arredonda centavo para cima", () => {
    // 466 centavos sao R$ 4,66 — nunca R$ 4,67. Dinheiro que muda na
    // exibicao e o tipo de erro que o cliente encontra antes de nos.
    expect(reais(466)).toBe("R$ 4,66");
    expect(reais(1)).toBe("R$ 0,01");
    expect(reais(99)).toBe("R$ 0,99");
  });

  it("devolve traco para valor ausente", () => {
    expect(reais(null)).toBe("—");
  });
});

describe("numero", () => {
  it("agrupa milhar no padrao brasileiro", () => {
    expect(numero(839)).toBe("839");
    expect(numero(64759)).toBe("64.759");
  });

  it("aceita string e ausente", () => {
    expect(numero("4148")).toBe("4.148");
    expect(numero(null)).toBe("—");
  });
});

describe("diaCurto", () => {
  it("formata a data sem deslocar pelo fuso", () => {
    // `dia` e uma coluna date, sem hora. `new Date("2026-09-18")` em
    // ambiente a oeste de Greenwich vira 17/09 as 21h — e a tela mostraria
    // o dia errado, exatamente o erro que a view existe para evitar.
    expect(diaCurto("2026-09-18")).toBe("18/09");
    expect(diaCurto("2026-01-01")).toBe("01/01");
  });
});

describe("horaCurta", () => {
  it("mostra so a hora do carimbo de atualizacao", () => {
    expect(horaCurta("2026-09-21T17:18:07.953Z")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("devolve traco quando nunca sincronizou", () => {
    expect(horaCurta(null)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// Acrescentados a Tarefa 2.
//
// Os testes acima sao os do plano. Os de baixo cobrem tres buracos que eles
// deixam: o caso em que o plano passaria por acidente (fuso), o caso que a
// regra do projeto exige e ninguem afirma (zero nao e traco), e os ramos
// defensivos da implementacao que nenhum teste toca.
// ---------------------------------------------------------------------------

/** Roda `corpo` como se a maquina estivesse em `fuso`, e devolve o fuso. */
function comFuso<T>(fuso: string, corpo: () => T): T {
  const anterior = process.env.TZ;
  process.env.TZ = fuso;
  try {
    return corpo();
  } finally {
    if (anterior === undefined) delete process.env.TZ;
    else process.env.TZ = anterior;
  }
}

describe("controle do aparato de fuso", () => {
  it("trocar TZ realmente muda o dia que o Date enxerga", () => {
    // Sem este controle, os testes de fuso abaixo passariam mesmo que
    // `process.env.TZ` nao surtisse efeito nenhum — provariam apenas que a
    // maquina que roda o teste esta num fuso conveniente, e ficariam verdes
    // para sempre sem nunca ter exercido nada.
    //
    // Aqui se afirma o contrario: com a implementacao ingenua (passar a
    // string pelo `Date`), estes dois fusos DISCORDAM sobre que dia e. E o
    // erro que `diaCurto` tem de impedir, e ele existe de verdade.
    const ingenuo = (fuso: string) =>
      comFuso(fuso, () => new Date("2026-09-18").getDate());

    expect(ingenuo("Pacific/Kiritimati")).toBe(18); // UTC+14
    expect(ingenuo("Etc/GMT+12")).toBe(17); // UTC-12, um dia atras
  });
});

describe("diaCurto, em qualquer fuso", () => {
  // Deslocamentos diferentes e dos dois lados de Greenwich. Dois fusos com o
  // mesmo deslocamento provariam metade: o bug so aparece de um dos lados.
  const FUSOS = [
    "UTC",
    "Etc/GMT+12", // UTC-12, o extremo oeste
    "America/Sao_Paulo", // UTC-3, onde o painel roda
    "Asia/Tokyo", // UTC+9
    "Pacific/Kiritimati", // UTC+14, o extremo leste
  ];

  it("devolve o mesmo dia em todos eles", () => {
    for (const fuso of FUSOS) {
      expect(comFuso(fuso, () => diaCurto("2026-09-18"))).toBe("18/09");
      // Viradas de mes e de ano, onde o deslocamento de um dia muda tambem o
      // mes: a oeste, 01/01 vira 31/12 — e do ano anterior.
      expect(comFuso(fuso, () => diaCurto("2026-01-01"))).toBe("01/01");
      expect(comFuso(fuso, () => diaCurto("2026-12-31"))).toBe("31/12");
    }
  });

  it("aceita carimbo completo, nao so a data seca", () => {
    // `String(l.dia).slice(0,10)` ja corta na consulta, mas se um dia chegar
    // inteiro o fim do dia UTC nao pode virar o dia seguinte no extremo leste.
    expect(diaCurto("2026-09-18T23:30:00.000Z")).toBe("18/09");
    expect(
      comFuso("Pacific/Kiritimati", () =>
        diaCurto("2026-09-18T23:30:00.000Z"),
      ),
    ).toBe("18/09");
  });
});

describe("horaCurta, com o fuso fixado", () => {
  it("mostra a hora local do carimbo, e nao outra hora qualquer", () => {
    // O teste do plano so exige o formato `\d{2}:\d{2}`. Uma implementacao
    // que devolvesse a hora de agora, ou os minutos e segundos no lugar da
    // hora e dos minutos, passaria por ele. Aqui se afirma o valor.
    const carimbo = "2026-09-21T17:18:07.953Z";
    expect(comFuso("UTC", () => horaCurta(carimbo))).toBe("17:18");
    expect(comFuso("America/Sao_Paulo", () => horaCurta(carimbo))).toBe("14:18");
    expect(comFuso("Asia/Tokyo", () => horaCurta(carimbo))).toBe("02:18");
  });

  it("devolve traco para carimbo invalido, sem quebrar a tela", () => {
    // Ramo que a implementacao tem e o plano nao exercita: `new Date` de lixo
    // nao lanca, devolve Invalid Date — e `toLocaleTimeString` nele produz
    // "Invalid Date" no meio da frase "atualizado as".
    expect(horaCurta("nao e data")).toBe("—");
    expect(horaCurta("")).toBe("—");
  });
});

describe("zero nao e ausencia", () => {
  it("numero(0) e '0', nunca um traco", () => {
    // Regra do projeto: anuncio sem lead mostra `0 leads`, nunca um traco.
    // "Gastou R$ 340 e nao trouxe ninguem" e informacao; traco leria como
    // "nao se aplica". Uma guarda escrita como `if (!v) return "—"` inverte
    // essa regra em silencio, e nenhum teste do plano percebe.
    expect(numero(0)).toBe("0");
    expect(numero("0")).toBe("0");
    expect(reais(0)).toBe("R$ 0,00");
  });
});

describe("entrada que nao e numero", () => {
  it("vira traco em vez de NaN na tela", () => {
    // Os `Number.isFinite` da implementacao ficariam com cobertura zero: sem
    // isto, da para apaga-los e os testes continuam verdes — ate o dia em que
    // a tela mostra "R$ NaN".
    expect(reais("sem numero")).toBe("—");
    expect(reais(Number.NaN)).toBe("—");
    expect(reais(Number.POSITIVE_INFINITY)).toBe("—");
    expect(numero("sem numero")).toBe("—");
    expect(numero(Number.NaN)).toBe("—");

    // `undefined` nao esta no tipo, mas chega quando uma coluna some do
    // `select` — e o `?? null` de quem chama nao roda porque o campo nem
    // existe. A implementacao trata; aqui se afirma que trata.
    expect(reais(undefined as unknown as null)).toBe("—");
    expect(numero(undefined as unknown as null)).toBe("—");
  });
});

describe("o espaco de 'R$ '", () => {
  it("e espaco comum, nao o inquebravel do Intl", () => {
    // O `Intl` do Node emite U+00A0 entre "R$" e o numero. Invisivel no
    // terminal, invisivel no diff, e faz `toBe("R$ 18,64")` falhar com duas
    // strings que parecem identicas na tela. Se um dia a normalizacao cair,
    // o erro aparece aqui com nome, e nao como um mistério em quem usar.
    expect(reais(1864)).not.toContain(" ");
    expect(reais(1864).split("")[2]).toBe(" ");
  });
});
