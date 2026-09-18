import { admin } from "../_shared/db.ts";
import { normalizarCriadaEm } from "../_shared/chatwoot.ts";
import { toMatchKey } from "../_shared/phone.ts";
import { extrairSegredoDaUrl } from "../_shared/webhook_auth.ts";

/**
 * Webhook do Chatwoot: grava a conversa e tenta fechar o vínculo na hora.
 *
 * Esta é a segunda das três redes sobrepostas. A captura já tentou ligar
 * quando o lead chegou pelo Evolution, e o `pg_cron` varre o que escapar —
 * então nada aqui pode bloquear nem depender de o outro lado ter chegado
 * primeiro. Gravar a conversa é o que importa; a reconciliação é
 * consequência, e se falhar o cron recupera em até um minuto.
 *
 * AUTENTICAÇÃO: o Chatwoot não assina o corpo e não permite cabeçalho
 * customizado, então o único canal disponível é a query string da URL:
 *
 *   .../functions/v1/chatwoot-events?s=<webhook_secret do tenant>
 *
 * O segredo **identifica o tenant** — não é conferido contra um tenant que
 * o corpo indicou. Isso importa: se a busca fosse por `account_id` do corpo
 * e o segredo só validasse depois, um atacante descobriria quais contas
 * existem pela diferença entre 404 e 401. Aqui o corpo não escolhe nada.
 *
 * O `account_id` do corpo ainda é conferido contra o do tenant. Ele não
 * acrescenta segurança sozinho; serve para pegar erro de configuração —
 * URL de um cliente colada no Chatwoot de outro — que de outro modo
 * gravaria conversa no tenant errado em silêncio.
 *
 * É mais fraco que HMAC, porque URL aparece em log de acesso e de proxy.
 * Por isso o segredo é por tenant: um vazamento fica contido a um cliente.
 */
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Autenticacao antes de qualquer logica: sem isto, uma requisicao sem
  // segredo e sem telefone recebia 200 e revelava que o endpoint processa.
  const segredo = extrairSegredoDaUrl(req.url);
  if (!segredo) {
    return new Response("Unauthorized", { status: 401 });
  }

  const db = admin();

  // O segredo e quem resolve o tenant. Buscar por ele, e nao pelo
  // account_id do corpo, impede que a resposta revele quais contas existem.
  const { data: cfg } = await db
    .from("chatwoot_configs")
    .select("tenant_id, account_id")
    .eq("webhook_secret", segredo)
    .single();

  if (!cfg) {
    console.warn("Webhook do Chatwoot com segredo desconhecido");
    return new Response("Unauthorized", { status: 401 });
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

  // Conferencia de configuracao, nao de seguranca: pega URL de um cliente
  // colada no Chatwoot de outro, que gravaria conversa no tenant errado
  // sem nenhum sintoma visivel.
  if (Number(cfg.account_id) !== Number(contaId)) {
    console.error(
      `Segredo do tenant ${cfg.tenant_id} chegou com account_id ${contaId}, ` +
      `mas o cadastrado e ${cfg.account_id}. URL trocada entre clientes?`,
    );
    return new Response("Conta nao confere com o segredo", { status: 403 });
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
