/**
 * Normalização de telefone para o join entre Evolution e Chatwoot.
 *
 * Móveis brasileiros ganharam um nono dígito, e os dois sistemas nem sempre
 * usam a mesma grafia: 5511987654321 e 551187654321 são a mesma pessoa.
 * Por isso o número canônico e a chave de join são coisas separadas.
 */

/** Domínio de JID que representa uma pessoa com telefone de verdade. */
const DOMINIO_PESSOA = "s.whatsapp.net";

/** Menor quantidade de dígitos que ainda pode ser um telefone com DDI. */
const MINIMO_DIGITOS = 8;

/**
 * Extrai o E.164 de um JID do WhatsApp, ou `null` se o JID não for um
 * telefone.
 *
 * Devolver `null` em vez de inventar número é o ponto desta função. O
 * WhatsApp também endereça por `@lid` (identificador anônimo, que não é
 * telefone) e `@g.us` (grupo). Cunhar um E.164 a partir deles produziria um
 * número que não existe, entraria no banco como válido, não casaria com
 * contato nenhum no Chatwoot, e a atribuição se perderia sem erro nenhum —
 * exatamente a falha silenciosa que esta normalização existe para impedir.
 *
 * O WhatsApp vem migrando conversas para endereçamento por LID, então este
 * caso deixa de ser hipotético com o tempo.
 */
export function fromJid(jid: string): string | null {
  if (!jid) return null;

  const [antesDoArroba, dominio] = jid.split("@");
  if (dominio !== DOMINIO_PESSOA) return null;

  const semDispositivo = antesDoArroba.split(":")[0];
  const digitos = semDispositivo.replace(/\D/g, "");

  if (digitos.length < MINIMO_DIGITOS) return null;

  return "+" + digitos;
}

/**
 * Chave de join tolerante ao nono dígito.
 *
 * Móvel brasileiro é 55 + DDD + 9XXXXXXXX (13 dígitos). Removendo o nono
 * dígito, iguala-se à grafia legada de 12. Qualquer outro número fica
 * inteiro — encurtar número estrangeiro colidiria pessoas diferentes.
 *
 * A checagem do `9` na posição certa importa: sem ela, qualquer número de
 * 13 dígitos começando com 55 perderia um dígito à toa.
 */
export function toMatchKey(e164: string): string {
  const digitos = e164.replace(/\D/g, "");

  const ehMovelBrasileiro = digitos.startsWith("55") &&
    digitos.length === 13 &&
    digitos[4] === "9";

  if (ehMovelBrasileiro) {
    return digitos.slice(0, 4) + digitos.slice(-8);
  }
  return digitos;
}
