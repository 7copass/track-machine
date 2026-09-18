# Fixtures do Evolution

Payloads reais capturados de instâncias em produção, com telefone,
`ctwaClid` e `apikey` anonimizados e os base64 truncados.

| Arquivo | Cobre |
|---|---|
| `conversation_ctwa_instagram.json` | `fromMe: true`, com IDs do Chatwoot, versão nova (tem `sourceApp`, `ctwaPayload`) |
| `extendedtext_ctwa_sem_chatwoot.json` | `fromMe: false` (lead de verdade), sem Chatwoot, versão antiga (sem `sourceApp`) |
| `conversation_ctwa_thumbnail_buffer.json` | `thumbnail` como **Buffer virado objeto**, não base64 — formato da instância em produção |

## O contrato observado

Comparação chave a chave entre os dois payloads.

**Em `contextInfo`, presentes nos dois:**
`conversionData`, `conversionDelaySeconds`, `conversionSource`,
`externalAdReply`

**Em `externalAdReply`, presentes nos dois (12):**
`containsAutoReply`, `ctwaClid`, `mediaType`, `mediaUrl`,
`renderLargerThumbnail`, `showAdAttribution`, `sourceId`, `sourceType`,
`sourceUrl`, `thumbnail`, `thumbnailUrl`, `title`

**Presentes em só um deles — trate como opcionais:**

| Campo | Onde aparece |
|---|---|
| `sourceApp` | só na versão nova (jul/25) |
| `clickToWhatsappCall`, `greetingMessageBody`, `wtwaAdFormat` | só na versão nova |
| `body` | só na versão antiga (set/24) |

> **Duas amostras não são uma garantia.** "Presente nos dois" quer dizer
> que não observamos ausência — não que o campo seja obrigatório. Código
> que depende de qualquer um deles ainda precisa tolerar ausência; o
> `raw_payload` existe para reprocessar quando algo mudar.

## Armadilhas confirmadas pelos dois payloads

1. **`contextInfo` é irmão de `message`**, não filho. Extração por caminho
   fixo falha em 100% dos casos.
2. **`messageType` não indica onde está o texto.** O payload 2 diz
   `extendedTextMessage` e o conteúdo está em `message.conversation`.
3. **`sourceApp` pode não existir.** Para deduzir a plataforma, use
   `sourceUrl` (presente nos dois) — `mediaUrl` aponta para o Facebook
   mesmo em anúncio do Instagram, porque é só onde o vídeo está hospedado.

5. **`externalAdReply` não significa tráfego pago.** Responder a um post
   orgânico pelo botão de mensagem também gera o campo, com `sourceType`
   diferente de `"ad"` — e ali o `sourceId` é id de post, não de anúncio.
   Contar isso como lead pago infla o relatório do cliente e quebra o
   lookup na Graph API.
4. **`fromMe` varia.** Lead de verdade chega com `false`. Em ambos os
   casos `remoteJid` é o telefone do lead.

6. **`thumbnail` nem sempre é base64.** A instância em produção manda a
   miniatura como **Buffer serializado em objeto** — chaves `"0"`, `"1"`,
   `"2"`… uma por byte, ~32 KB de JSON por lead. Um guarda de tipo restrito
   a `string` deixa isso passar inteiro para o banco. Trate o campo pelo
   nome, não pelo tipo.

   Foi um lead real que revelou isso: as duas primeiras fixtures tinham
   base64, o teste passava, e em produção 32 KB entravam por lead.
