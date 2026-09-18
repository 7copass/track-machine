/**
 * Normalização de telefone para o join entre Evolution e Chatwoot.
 *
 * Móveis brasileiros ganharam um nono dígito, e os dois sistemas nem sempre
 * usam a mesma grafia: 5511987654321 e 551187654321 são a mesma pessoa.
 * Por isso o número canônico e a chave de join são coisas separadas.
 */

/** Extrai o E.164 de um JID do WhatsApp. */
export function fromJid(jid: string): string {
  const antesDoArroba = jid.split("@")[0];
  const semDispositivo = antesDoArroba.split(":")[0];
  return "+" + semDispositivo.replace(/\D/g, "");
}

/**
 * Chave de join tolerante ao nono dígito.
 *
 * Móvel brasileiro (55 + DDD + 9 dígitos = 13) vira 55 + DDD + últimos 8,
 * igualando-se à grafia legada de 12 dígitos. Qualquer outro número fica
 * inteiro — encurtar número estrangeiro colidiria pessoas diferentes.
 */
export function toMatchKey(e164: string): string {
  const digitos = e164.replace(/\D/g, "");
  const ehMovelBrasileiro = digitos.startsWith("55") && digitos.length === 13;
  if (ehMovelBrasileiro) {
    return digitos.slice(0, 4) + digitos.slice(-8);
  }
  return digitos;
}
