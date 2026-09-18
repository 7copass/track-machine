import { admin } from "../_shared/db.ts";
import { buscarMetadataDoAnuncio } from "../_shared/meta.ts";

/**
 * Varre os touchpoints sem campanha resolvida e preenche a partir da Meta.
 *
 * Roda separado da captura de propósito: é a única parte que depende de
 * token da Meta, e token expirado não pode fazer o sistema perder lead.
 */
Deno.serve(async () => {
  const db = admin();

  const { data: pendentes } = await db
    .from("touchpoints_sem_metadata")
    .select("tenant_id, ad_id")
    .limit(50);

  if (!pendentes?.length) {
    return Response.json({ ok: true, processados: 0 });
  }

  let resolvidos = 0;

  for (const linha of pendentes) {
    const { data: conta } = await db
      .from("ad_accounts")
      .select("token_ref")
      .eq("tenant_id", linha.tenant_id)
      .limit(1)
      .single();

    // Sem token configurado ainda: sai sem erro, tenta no proximo ciclo
    if (!conta?.token_ref) continue;

    const token = Deno.env.get(conta.token_ref);
    if (!token) continue;

    const meta = await buscarMetadataDoAnuncio(token, linha.ad_id);
    if (!meta) continue;

    await db.from("ad_metadata_cache").upsert({
      ad_id: linha.ad_id,
      tenant_id: linha.tenant_id,
      ad_name: meta.adName,
      adset_id: meta.adsetId,
      adset_name: meta.adsetName,
      campaign_id: meta.campaignId,
      campaign_name: meta.campaignName,
      objetivo: meta.objetivo,
      atualizado_em: new Date().toISOString(),
    });

    // Propaga para os touchpoints. Campanha e conjunto estao fora do
    // trigger de append-only justamente para permitir este preenchimento.
    await db.from("ad_touchpoints")
      .update({ adset_id: meta.adsetId, campaign_id: meta.campaignId })
      .eq("tenant_id", linha.tenant_id)
      .eq("ad_id", linha.ad_id);

    resolvidos++;
  }

  return Response.json({ ok: true, processados: resolvidos });
});
