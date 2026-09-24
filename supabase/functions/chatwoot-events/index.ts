import { admin } from "../_shared/db.ts";
import {
  contatoDoEvento,
  decidirGravacao,
  motivoDeNaoConferir,
  motivoDeNaoGravar,
  normalizarCriadaEm,
} from "../_shared/chatwoot.ts";
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
 * CONFERÊNCIA DE CONFIGURAÇÃO: o que o corpo trouxer de `account_id` e de
 * `inbox_id` é conferido contra o cadastro do tenant. Não acrescenta
 * segurança nenhuma sozinho; serve para pegar erro de configuração — URL
 * de um cliente colada no Chatwoot de outro — que de outro modo gravaria
 * conversa no tenant errado em silêncio.
 *
 * E ela nunca impede gravar por ausência. Até 23/09 impedia, e isso zerou
 * a reconciliação: o webhook de `conversation_created` não manda
 * `account_id` (nenhuma das 29 chaves de topo é essa), a guarda era
 * `!telefone || !contaId`, e os 42 webhooks por dia respondiam 200 e
 * gravavam zero linhas. Conferência que não pôde ser feita é registrada,
 * não é reprovação — quem reprova é divergência, com 403.
 *
 * O `inbox_id` é a conferência que o `account_id` deveria ter sido: ele
 * está no payload do webhook. Só vale quando `chatwoot_configs.inbox_id`
 * estiver preenchido, que hoje não está.
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
    .select("tenant_id, account_id, inbox_id")
    .eq("webhook_secret", segredo)
    .single();

  if (!cfg) {
    console.warn("Webhook do Chatwoot com segredo desconhecido");
    return new Response("Unauthorized", { status: 401 });
  }

  const evento = await req.json().catch(() => null);
  if (!evento) return new Response("Bad Request", { status: 400 });

  // A decisao mora no modulo compartilhado, junto com o log, para os dois
  // nao poderem discordar: se cada lado tivesse a sua copia da regra, o
  // diagnostico mentiria justamente onde se vai olhar. Aqui fica so a
  // traducao dela em HTTP e em escrita no banco.
  //
  // As duas saidas de 200 sem gravar respondem identicas entre si e ao
  // caminho feliz em `function_edge_logs` — mesmo metodo, mesma URL, mesmo
  // status. Foi o que impediu de ver que os 42 webhooks/dia saiam todos
  // pela mesma porta errada. Por isso cada uma diz em `function_logs` por
  // onde saiu; as outras ja se distinguem pelo status (400, 401, 403, 405).
  // O motivo sai em CHAVES, nunca em valores — o corpo carrega telefone e
  // nome de pessoa real.
  const decisao = decidirGravacao(evento, cfg);

  if (decisao.desfecho === "evento_ignorado") {
    console.warn(motivoDeNaoGravar("evento_ignorado", evento));
    return Response.json({ ok: true, ignorado: evento.event });
  }

  // Conversa sem telefone não tem como casar com touchpoint nenhum: o join
  // é por telefone. Sair em silêncio aqui é correto — acontece com canal de
  // web widget, que não é o caminho do Click-to-WhatsApp. Esta é a única
  // guarda que impede gravar.
  if (decisao.desfecho === "contato_sem_telefone") {
    console.warn(motivoDeNaoGravar("contato_sem_telefone", evento));
    return Response.json({ ok: true, semTelefone: true });
  }

  // Conferencia de configuracao, nao de seguranca: pega URL de um cliente
  // colada no Chatwoot de outro, que gravaria conversa no tenant errado
  // sem nenhum sintoma visivel. So DIVERGENCIA recusa; campo que nao veio
  // ou cadastro vazio seguem para a gravacao, e ficam registrados.
  if (decisao.desfecho === "conta_divergente") {
    console.error(
      `Segredo do tenant ${cfg.tenant_id} chegou com account_id do corpo ` +
      `diferente do cadastrado (${cfg.account_id}). URL trocada entre ` +
      `clientes?`,
    );
    return new Response("Conta nao confere com o segredo", { status: 403 });
  }

  if (decisao.desfecho === "inbox_divergente") {
    console.error(
      `Segredo do tenant ${cfg.tenant_id} chegou com inbox_id do corpo ` +
      `diferente do cadastrado (${cfg.inbox_id}). Caixa de entrada errada ` +
      `no Chatwoot?`,
    );
    return new Response("Inbox nao confere com o segredo", { status: 403 });
  }

  // O cast e legitimo aqui e so aqui: `decidirGravacao` so devolve
  // "gravar" depois de conferir que o telefone existe, e e ele que
  // garante que nao se grava conversa sem o que o join precisa.
  const contato = contatoDoEvento(evento);
  const telefone = contato!.phone_number!;

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

  // Gravou sem ter conseguido conferir tudo: registrar isso e o que impede
  // trocar "descarta calado" por "grava calado". A linha para sozinha
  // quando as duas conferencias passarem a acontecer.
  if (decisao.conta !== "confere" || decisao.inbox !== "confere") {
    console.warn(motivoDeNaoConferir(evento, decisao));
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
