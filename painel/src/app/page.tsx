import { servidor } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function Pagina() {
  const db = servidor();
  const { data, error } = await db
    .from("desempenho_por_anuncio")
    .select("gasto_centavos")
    .limit(1000);

  if (error) {
    return <pre style={{ padding: 32 }}>Erro: {error.message}</pre>;
  }

  const total = (data ?? []).reduce((s, l) => s + Number(l.gasto_centavos), 0);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Track Machine</h1>
      <p>{data?.length} linhas · R$ {(total / 100).toFixed(2)}</p>
    </main>
  );
}
