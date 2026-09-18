import { assertEquals } from "jsr:@std/assert";
import { fromJid, toMatchKey } from "../../supabase/functions/_shared/phone.ts";

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
