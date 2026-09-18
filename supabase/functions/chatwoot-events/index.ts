import { admin } from "../_shared/db.ts";
import { normalizarCriadaEm } from "../_shared/chatwoot.ts";
import { toMatchKey } from "../_shared/phone.ts";

/**
 * Webhook do Chatwoot: grava a conversa e tenta fechar o vínculo na hora.
 *
 * Esta é a segunda das três redes sobrepostas. A captura já tentou ligar
 * quando o lead chegou pelo Evolution, e o `pg_cron` varre o que escapar —
 * então nada aqui pode bloquear nem depender de o outro lado ter chegado
 * primeiro. Gravar a conversa é o que importa; a reconciliação é
 * consequência, e se falhar o cron recupera em até um minuto.
 *
 * NOTA DE SEGURANÇA, deliberadamente não resolvida aqui: o Chatwoot não
 * assina o corpo do webhook e a interface dele não permite cabeçalho
 * customizado, então não há o equivalente ao `body.apikey` que autentica o
 * Evolution. Enquanto isso não for decidido, esta função só é segura com o
 * `verify_jwt` padrão da plataforma ligado — que é o estado atual, porque
 * `supabase/config.toml` não tem bloco `[functions]`. Ela também ainda não
 * está no fluxo de deploy. Sem isso, quem descobrir a URL injeta conversa
 * em qualquer tenant chutando `account_id`, que é um inteiro pequeno.
 */
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const evento = await req.json().catch(() => null);
  if (!evento) return new Response("Bad Request", { status: 400 });

  if (evento.event !== "conversation_created") {
    return Response.json({ ok: true, ignorado: evento.event });
  }

  const contato = evento?.meta?.sender ?? evento?.contact;
  const telefone: string | undefined = contato?.phone_number;
  const contaId = evento?.account?.id ?? evento?.account_id;

  // Conversa sem telefone não tem como casar com touchpoint nenhum: o join
  // é por telefone. Sair em silêncio aqui é correto — acontece com canal de
  // web widget, que não é o caminho do Click-to-WhatsApp.
  if (!telefone || !contaId) {
    return Response.json({ ok: true, semTelefone: true });
  }

  const db = admin();

  const { data: cfg, error: erroCfg } = await db
    .from("chatwoot_configs")
    .select("tenant_id")
    .eq("account_id", contaId)
    .single();

  if (!cfg) {
    // Conta que ninguém cadastrou manda evento a cada conversa, e o
    // sintoma — nenhum lead reconciliado para aquele cliente — é igual ao
    // de "o Evolution parou". Vale distinguir os dois no log.
    console.error(
      `Evento do Chatwoot para account_id ${contaId} sem tenant cadastrado`,
      erroCfg,
    );
    return new Response("Conta desconhecida", { status: 404 });
  }

  // onConflict explícito porque a chave é composta: id de conversa do
  // Chatwoot é sequencial por conta, e cada tenant é uma conta.
  const { error: erroUpsert } = await db
    .from("chatwoot_conversations")
    .upsert({
      id: evento.id,
      tenant_id: cfg.tenant_id,
      contact_id: contato?.id ?? null,
      phone_e164: telefone,
      phone_match_key: toMatchKey(telefone),
      criada_em: normalizarCriadaEm(evento.created_at),
    }, { onConflict: "tenant_id,id" });

  if (erroUpsert) {
    // Sem a conversa gravada não há o que reconciliar — nem agora, nem
    // pelo cron. Este é o único erro daqui que perde lead de verdade, e
    // por isso ele sobe como 500 em vez de responder "ok".
    console.error("Falha ao gravar conversa do Chatwoot", erroUpsert);
    return new Response("Erro ao gravar", { status: 500 });
  }

  // Tenta reconciliar na hora; se não pegar, o cron de 1 minuto pega. O
  // erro é registrado no padrão de `ultimaFalha`: RPC que falha a cada
  // conversa e ninguém vê é pane silenciosa — a reconciliação continuaria
  // acontecendo pelo cron, mascarando o problema até alguém reparar no
  // atraso.
  const { error: erroRpc } = await db.rpc("reconciliar_orfaos", {
    janela_min: 15,
  });
  if (erroRpc) {
    console.error("Reconciliacao imediata falhou; o cron recupera", erroRpc);
  }

  return Response.json({ ok: true, reconciliado_na_hora: !erroRpc });
});
