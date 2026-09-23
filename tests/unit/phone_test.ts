import { assertEquals } from "jsr:@std/assert";
import {
  fromJid,
  grafiasPlausiveis,
  toMatchKey,
} from "../../supabase/functions/_shared/phone.ts";

Deno.test("fromJid extrai o numero de um JID simples", () => {
  assertEquals(fromJid("5511987654321@s.whatsapp.net"), "+5511987654321");
});

Deno.test("fromJid descarta o sufixo de dispositivo", () => {
  // Multi-device do WhatsApp adiciona ":12" ao JID
  assertEquals(fromJid("5511987654321:12@s.whatsapp.net"), "+5511987654321");
});

Deno.test("fromJid aceita numero internacional", () => {
  assertEquals(fromJid("351912345678@s.whatsapp.net"), "+351912345678");
});

Deno.test("toMatchKey remove o nono digito de movel brasileiro", () => {
  assertEquals(toMatchKey("+5511987654321"), "551187654321");
});

Deno.test("toMatchKey mantem numero brasileiro legado sem o nono digito", () => {
  assertEquals(toMatchKey("+551187654321"), "551187654321");
});

Deno.test("as duas grafias brasileiras produzem a mesma chave", () => {
  // O caso que motiva existir uma chave separada: o mesmo lead escrito
  // de dois jeitos entre Evolution e Chatwoot precisa casar
  assertEquals(toMatchKey("+5511987654321"), toMatchKey("+551187654321"));
});

Deno.test("toMatchKey preserva numero internacional por inteiro", () => {
  // Cortar digitos de numero estrangeiro criaria colisao entre pessoas
  assertEquals(toMatchKey("+351912345678"), "351912345678");
});

Deno.test("toMatchKey preserva fixo brasileiro", () => {
  assertEquals(toMatchKey("+551133334444"), "551133334444");
});

// ─── Guardas: o que NÃO é telefone ──────────────────────────────
// fromJid inventava numero para qualquer entrada. Cunhar E.164 falso e
// pior que recusar: o numero entra no banco, nao casa com ninguem no
// Chatwoot, e a atribuicao se perde sem erro nenhum.

Deno.test("fromJid recusa JID do tipo @lid", () => {
  // LID e o identificador anonimo do WhatsApp, nao um telefone. O
  // WhatsApp esta migrando conversas para esse endereçamento, entao
  // isto vai chegar em producao.
  assertEquals(fromJid("98965307547698@lid"), null);
});

Deno.test("fromJid recusa JID de grupo", () => {
  assertEquals(fromJid("120363000000000000@g.us"), null);
});

Deno.test("fromJid recusa JID sem digitos", () => {
  assertEquals(fromJid("@s.whatsapp.net"), null);
  assertEquals(fromJid(""), null);
});

Deno.test("fromJid recusa numero curto demais para ser telefone", () => {
  assertEquals(fromJid("123@s.whatsapp.net"), null);
});

Deno.test("toMatchKey so remove o nono digito quando ele e mesmo um 9", () => {
  // Movel brasileiro e 55 + DDD + 9XXXXXXXX. Sem checar o 9, um numero
  // de 13 digitos que nao e movel perderia um digito a toa.
  assertEquals(toMatchKey("+5511987654321"), "551187654321");   // movel: reduz
  assertEquals(toMatchKey("+5511887654321"), "5511887654321");  // nao e 9: mantem
});

// ─── As duas grafias do mesmo celular, para a busca na API ──────
//
// toMatchKey resolve o join no SQL, onde os dois lados ja estao na
// tabela. A busca no Chatwoot e outro problema: ela manda uma string e
// recebe o que casar com ELA. Medido em producao contra a API real: dos
// 35 telefones capturados, 35 existem como contato no Chatwoot e so 5
// foram encontrados — exatamente os 5 em que o Chatwoot por acaso guarda
// a mesma grafia que a Evolution nos deu.

Deno.test("grafiasPlausiveis devolve a original e a variante do nono digito", () => {
  assertEquals(grafiasPlausiveis("+5593991597627"), [
    "+5593991597627",
    "+559391597627",
  ]);
});

Deno.test("grafiasPlausiveis parte da grafia legada e propoe a de nove digitos", () => {
  // O caso real: a Evolution nos deu +559391597627 e o Chatwoot guarda
  // +5593991597627.
  assertEquals(grafiasPlausiveis("+559391597627"), [
    "+559391597627",
    "+5593991597627",
  ]);
});

Deno.test("grafiasPlausiveis preserva a ordem: a original vem primeiro", () => {
  // Quem chama para na primeira que achar, entao a ordem decide quantas
  // requisicoes sao feitas — e qual contato ganha em caso de empate.
  assertEquals(grafiasPlausiveis("+559384051288")[0], "+559384051288");
});

Deno.test("grafiasPlausiveis cobre os prefixos de celular 6, 7, 8 e 9", () => {
  // Celular brasileiro de 8 digitos comeca com 6, 7, 8 ou 9. Os numeros
  // que falharam em producao estao nessas faixas: 84051288 e 99683312.
  for (const local of ["61111111", "71111111", "84051288", "99683312"]) {
    const grafias = grafiasPlausiveis("+5593" + local);
    assertEquals(grafias.length, 2, local);
    assertEquals(grafias[1], "+55939" + local, local);
  }
});

Deno.test("grafiasPlausiveis NAO inventa celular a partir de fixo", () => {
  // Fixo brasileiro comeca com 2, 3, 4 ou 5. Acrescentar o nono digito
  // produziria um numero que nao existe, e a requisicao extra so gastaria
  // rate limit para nunca achar nada.
  for (const local of ["23334444", "33334444", "43334444", "53334444"]) {
    assertEquals(grafiasPlausiveis("+5511" + local), ["+5511" + local], local);
  }
});

Deno.test("grafiasPlausiveis devolve numero estrangeiro intacto", () => {
  // O nono digito e regra brasileira. Mexer em numero de fora inventaria
  // gente que nao existe.
  assertEquals(grafiasPlausiveis("+351912345678"), ["+351912345678"]);
  assertEquals(grafiasPlausiveis("+12125551234"), ["+12125551234"]);
});

Deno.test("grafiasPlausiveis ignora 13 digitos brasileiros que nao sao movel", () => {
  // Mesma guarda do toMatchKey: sem checar o 9 na posicao certa, qualquer
  // numero de 13 digitos comecando com 55 perderia um digito a toa.
  assertEquals(grafiasPlausiveis("+5511887654321"), ["+5511887654321"]);
});

Deno.test("grafiasPlausiveis normaliza a entrada para E.164 com +", () => {
  assertEquals(grafiasPlausiveis("5593991597627")[0], "+5593991597627");
});

Deno.test("todas as grafias plausiveis compartilham a mesma chave de join", () => {
  // A invariante que liga esta funcao ao toMatchKey: se duas grafias
  // produzissem chaves diferentes, a busca acharia um contato que o SQL
  // depois nao conseguiria casar.
  for (const numero of ["+5593991597627", "+559384051288", "+556699683312"]) {
    const chaves = new Set(grafiasPlausiveis(numero).map(toMatchKey));
    assertEquals(chaves.size, 1, numero);
  }
});

Deno.test("grafiasPlausiveis nunca devolve duplicata", () => {
  for (const numero of ["+5593991597627", "+551133334444", "+351912345678"]) {
    const g = grafiasPlausiveis(numero);
    assertEquals(new Set(g).size, g.length, numero);
  }
});
