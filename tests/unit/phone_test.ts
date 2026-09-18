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
