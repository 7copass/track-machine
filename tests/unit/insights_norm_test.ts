import { assertEquals } from "jsr:@std/assert";
import {
  acoesParaObjeto,
  normalizarLinha,
  paraCentavos,
} from "../../supabase/functions/_shared/insights_norm.ts";

// ─── Dinheiro: nunca float ──────────────────────────────────────

Deno.test("converte decimal em string para centavos", () => {
  // A Meta devolve gasto como string decimal: "1234.56"
  assertEquals(paraCentavos("1234.56"), 123456);
  assertEquals(paraCentavos("0.01"), 1);
  assertEquals(paraCentavos("340"), 34000);
});

Deno.test("nao perde centavo por erro de ponto flutuante", () => {
  // 0.1 + 0.2 nao da 0.3 em float. Multiplicar por 100 e arredondar
  // parece seguro mas erra: 19.99 * 100 vira 1998.9999999999998.
  assertEquals(paraCentavos("19.99"), 1999);
  assertEquals(paraCentavos("0.29"), 29);
  assertEquals(paraCentavos("8.20"), 820);
});

Deno.test("aceita numero alem de string", () => {
  assertEquals(paraCentavos(1234.56), 123456);
});

Deno.test("devolve zero para ausente ou invalido", () => {
  assertEquals(paraCentavos(null), 0);
  assertEquals(paraCentavos(undefined), 0);
  assertEquals(paraCentavos(""), 0);
  assertEquals(paraCentavos("nao e numero"), 0);
});

// ─── Ações: array aninhado vira objeto achatado ─────────────────

Deno.test("achata o array de actions em objeto", () => {
  const raw = [
    { action_type: "link_click", value: "340" },
    {
      action_type: "onsite_conversion.messaging_conversation_started_7d",
      value: "12",
    },
  ];
  assertEquals(acoesParaObjeto(raw), {
    link_click: 340,
    "onsite_conversion.messaging_conversation_started_7d": 12,
  });
});

Deno.test("devolve objeto vazio quando nao ha actions", () => {
  assertEquals(acoesParaObjeto(undefined), {});
  assertEquals(acoesParaObjeto([]), {});
  assertEquals(acoesParaObjeto("nao e array"), {});
});

Deno.test("ignora entrada malformada sem descartar as boas", () => {
  const raw = [
    { action_type: "link_click", value: "340" },
    { sem_tipo: true },
    { action_type: "video_view", value: "nao numero" },
  ];
  assertEquals(acoesParaObjeto(raw), { link_click: 340 });
});

// ─── Linha completa ─────────────────────────────────────────────

Deno.test("normaliza uma linha de insight da Meta", () => {
  const bruto = {
    ad_id: "120247603194380108",
    date_start: "2026-09-18",
    date_stop: "2026-09-18",
    spend: "340.00",
    impressions: "12000",
    reach: "8400",
    clicks: "512",
    inline_link_clicks: "340",
    actions: [{ action_type: "link_click", value: "340" }],
  };
  assertEquals(normalizarLinha(bruto), {
    ad_id: "120247603194380108",
    dia: "2026-09-18",
    gasto_centavos: 34000,
    impressoes: 12000,
    alcance: 8400,
    cliques: 512,
    cliques_link: 340,
    acoes: { link_click: 340 },
  });
});

Deno.test("devolve null sem ad_id ou sem data", () => {
  // Sem os dois nao ha chave primaria possivel. Devolver null em vez de
  // gravar linha incompleta evita lixo que so aparece na consulta.
  assertEquals(normalizarLinha({ spend: "10" }), null);
  assertEquals(normalizarLinha({ ad_id: "1" }), null);
  assertEquals(normalizarLinha({ date_start: "2026-09-18" }), null);
});

Deno.test("preenche com zero o que a Meta omite", () => {
  // Anuncio sem clique nenhum vem sem o campo, nao com zero.
  const r = normalizarLinha({
    ad_id: "1",
    date_start: "2026-09-18",
    spend: "10.00",
  });
  assertEquals(r!.cliques, 0);
  assertEquals(r!.alcance, 0);
  assertEquals(r!.acoes, {});
});

// ─── Acrescentados fora do plano ────────────────────────────────

Deno.test("preserva o sinal de gasto negativo", () => {
  // A Meta devolve gasto negativo em dia de estorno ou credito aplicado.
  // O plano escreveu o tratamento de sinal e nao testou nenhum ramo dele:
  // trocar `Math.abs(parseInt(inteira)) * sinal` pelo ingenuo
  // `parseInt(inteira) * 100 + centavos` passa nos dez testes do plano e
  // devolve +50 para "-0.50", porque parseInt("-0") e -0 e -0 * 100 e 0.
  assertEquals(paraCentavos("-0.50"), -50);
  assertEquals(paraCentavos("-19.99"), -1999);
});

Deno.test("arredonda o terceiro decimal em vez de truncar", () => {
  // Campo de custo da Marketing API (cpc, cpm, cost_per_action_type) vem
  // com mais de duas casas: "0.008928", "1.005". Cortar a terceira casa
  // perde ate um centavo por linha, sempre para baixo — que e exatamente
  // o erro que esta funcao existe para impedir, so que por outra porta.
  assertEquals(paraCentavos("0.999"), 100);
  assertEquals(paraCentavos("1.005"), 101);
  assertEquals(paraCentavos("0.004"), 0);
  assertEquals(paraCentavos("-19.996"), -2000);
});
