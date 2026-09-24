# Painel do Operador

Tela local para ver gasto, leads e custo por lead das campanhas da Meta.

## Rodar

    npm install
    npm run dev

Abre em http://localhost:3000.

## ⚠️ Este painel não tem autenticação

Ele lê o banco com a chave de serviço, que ignora RLS e dá acesso total.
Isso é aceitável **porque roda só em localhost**.

**Não publique como está** e não rode com `-H 0.0.0.0`. O painel do
cliente, com link por tenant e JWT, é a segunda metade da Fatia B2.

A chave nunca sai do servidor: as consultas são todas Server Components, e
`src/lib/supabase.ts` importa `server-only`, que faz o `next build` falhar
se algum componente de cliente alcançar esse arquivo. O botão de atualizar é
código de cliente e por isso chama `POST /atualizar` — é a rota, no
servidor, que põe a chave no `Authorization` da Edge Function.

## Variáveis

`.env.local` (fora do git) precisa de `SUPABASE_URL` e
`SUPABASE_SERVICE_ROLE_KEY`.

## A tela

- **Período** — 7, 30 ou 90 dias, no seletor do topo. O período mora na URL
  (`/?dias=30`), então a tela é compartilhável e o botão voltar funciona.
  Qualquer outro valor cai em 90.
- **Cards** — gasto, leads, custo por lead e número de anúncios. O CPL
  divide o gasto da janela **que tem captura de lead**, não o do período
  inteiro, e mostra essa conta embaixo quando os dois diferem.
- **Gráfico** — gasto por dia, com o valor do topo da escala escrito.
- **Tabela** — uma linha por criativo (agrupado por nome), ordenada por
  gasto. A coluna Vezes diz quantos anúncios entraram em cada linha.
- **Atualizar** — dispara a sincronização manual. A trava de 5 minutos por
  tenant vive no banco; quando ela recusa, o botão diz quanto falta em vez
  de fingir que atualizou.

## Testes

    npm test

Falam com o banco de verdade (exceto os de `pagina-sem-banco`, `periodo`,
`sincronizacao`, `formato`, `grafico` e `componentes`), então precisam do
`.env.local`. Nenhum compara contra número fixo: os crons escrevem o tempo
todo e a janela desliza.
