/**
 * Autenticação dos webhooks que chegam de fora.
 *
 * Cada origem oferece um mecanismo diferente, e o desenho se dobra ao que
 * existe em vez de fingir um padrão comum:
 *
 * - **Evolution** manda a própria `apikey` da instância dentro do corpo.
 *   Mais fraco que HMAC — a chave viaja a cada requisição — mas é o que ele
 *   oferece. TLS protege em trânsito e a chave é por instância.
 *
 * - **Chatwoot** não assina o corpo e não permite cabeçalho customizado. O
 *   que sobra é um segredo na query string da URL do webhook. Também mais
 *   fraco que HMAC, porque URL costuma aparecer em log de acesso — por isso
 *   o segredo é **por tenant**: um vazamento fica contido a um cliente, em
 *   vez de abrir a plataforma inteira.
 *
 * Em ambos os casos, ausência de credencial cadastrada recusa o webhook. Na
 * dúvida, negar: uma integração recém-criada não pode ficar aberta.
 */

/** Comparação em tempo constante: não revela o segredo por timing. */
function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

/** Valida a `apikey` que o Evolution envia no corpo do webhook. */
export function validarApiKey(
  recebida: string | null | undefined,
  esperada: string | null | undefined,
): boolean {
  if (!recebida || !esperada) return false;
  return iguais(recebida, esperada);
}

/**
 * Lê o segredo da query string (`?s=...`) da URL do webhook.
 *
 * Devolve `null` quando não há segredo ou a URL é inválida — o chamador
 * trata os dois casos como recusa.
 */
export function extrairSegredoDaUrl(url: string): string | null {
  try {
    const s = new URL(url).searchParams.get("s");
    return s && s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

/** Valida o segredo do webhook do Chatwoot contra o cadastrado no tenant. */
export function validarSegredo(
  recebido: string | null | undefined,
  esperado: string | null | undefined,
): boolean {
  if (!recebido || !esperado) return false;
  return iguais(recebido, esperado);
}
