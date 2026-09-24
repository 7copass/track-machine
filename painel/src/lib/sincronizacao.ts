/**
 * O que a tela escreve depois de pedir uma sincronização.
 *
 * Módulo puro, fora do componente, e o motivo é o único modo de falhar que
 * este botão tem: **fingir sucesso**. A resposta da Edge Function traz
 * quatro desfechos diferentes com a mesma cara de JSON — sincronizou,
 * recusou pela trava, não tinha conta, quebrou —, e três deles somam zero
 * linhas. Lido sem cuidado, todos viram "0 linhas", que é a frase de quem
 * atualizou e não achou nada.
 *
 * O operador então toma decisão de verba sobre um número velho achando que
 * é novo. Dentro do componente essa leitura precisaria de DOM e de `fetch`
 * para ser exercitada, e na prática nunca seria.
 */

export type Recado = {
  /** O que fica ao lado do botão. */
  texto: string;
  /** Se algo foi escrito no banco — e portanto a tela está velha. */
  atualizou: boolean;
};

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Uma string não vazia do corpo, quando houver. */
function frase(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Quanto falta, em minutos, para a trava liberar.
 *
 * Sempre a espera mais longa: dizer 1 min quando outra conta ainda tem 5
 * faria o operador clicar de novo e levar outra recusa. E piso de 1 — a
 * trava que falta menos de um minuto ainda é uma trava, e "aguarde 0 min"
 * manda esperar nada.
 */
function minutos(travadas: Array<Record<string, unknown>>): number {
  const segundos = travadas.map((c) => Number(c.faltam_segundos) || 0);
  return Math.max(1, Math.ceil(Math.max(...segundos) / 60));
}

export function lerSincronizacao(status: number, corpo: unknown): Recado {
  if (!ehObjeto(corpo)) return { texto: "falhou", atualizou: false };

  // Status de erro nunca é lido como resultado, por mais bem formado que o
  // corpo pareça: um 401 do `verify_jwt` com corpo vazio somaria zero conta
  // e zero linha, e sairia daqui como "0 linhas".
  if (status >= 400) {
    const motivo = frase(corpo.erro) ?? frase(corpo.motivo);
    return { texto: motivo ?? `falhou (${status})`, atualizou: false };
  }

  const contas = corpo.contas;
  if (!Array.isArray(contas)) {
    // `{ ok: true, contas: 0, motivo: "nenhuma cadastrada" }` chega aqui:
    // `contas` é o NÚMERO de contas, não a lista. Tratar como lista vazia
    // diria "0 linhas" sobre uma varredura que não tinha o que varrer.
    const motivo = frase(corpo.erro) ?? frase(corpo.motivo);
    return { texto: motivo ?? "falhou", atualizou: false };
  }

  const lista = contas.filter(ehObjeto);
  const travadas = lista.filter((c) => c.pulado === "trava");
  // Conta com `pulado` não chegou a buscar nada; as linhas dela não existem.
  const rodaram = lista.filter(
    (c) => c.pulado === undefined || c.pulado === null,
  );
  const comErro = rodaram.filter((c) => frase(c.erro) !== null);
  const linhas = rodaram.reduce((s, c) => s + (Number(c.linhas) || 0), 0);

  const partes: string[] = [];
  if (rodaram.length > 0) partes.push(`${linhas} linhas`);
  // A recusa entra mesmo quando outra conta trouxe linhas. A própria Edge
  // Function chama isso de meia verdade: parte do período atualizou e parte
  // não, e mostrar só as linhas afirmaria um painel inteiro que não está.
  if (travadas.length > 0) partes.push(`aguarde ${minutos(travadas)} min`);
  // `linhas: 0` com `erro` preenchido é o formato de token ausente. Sem esta
  // parte, o sintoma fica igual ao de "não havia o que buscar".
  if (comErro.length > 0) partes.push(`${comErro.length} com erro`);

  if (partes.length === 0) {
    return { texto: frase(corpo.motivo) ?? "falhou", atualizou: false };
  }

  return { texto: partes.join(" · "), atualizou: rodaram.length > 0 };
}
