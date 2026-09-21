import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente com a chave de serviço.
 *
 * O `import "server-only"` no topo não é decoração: ele faz o build
 * FALHAR se algum componente de cliente importar este arquivo. Sem isso,
 * um `"use client"` acrescentado por descuido levaria a chave de serviço
 * para dentro do bundle do navegador — e ela dá acesso total ao banco,
 * contornando todo o RLS.
 *
 * É a única barreira automática que existe aqui; o resto é disciplina.
 */
export function servidor(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !chave) {
    throw new Error(
      "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes. " +
        "Confira painel/.env.local.",
    );
  }

  return createClient(url, chave, { auth: { persistSession: false } });
}
