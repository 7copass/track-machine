import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Cliente com service_role: contorna RLS por ser código confiável. */
export function admin(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}
