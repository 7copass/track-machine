import { assertEquals } from "jsr:@std/assert";
import {
  extrairSegredoDaUrl,
  validarApiKey,
} from "../../supabase/functions/_shared/webhook_auth.ts";

// ─── apikey no corpo: o que o Evolution oferece ─────────────────

Deno.test("aceita a apikey correta", () => {
  assertEquals(validarApiKey("CHAVE-ABC-123", "CHAVE-ABC-123"), true);
});

Deno.test("recusa apikey de outra instancia", () => {
  // Sem isso, o webhook de um cliente grava lead no tenant de outro
  assertEquals(validarApiKey("CHAVE-XYZ-999", "CHAVE-ABC-123"), false);
});

Deno.test("recusa quando o webhook nao manda apikey", () => {
  assertEquals(validarApiKey(null, "CHAVE-ABC-123"), false);
  assertEquals(validarApiKey(undefined, "CHAVE-ABC-123"), false);
  assertEquals(validarApiKey("", "CHAVE-ABC-123"), false);
});

Deno.test("recusa quando a instancia ainda nao tem chave cadastrada", () => {
  // Instancia recem-criada sem chave nao pode aceitar qualquer webhook
  assertEquals(validarApiKey("qualquer-coisa", null), false);
  assertEquals(validarApiKey("qualquer-coisa", ""), false);
});

Deno.test("recusa chave de tamanho diferente", () => {
  assertEquals(validarApiKey("CHAVE-ABC", "CHAVE-ABC-123"), false);
  assertEquals(validarApiKey("CHAVE-ABC-123-EXTRA", "CHAVE-ABC-123"), false);
});

// ─── segredo na URL: o que o Chatwoot permite ───────────────────

Deno.test("extrai o segredo da query string", () => {
  assertEquals(
    extrairSegredoDaUrl("https://x/functions/v1/chatwoot-events?s=abc123"),
    "abc123",
  );
});

Deno.test("devolve null quando nao ha segredo na url", () => {
  assertEquals(extrairSegredoDaUrl("https://x/functions/v1/chatwoot-events"), null);
  assertEquals(extrairSegredoDaUrl("https://x/functions/v1/chatwoot-events?s="), null);
  assertEquals(extrairSegredoDaUrl("https://x/functions/v1/chatwoot-events?outro=1"), null);
});

Deno.test("nao estoura com url malformada", () => {
  assertEquals(extrairSegredoDaUrl("nao-e-url"), null);
  assertEquals(extrairSegredoDaUrl(""), null);
});

Deno.test("ignora parametros extras que o Chatwoot possa acrescentar", () => {
  assertEquals(
    extrairSegredoDaUrl("https://x/hook?event=conversation_created&s=abc&t=1"),
    "abc",
  );
});
