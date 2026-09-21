import { admin } from "../_shared/db.ts";
import { buscarMetadataDoAnuncio, ultimaFalha } from "../_shared/meta.ts";

/**
 * Varre os anúncios sem metadata resolvida e preenche a partir da Meta.
 *
 * A fila (`touchpoints_sem_metadata`) nasce de duas origens: anúncio que
 * gerou lead e anúncio que apenas gastou. A segunda é a maioria — e é
 * justamente o anúncio que gastou sem trazer ninguém que o cliente mais
 * precisa identificar pelo nome.
 *
 * Roda separado da captura de propósito: é a única parte que depende de
 * token da Meta, e token expirado não pode fazer o sistema perder lead.
 */
Deno.serve(async () => {
  const db = admin();
  // Ler o ambiente e responsabilidade de quem roda na plataforma, nao do
  // modulo compartilhado — que fica puro e testavel sem permissao.
  const versaoApi = Deno.env.get("META_API_VERSION") ?? "v21.0";

  const { data: contas } = await db
    .from("ad_accounts")
    .select("tenant_id, act_id, token_ref");

  // Um token por tenant, como antes: a primeira conta que tiver token
  // resolvivel atende o tenant inteiro.
  const tokenPorTenant = new Map<string, string>();
  let fusosLidos = 0;

  for (const conta of contas ?? []) {
    const token = conta.token_ref
      ? Deno.env.get(conta.token_ref)
      : undefined;
    if (!token) continue;
    if (!tokenPorTenant.has(conta.tenant_id)) {
      tokenPorTenant.set(conta.tenant_id, token);
    }

    // O fuso da conta e a fonte da verdade do CPL diario, e o
    // `default 'America/Sao_Paulo'` da coluna e uma armadilha: entra
    // calado e parece certo. Na conta real isso ja aconteceu — a TET_PROF
    // e America/Belem, recebeu o default, e ninguem notaria, porque os
    // dois so divergem quando um dos lados tem horario de verao.
    //
    // Depender de alguem lembrar no onboarding repetiria o erro no proximo
    // cliente. Reler da Meta a cada ciclo faz o valor se corrigir sozinho.
    try {
      const r = await fetch(
        `https://graph.facebook.com/${versaoApi}/${conta.act_id}` +
          `?fields=timezone_name&access_token=${encodeURIComponent(token)}`,
      );
      const j = await r.json();
      if (r.ok && typeof j.timezone_name === "string") {
        await db.from("ad_accounts")
          .update({ timezone: j.timezone_name })
          .eq("tenant_id", conta.tenant_id)
          .eq("act_id", conta.act_id);
        fusosLidos++;
      } else {
        console.warn(
          `Fuso de ${conta.act_id} nao veio: status=${r.status} ` +
            `code=${j?.error?.code ?? ""}`,
        );
      }
    } catch (e) {
      console.warn(`Nao consegui ler o fuso de ${conta.act_id}`, e);
    }
  }

  const { data: pendentes } = await db
    .from("touchpoints_sem_metadata")
    .select("tenant_id, ad_id")
    .limit(50);

  if (!pendentes?.length) {
    return Response.json({ ok: true, processados: 0, fusos_lidos: fusosLidos });
  }

  let resolvidos = 0;
  let falhas = 0;
  let semToken = 0;

  for (const linha of pendentes) {
    // Sem token configurado ainda: sai sem erro, tenta no proximo ciclo
    const token = tokenPorTenant.get(linha.tenant_id);
    if (!token) { semToken++; continue; }

    const meta = await buscarMetadataDoAnuncio(token, linha.ad_id, versaoApi);
    if (!meta) { falhas++; continue; }

    await db.from("ad_metadata_cache").upsert({
      ad_id: linha.ad_id,
      tenant_id: linha.tenant_id,
      ad_name: meta.adName,
      adset_id: meta.adsetId,
      adset_name: meta.adsetName,
      campaign_id: meta.campaignId,
      campaign_name: meta.campaignName,
      objetivo: meta.objetivo,
      // Campanha de mensagem e de seguidores aparecem AMBAS como
      // OUTCOME_ENGAGEMENT; quem as separa e o destination_type do
      // conjunto. Null aqui e valor legitimo (conjunto sem destino
      // declarado), por isso sobrescreve.
      destination_type: meta.destinationType,
      optimization_goal: meta.optimizationGoal,
      // A conta de origem, ao contrario, nunca e legitimamente nula: todo
      // anuncio pertence a uma conta. Se a Meta omitir account_id por
      // qualquer motivo, manter o valor que ja estava e melhor que apagar
      // o unico dado por onde a view resolve o fuso do anuncio.
      ...(meta.actId ? { act_id: meta.actId } : {}),
      atualizado_em: new Date().toISOString(),
    });

    // Propaga para os touchpoints. Campanha e conjunto estao fora do
    // trigger de append-only justamente para permitir este preenchimento.
    // Anuncio que so gastou nao tem touchpoint: o update nao acha linha
    // nenhuma e segue, que e o esperado.
    await db.from("ad_touchpoints")
      .update({ adset_id: meta.adsetId, campaign_id: meta.campaignId })
      .eq("tenant_id", linha.tenant_id)
      .eq("ad_id", linha.ad_id);

    resolvidos++;
  }

  // Sem esta distincao, token expirado produziria "processados: 0" a cada
  // 10 minutos, indistinguivel de "nao havia nada a fazer" — o
  // enriquecimento pararia e ninguem saberia.
  if (falhas > 0) {
    console.error(
      `Enriquecimento falhou em ${falhas} de ${pendentes.length} anuncios. ` +
      `Ultima falha: ${ultimaFalha}`,
    );
  }

  return Response.json({
    ok: true,
    processados: resolvidos,
    falhas,
    sem_token: semToken,
    pendentes: pendentes.length,
    fusos_lidos: fusosLidos,
  });
});
