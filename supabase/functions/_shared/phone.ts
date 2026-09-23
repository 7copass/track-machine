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

/**
 * Primeiro dígito do número local que caracteriza celular na grafia de 8.
 *
 * Fixo brasileiro começa com 2, 3, 4 ou 5. A distinção importa porque
 * acrescentar o nono dígito a um fixo produz um número que não existe.
 */
const INICIOS_DE_CELULAR = new Set(["6", "7", "8", "9"]);

/**
 * Todas as grafias sob as quais o mesmo celular pode estar gravado.
 *
 * `toMatchKey` resolve o join no SQL, onde os dois lados já estão na
 * tabela. Buscar na API do Chatwoot é o problema inverso: manda-se uma
 * string e recebe-se o que casar com *ela*, então a grafia precisa ser a
 * do outro lado, que não se conhece de antemão. Medido em produção contra
 * a API real, com os 35 telefones capturados: 35 existem lá como contato e
 * só 5 eram encontrados — exatamente os 5 em que o Chatwoot por acaso
 * guarda a mesma grafia de 12 dígitos que a Evolution nos deu. Nos outros,
 * ele guarda a de 13: o nosso `+559391597627` está lá como
 * `+5593991597627`.
 *
 * A original vem sempre primeiro, para quem chama poder parar na primeira
 * que achar e não gastar rate limit à toa.
 *
 * Móvel brasileiro é 55 + DDD + local; com 9 dígitos locais o primeiro é o
 * nono dígito, com 8 é a grafia legada. Só se acrescenta o nono dígito
 * quando o local de 8 começa com 6, 7, 8 ou 9 — a partir de um fixo, ele
 * cunharia um número inexistente e a requisição extra nunca acharia nada.
 * Número estrangeiro sai intacto: o nono dígito é regra brasileira, e
 * mexer nele inventaria gente que não existe.
 */
export function grafiasPlausiveis(e164: string): string[] {
  const digitos = e164.replace(/\D/g, "");
  const grafias = ["+" + digitos];

  if (!digitos.startsWith("55")) return grafias;

  const ddd = digitos.slice(0, 4);
  const local = digitos.slice(4);

  // Já tem o nono dígito: a outra grafia é ele sem o 9.
  if (digitos.length === 13 && local[0] === "9") {
    grafias.push("+" + ddd + local.slice(1));
  }

  // Grafia legada de celular: a outra é ela com o 9 na frente.
  if (digitos.length === 12 && INICIOS_DE_CELULAR.has(local[0])) {
    grafias.push("+" + ddd + "9" + local);
  }

  return grafias;
}
