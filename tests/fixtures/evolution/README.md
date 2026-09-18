# Fixtures do Evolution

Payloads reais capturados de instâncias em produção, com telefone,
`ctwaClid` e `apikey` anonimizados e os base64 truncados.

| Arquivo | Cobre |
|---|---|
| `conversation_ctwa_instagram.json` | `fromMe: true`, com IDs do Chatwoot, versão nova (tem `sourceApp`, `ctwaPayload`) |
| `extendedtext_ctwa_sem_chatwoot.json` | `fromMe: false` (lead de verdade), sem Chatwoot, versão antiga (sem `sourceApp`) |

## O contrato confiável

Comparando as duas versões, só três campos aparecem em ambas:

- `contextInfo.conversionSource` = `"FB_Ads"`
- `contextInfo.externalAdReply.ctwaClid`
- `contextInfo.externalAdReply.sourceId`

**Todo o resto é opcional e pode não vir.** Qualquer código que dependa
de outro campo precisa funcionar sem ele.

## Armadilhas confirmadas pelos dois payloads

1. **`contextInfo` é irmão de `message`**, não filho. Extração por caminho
   fixo falha em 100% dos casos.
2. **`messageType` não indica onde está o texto.** O payload 2 diz
   `extendedTextMessage` e o conteúdo está em `message.conversation`.
3. **`sourceApp` pode não existir.** Para deduzir a plataforma, use
   `sourceUrl` — `mediaUrl` aponta para o Facebook mesmo em anúncio do
   Instagram.
4. **`fromMe` varia.** Lead de verdade chega com `false`. Em ambos os
   casos `remoteJid` é o telefone do lead.
