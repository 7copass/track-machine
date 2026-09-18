import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { admin } from "../_shared/db.ts";
import { validarApiKey } from "../_shared/webhook_auth.ts";
import {
  ehDescarte,
  type LinhaTouchpoint,
  montarTouchpoint,
} from "../_shared/touchpoint.ts";
import {
  buscarContatoPorTelefone,
  gravarAtributosDeOrigem,
  ultimaFalha,
} from "../_shared/chatwoot.ts";

/**
 * Webhook do Evolution: grava o touchpoint do lead que veio de anúncio.
 *
 * Esta é a primeira das três redes sobrepostas — ela tenta ligar o lead ao
 * Chatwoot na hora, o webhook do Chatwoot tenta de novo quando a conversa
 * nasce, e o `pg_cron` varre o que escapar. Só uma coisa aqui é
 * insubstituível: gravar a linha. O `ctwa_clid` chega uma vez só, neste
 * payload, e se ele se perder nenhuma das outras redes o recupera. Por isso
 * a falha ao inserir sobe como 500 — para o Evolution reenviar — e todo o
 * resto responde ok.
 *
 * AUTENTICAÇÃO: o Evolution não assina o corpo; ele manda a própria `apikey`
 * da instância dentro do payload. Isso obriga a ler o corpo antes de
 * autenticar — a credencial está nele — mas nada mais acontece antes: nem
 * marcar saúde, nem extrair anúncio, nem gravar. A ordem importa: no
 * `chatwoot-events` a validação ficou depois na primeira versão e uma
 * requisição sem credencial recebia 200.
 *
 * Toda a lógica que decide o que vira lead mora em `_shared/touchpoint.ts`,
 * como função pura. Não há harness de Edge Function aqui, e o que fica
 * dentro do `Deno.serve` só se verifica com webhook de verdade.
 */
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const payload = await req.json().catch(() => null);
  if (!payload) return new Response("Bad Request", { status: 400 });

  const dados = payload.data ?? {};
  const instanciaUuid = typeof dados.instanceId === "string"
    ? dados.instanceId
    : null;
  const instanciaNome = typeof payload.instance === "string"
    ? payload.instance
    : null;

  if (!instanciaUuid && !instanciaNome) {
    return new Response("Payload sem identificacao de instancia", {
      status: 400,
    });
  }

  const db = admin();

  // Lookup pelo UUID quando existir: o nome pode ser renomeado no painel do
  // Evolution e quebraria o vinculo silenciosamente.
  const consulta = db.from("evolution_instances")
    .select("id, tenant_id, api_key");
  const { data: inst } = await (instanciaUuid
    ? consulta.eq("evolution_instance_id", instanciaUuid)
    : consulta.eq("nome_instancia", instanciaNome)
  ).single();

  // Instancia desconhecida e apikey errada devolvem a MESMA resposta de
  // proposito. Como o lookup tambem aceita nome de instancia, e nome e
  // adivinhavel, respostas diferentes diriam a quem tenta quais instancias
  // existem — o mesmo oraculo que o chatwoot-events evita fazendo o segredo
  // resolver o tenant. Aqui nao da para evitar o lookup antes da validacao,
  // porque a chave esperada e por instancia; da para nao contar o resultado.
  // Quem opera separa os dois casos pelo log.
  if (!inst) {
    console.warn("Webhook do Evolution para instancia nao cadastrada", {
      uuid: instanciaUuid,
      nome: instanciaNome,
    });
    return new Response("Unauthorized", { status: 401 });
  }

  if (!validarApiKey(payload.apikey, inst.api_key)) {
    console.warn(`Apikey invalida para a instancia ${inst.id}`);
    return new Response("Unauthorized", { status: 401 });
  }

  // Marca a instancia viva ANTES de olhar se tem anuncio: mensagem organica
  // tambem prova que o rastreamento esta funcionando, e e disso que o dead
  // man's switch depende. Contar so mensagem de anuncio daria falso alarme
  // em conta de volume baixo.
  const { error: erroSaude } = await db.from("evolution_instances")
    .update({ ultimo_evento_em: new Date().toISOString(), estado: "ativo" })
    .eq("id", inst.id);
  if (erroSaude) {
    // Falhar em silencio aqui faria o dead man's switch acusar silencio de
    // uma instancia que esta recebendo mensagem — alarme cuja causa nao
    // estaria registrada em lugar nenhum.
    console.error("Falha ao marcar a instancia viva", erroSaude);
  }

  const linha = montarTouchpoint(payload, inst.tenant_id, inst.id);

  if (ehDescarte(linha)) {
    // Payload malformado e o unico descarte que vira erro: o Evolution
    // mandou anuncio sem o id da mensagem, e sem ele nao ha chave de
    // idempotencia nem linha possivel.
    if (linha.descartar === "sem_identificacao") {
      console.warn(
        `Anuncio sem identificacao de mensagem (${linha.detalhe}) ` +
          `na instancia ${inst.id}`,
      );
      return new Response("Payload sem identificacao de mensagem", {
        status: 400,
      });
    }
    // Os outros dois sao o caminho da maioria do trafego, nao erro.
    // Responder ok evita que o Evolution reenfileire para sempre o que
    // nunca vai virar lead.
    return Response.json({
      ok: true,
      anuncio: false,
      motivo: linha.descartar,
      detalhe: linha.detalhe,
    });
  }

  if (!linha.phone_e164) {
    // JID @lid (identificador anonimo) ou de grupo. O touchpoint vale pelo
    // ctwa_clid, que e o que a Fatia C devolve a Meta; so nao havera como
    // reconciliar com o Chatwoot, e o aviso deixa isso visivel em vez de o
    // lead simplesmente nunca aparecer vinculado.
    console.warn("JID sem telefone; touchpoint fica sem vinculo possivel", {
      dominio: String(dados?.key?.remoteJid ?? "").split("@")[1] ?? "?",
      instancia: inst.id,
    });
  }

  const { error: erroInsert } = await db.from("ad_touchpoints").insert(linha);

  // 23505 na unique (tenant_id, wa_message_id) e o reenvio chegando, nao
  // erro: o Evolution reenvia webhook, e reenvia sempre.
  const duplicado = erroInsert?.code === "23505";
  if (erroInsert && !duplicado) {
    console.error("Falha ao gravar touchpoint", erroInsert);
    return new Response("Erro ao gravar", { status: 500 });
  }

  // Best-effort daqui para baixo: o touchpoint ja esta salvo, e Chatwoot
  // fora do ar nao pode derrubar a captura.
  let enriquecido = false;
  try {
    enriquecido = await enriquecerNoChatwoot(db, linha);
  } catch (e) {
    console.error("Enriquecimento falhou; a reconciliacao recupera", e);
  }

  return Response.json({
    ok: true,
    anuncio: true,
    ad_id: linha.ad_id,
    duplicado,
    ja_vinculado: linha.chatwoot_conversation_id !== null,
    enriquecido,
  });
});

/**
 * Escreve a origem do lead no contato do Chatwoot e guarda o id do contato.
 *
 * Nunca lança para o chamador: o vínculo é conveniência, e a reconciliação
 * fecha depois o que não fechar aqui. O que não pode é falhar em silêncio —
 * token revogado para de enriquecer TODO lead, e o sintoma visível é igual
 * ao do caso normal, que é o Evolution chegar antes de o Chatwoot criar a
 * conversa. Por isso cada saída sem sucesso diz por quê, usando o
 * `ultimaFalha` que o cliente do Chatwoot registra.
 */
async function enriquecerNoChatwoot(
  db: SupabaseClient,
  linha: LinhaTouchpoint,
): Promise<boolean> {
  const telefone = linha.phone_e164;
  // Sem telefone nao ha o que procurar: a busca do Chatwoot e por numero.
  if (!telefone) return false;

  const { data: cfgRow } = await db
    .from("chatwoot_configs")
    .select("base_url, account_id, token_ref")
    .eq("tenant_id", linha.tenant_id)
    .single();

  // Tenant ainda sem Chatwoot configurado: normal durante o onboarding.
  if (!cfgRow) return false;

  const token = Deno.env.get(cfgRow.token_ref);
  if (!token) {
    // A tabela guarda o NOME do segredo, nunca o segredo. Nome cadastrado e
    // ausente no ambiente da funcao e erro de deploy, e nao apareceria em
    // lugar nenhum se nao fosse dito aqui.
    console.error(`Token ${cfgRow.token_ref} nao esta no ambiente da funcao`);
    return false;
  }

  const cfg = {
    baseUrl: cfgRow.base_url,
    accountId: Number(cfgRow.account_id),
    token,
  };

  const contatoId = await buscarContatoPorTelefone(cfg, telefone);
  if (!contatoId) {
    // Contato inexistente nao e falha — e o caminho normal, e o cliente do
    // Chatwoot deixa `ultimaFalha` nulo nesse caso justamente para nao
    // afogar o alerta no ruido do caminho feliz.
    if (ultimaFalha) {
      console.error(`Chatwoot nao respondeu a busca do contato: ${ultimaFalha}`);
    }
    return false;
  }

  const gravou = await gravarAtributosDeOrigem(cfg, contatoId, {
    ctwa_clid: linha.ctwa_clid,
    ad_id: linha.ad_id,
    // A campanha so e conhecida depois do lookup na Graph API, que roda em
    // outra funcao; aqui ela ainda nao existe.
    campaign_id: null,
    veio_de_anuncio: true,
  });
  if (!gravou) {
    console.error(
      `Chatwoot recusou os atributos do contato ${contatoId}: ${ultimaFalha}`,
    );
    return false;
  }

  const { error } = await db.from("ad_touchpoints")
    .update({ chatwoot_contact_id: contatoId })
    .eq("tenant_id", linha.tenant_id)
    .eq("wa_message_id", linha.wa_message_id);
  if (error) {
    console.error("Contato enriquecido mas o vinculo nao foi gravado", error);
    return false;
  }

  return true;
}
