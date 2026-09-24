import "server-only";
import { NextResponse } from "next/server";

/**
 * Dispara a sincronização manual da Fatia B1.
 *
 * Esta rota existe para que a chave de serviço não precise sair do
 * servidor: o botão é código de cliente, e chamar a Edge Function direto do
 * navegador exigiria o `Authorization` no bundle. Aqui a chave é lida do
 * ambiente e nunca volta na resposta.
 *
 * A trava de 5 minutos por tenant vive no banco, não aqui: Edge Function não
 * guarda estado entre invocações. Quando ela recusa, a resposta traz
 * `pulado: "trava"` e quantos segundos faltam — e a tela mostra isso em vez
 * de fingir que atualizou.
 */
export async function POST() {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !chave) {
    return NextResponse.json(
      { erro: "Credenciais ausentes em painel/.env.local" },
      { status: 500 },
    );
  }

  let resposta: Response;
  try {
    resposta = await fetch(`${url}/functions/v1/sync-meta-insights`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${chave}`,
      },
      body: JSON.stringify({ tipo: "manual" }),
    });
  } catch (e) {
    // Rede fora, DNS, função dormindo. Sem isto o erro sobe como exceção da
    // rota, o Next devolve HTML, e o botão só consegue dizer "falhou".
    const motivo = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { erro: `nao consegui chamar a sincronizacao: ${motivo}` },
      { status: 502 },
    );
  }

  // Nem todo desfecho é JSON: `verify_jwt` recusando devolve texto, e
  // `Method Not Allowed` também. `resposta.json()` estouraria neles, e o
  // corpo que chegaria ao botão seria uma página de erro do Next — que ele
  // não tem como distinguir de "nada aconteceu".
  const bruto = await resposta.text();
  try {
    return NextResponse.json(JSON.parse(bruto), { status: resposta.status });
  } catch {
    return NextResponse.json(
      { erro: `resposta ilegivel (${resposta.status}): ${bruto.slice(0, 200)}` },
      { status: resposta.status >= 400 ? resposta.status : 502 },
    );
  }
}
