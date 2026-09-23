# Painel do Operador — Plano de Implementação

> **Para executores agênticos:** SUB-SKILL OBRIGATÓRIA: use
> `superpowers:subagent-driven-development` (recomendado) ou
> `superpowers:executing-plans` para implementar tarefa a tarefa.
> Os passos usam checkbox (`- [ ]`) para acompanhamento.

**Objetivo:** Uma tela local que responda, sem SQL: quanto foi gasto, em
quais anúncios, e quanto custou cada lead.

**Arquitetura:** Next.js App Router com React Server Components. Toda
consulta roda no servidor com a chave de serviço; nenhuma sai para o
navegador, então a chave nunca entra no bundle. Sem autenticação e sem RLS
porque é a máquina do operador — quando virar painel de cliente, troca-se a
chave por um JWT com `tenant_id` e o RLS volta a valer, sem mudar tela.

**Stack:** Next.js (App Router, versão `latest` — hoje 16), React, TypeScript,
Vitest, SVG inline para o gráfico.

> **A versão não está fixada de propósito**, e isso tem consequência: o
> scaffold gera `painel/AGENTS.md` com a orientação do próprio Next
> avisando que a versão atual tem mudanças de API e mandando ler os docs
> embarcados em `node_modules/next/dist/docs/` antes de escrever código.
> Esse arquivo é reescrito pelo `next dev` a cada execução.
>
> **Mantenha os dois arquivos que o scaffold cria** (`AGENTS.md` e o
> `CLAUDE.md` que aponta para ele). Eles não foram pedidos, mas fazem
> trabalho real: este plano foi escrito assumindo Next 15, e foi esse aviso
> que fez a Tarefa 1 conferir a documentação antes de usar
> `export const dynamic`. Apagá-los só reintroduz a alteração não
> commitada e tira a proteção.

**Spec:** `docs/superpowers/specs/2026-09-21-painel-operador-design.md`

## Restrições Globais

- **Nenhuma consulta ao Supabase no cliente.** Server Components apenas. Se
  algum dia uma consulta precisar do navegador, ela exige JWT e RLS.
- **A chave de serviço vive em `painel/.env.local`**, que entra no
  `.gitignore`. Nunca em código, nunca em componente de cliente.
- **Dinheiro é `bigint` em centavos no banco.** A divisão por 100 acontece
  só na formatação, nunca na consulta.
- **CPL agregado é recalculado sobre os totais**, nunca a média dos CPLs.
  Somar médias produz número errado — regra do projeto desde o primeiro dia.
- **Anúncio sem lead mostra `0 leads`, nunca um traço.** "Gastou R$ 340 e
  não trouxe ninguém" é informação, não buraco no dado.
- **O gráfico segue as regras da skill `dataviz`:** uma série só (sem
  legenda — o título nomeia), linha de 2px, grade recessiva, eixo único
  (nunca dois), texto em cor de texto e nunca na cor da série, e camada de
  hover com crosshair. A cor `#3B82F6` já foi validada contra a superfície
  escura e passa em todos os checks.
- **Commits em português**, imperativo, explicando o porquê e não o quê.
- **`git add` sempre por caminho explícito**, nunca `-A` nem diretório
  inteiro — tarefas podem rodar em paralelo nesta árvore.

## Estrutura de Arquivos

```
painel/
  .env.local                  chave de serviço (gitignored)
  package.json
  next.config.ts
  tsconfig.json
  vitest.config.ts
  src/
    app/
      layout.tsx              shell, fontes, tema escuro
      page.tsx                a tela, Server Component
      globals.css             tokens do design system
      atualizar/route.ts      dispara a sincronização manual
    lib/
      supabase.ts             cliente com service_role, só servidor
      consultas.ts            as três consultas
      formato.ts              centavos → R$, datas, números
    componentes/
      Cards.tsx               os quatro números do topo
      GraficoGasto.tsx        SVG inline, série única, com hover
      TabelaAnuncios.tsx      lista ordenada por gasto
      SeletorPeriodo.tsx      7d · 30d · 90d
      BotaoAtualizar.tsx      chama a rota, mostra a trava
      AvisoCaptura.tsx        "CPL disponível a partir de 18/09"
  tests/
    formato.test.ts
    consultas.test.ts
```

`formato.ts` e `consultas.ts` são os únicos arquivos com teste, porque são
os únicos onde um erro produz número errado em silêncio. O resto é visual,
e visual se confere olhando.

---

### Tarefa 1: Projeto e a primeira consulta real

**Arquivos:**
- Criar: `painel/` (via `create-next-app`)
- Criar: `painel/src/lib/supabase.ts`
- Modificar: `painel/src/app/page.tsx`
- Modificar: `.gitignore`

**Interfaces:**
- Produz: `servidor(): SupabaseClient` em `painel/src/lib/supabase.ts` — o
  cliente com `service_role`, importável **apenas** de Server Component.

- [ ] **Passo 1: Criar o projeto**

```bash
cd /Users/victorhugosantanaalmeida/Clientes-Victor-Tráfego
npx create-next-app@latest painel \
  --typescript --app --src-dir --no-tailwind --eslint \
  --import-alias "@/*" --use-npm --turbopack
cd painel && npm install @supabase/supabase-js
```

- [ ] **Passo 2: Guardar a chave e proteger do git**

```bash
cd /Users/victorhugosantanaalmeida/Clientes-Victor-Tráfego
set -a && . ./.env && set +a
printf 'SUPABASE_URL=%s\nSUPABASE_SERVICE_ROLE_KEY=%s\n' \
  "$SUPABASE_URL" "$SUPABASE_SERVICE_ROLE_KEY" > painel/.env.local
chmod 600 painel/.env.local

grep -q '^painel/.env.local$' .gitignore || \
  printf '\n# Chave de servico do painel\npainel/.env.local\n' >> .gitignore

git check-ignore -v painel/.env.local
```

Esperado: o `check-ignore` confirma que o arquivo está protegido. **Não
imprima o conteúdo dele.**

- [ ] **Passo 3: Escrever o cliente do servidor**

Criar `painel/src/lib/supabase.ts`:

```typescript
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente com a chave de serviço.
 *
 * O `import "server-only"` no topo não é decoração: ele faz o build
 * FALHAR se algum componente de cliente importar este arquivo. Sem isso,
 * um `"use client"` acrescentado por descuido levaria a chave de serviço
 * para dentro do bundle do navegador — e ela dá acesso total ao banco,
 * contornando todo o RLS.
 *
 * É a única barreira automática que existe aqui; o resto é disciplina.
 */
export function servidor(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !chave) {
    throw new Error(
      "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes. " +
        "Confira painel/.env.local.",
    );
  }

  return createClient(url, chave, { auth: { persistSession: false } });
}
```

```bash
cd painel && npm install server-only
```

- [ ] **Passo 4: Provar a conexão na tela**

Substituir `painel/src/app/page.tsx` por:

```tsx
import { servidor } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function Pagina() {
  const db = servidor();
  // Sem limite: a view tem alguns milhares de linhas para 90 dias, e
  // comparar dois `LIMIT` sem `ORDER BY` compararia dois subconjuntos
  // arbitrarios — que coincidem enquanto o plano de execucao for o mesmo
  // e divergem sem aviso quando deixar de ser.
  const { data, error } = await db
    .from("desempenho_por_anuncio")
    .select("gasto_centavos")
    .limit(50000);

  if (error) {
    return <pre style={{ padding: 32 }}>Erro: {error.message}</pre>;
  }

  const total = (data ?? []).reduce((s, l) => s + Number(l.gasto_centavos), 0);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Track Machine</h1>
      <p>{data?.length} linhas · R$ {(total / 100).toFixed(2)}</p>
    </main>
  );
}
```

- [ ] **Passo 5: Rodar e conferir**

```bash
cd painel && npm run dev
```

Abra `http://localhost:3000`. Esperado: o número de linhas e um gasto em
reais, batendo com esta consulta:

```bash
cd /Users/victorhugosantanaalmeida/Clientes-Victor-Tráfego
set -a && . ./.env && set +a
python3 -c "
import sys; sys.path.insert(0,'scripts')
from run_pgtap import carregar_env, executar
carregar_env()
ok, r = executar('''select count(*)::int linhas,
  round(sum(gasto_centavos)/100.0,2) gasto
  from desempenho_por_anuncio''')
print(r)
"
```

- [ ] **Passo 6: Confirmar que a chave não vaza**

```bash
cd painel && npm run build

CHAVE=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env.local | cut -d= -f2-)

# Controle: o grep precisa achar a chave onde ela de fato esta. Sem isso,
# um padrao vazio devolveria "✓" sem ter procurado nada.
grep -qF "$CHAVE" .env.local \
  && echo "controle: o grep encontra a chave em .env.local ✓" \
  || { echo "✗ o proprio controle falhou — a verificacao abaixo nao vale"; exit 1; }

# grep -F com a chave INTEIRA. Usar um prefixo seria inutil: os primeiros
# 20 caracteres de qualquer JWT sao "eyJhbGciOiJIUzI1NiIs", o cabecalho
# {"alg":"HS256","typ":"JWT"} — identico na chave anonima, que e publica
# por desenho. O check gritaria falso alarme no dia em que o painel do
# cliente puser a anon key na tela, e check que grita a toa acaba
# desligado.
grep -rlF "$CHAVE" .next/ 2>/dev/null \
  && echo "⚠ CHAVE NO BUNDLE" \
  || echo "✓ a chave de servico nao aparece em nenhum arquivo do build"
```

Esperado: o controle passa e a chave não aparece.

- [ ] **Passo 6b: Provar que o `server-only` realmente barra**

O passo acima passa mesmo se o `server-only` não estiver fazendo nada —
ele só constata ausência. Para provar que a barreira existe, force o caso
que ela deve impedir:

```bash
cd painel
cat > src/app/_vazamento.tsx <<'TSX'
"use client";
import { servidor } from "@/lib/supabase";
export default function X() { return <div>{typeof servidor}</div>; }
TSX

npm run build 2>&1 | grep -i "server-only" \
  && echo "✓ a barreira funciona: o build recusou" \
  || echo "⚠ O BUILD PASSOU — a barreira nao esta fazendo nada"

rm src/app/_vazamento.tsx && npm run build >/dev/null 2>&1
```

Esperado: `'server-only' cannot be imported from a Client Component module`.

Se o build **passar**, a única proteção automática do desenho não existe, e
a chave de serviço pode chegar ao navegador no primeiro descuido.

- [ ] **Passo 7: Commit**

```bash
cd /Users/victorhugosantanaalmeida/Clientes-Victor-Tráfego
git add painel/ .gitignore
git commit -m "Painel do operador: projeto e conexao com o banco

Server Components com a chave de servico: sem autenticacao porque e a
maquina do operador, sem RLS porque operador ve tudo por definicao, e
sem risco de chave no bundle porque nenhuma consulta sai do
navegador.

O import server-only nao e decoração — ele faz o build FALHAR se um
componente de cliente importar o arquivo da chave. E a unica barreira
automatica aqui; o resto seria disciplina."
```

---

### Tarefa 2: Formatação

**Arquivos:**
- Criar: `painel/src/lib/formato.ts`
- Criar: `painel/tests/formato.test.ts`
- Criar: `painel/vitest.config.ts`

**Interfaces:**
- Consome: nada. Módulo puro.
- Produz: `reais(centavos: number | string | null): string`,
  `numero(v: number | string | null): string`,
  `diaCurto(iso: string): string`,
  `horaCurta(iso: string | null): string`.

- [ ] **Passo 1: Instalar o Vitest**

```bash
cd painel && npm install -D vitest
```

> **O `install` falha com `ERESOLVE`** se `@types/node` estiver em `^20`:
> o Vitest 5 exige `>=24`, e o scaffold fixa `^20` mesmo numa máquina
> rodando Node 24. Suba os tipos para casar com o runtime — é o certo de
> qualquer jeito:
>
> ```bash
> npm install -D @types/node@^24
> ```
>
> Não use `--legacy-peer-deps`: isso esconderia a divergência entre os
> tipos e o Node que de fato executa o código.

Criar `painel/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
```

Acrescentar ao `scripts` do `painel/package.json`: `"test": "vitest run"`.

- [ ] **Passo 2: Escrever os testes que falham**

Criar `painel/tests/formato.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { diaCurto, horaCurta, numero, reais } from "@/lib/formato";

describe("reais", () => {
  it("converte centavos inteiros em moeda brasileira", () => {
    expect(reais(1864)).toBe("R$ 18,64");
    expect(reais(3169987)).toBe("R$ 31.699,87");
    expect(reais(0)).toBe("R$ 0,00");
  });

  it("aceita string, que e como o PostgREST devolve bigint", () => {
    // bigint vira string no JSON para nao perder precisao. Tratar como
    // numero sem converter daria NaN na tela.
    expect(reais("3169987")).toBe("R$ 31.699,87");
  });

  it("nao arredonda centavo para cima", () => {
    // 466 centavos sao R$ 4,66 — nunca R$ 4,67. Dinheiro que muda na
    // exibicao e o tipo de erro que o cliente encontra antes de nos.
    expect(reais(466)).toBe("R$ 4,66");
    expect(reais(1)).toBe("R$ 0,01");
    expect(reais(99)).toBe("R$ 0,99");
  });

  it("devolve traco para valor ausente", () => {
    expect(reais(null)).toBe("—");
  });
});

describe("numero", () => {
  it("agrupa milhar no padrao brasileiro", () => {
    expect(numero(839)).toBe("839");
    expect(numero(64759)).toBe("64.759");
  });

  it("aceita string e ausente", () => {
    expect(numero("4148")).toBe("4.148");
    expect(numero(null)).toBe("—");
  });
});

describe("diaCurto", () => {
  it("formata a data sem deslocar pelo fuso", () => {
    expect(diaCurto("2026-09-18")).toBe("18/09");
    expect(diaCurto("2026-01-01")).toBe("01/01");
  });

  // ATENÇÃO: os dois casos acima, sozinhos, passam por acidente.
  //
  // `new Date("2026-09-18")` é meia-noite UTC. A implementação ingênua
  // (passar pelo Date) só devolve o dia errado em fuso NEGATIVO — então
  // numa máquina a oeste de Greenwich o teste reprova, e num CI rodando
  // UTC ele fica verde para sempre sem ter exercido nada.
  //
  // Medido: com TZ=UTC a implementação ingênua devolve "18/09" e passa;
  // com TZ=America/Santarem devolve "17/09" e reprova.
  //
  // Por isso os casos abaixo varrem fusos dos DOIS lados de Greenwich —
  // dois fusos com o mesmo deslocamento provariam menos do que parecem.
  const FUSOS = ["Etc/GMT+12", "America/Santarem", "UTC", "Asia/Tokyo",
                 "Pacific/Kiritimati"];

  for (const tz of FUSOS) {
    it(`nao desloca a data em ${tz}`, () => {
      const antes = process.env.TZ;
      process.env.TZ = tz;
      try {
        expect(diaCurto("2026-09-18")).toBe("18/09");
        expect(diaCurto("2026-01-01")).toBe("01/01");
        expect(diaCurto("2026-12-31")).toBe("31/12");
      } finally {
        process.env.TZ = antes;
      }
    });
  }

  it("controle: trocar TZ realmente muda o que o Date enxerga", () => {
    // Sem este controle, a suite de fusos acima poderia estar verde por
    // nao estar trocando fuso nenhum — e provaria exatamente nada.
    const antes = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      const leste = new Date("2026-09-18").getDate();
      process.env.TZ = "Etc/GMT+12";
      const oeste = new Date("2026-09-18").getDate();
      expect(leste).not.toBe(oeste);
    } finally {
      process.env.TZ = antes;
    }
  });
});

describe("horaCurta", () => {
  it("mostra so a hora do carimbo de atualizacao", () => {
    expect(horaCurta("2026-09-21T17:18:07.953Z")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("devolve traco quando nunca sincronizou", () => {
    expect(horaCurta(null)).toBe("—");
  });
});
```

- [ ] **Passo 3: Rodar e confirmar que falha**

```bash
cd painel && npm test
```

Esperado: FALHA com `Failed to resolve import "@/lib/formato"`.

- [ ] **Passo 4: Implementar**

Criar `painel/src/lib/formato.ts`:

```typescript
/**
 * Formatação para a tela.
 *
 * Módulo puro: é onde o erro de dinheiro aparece, e é por isso que ele é
 * o único da interface com teste.
 */

const MOEDA = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const MILHAR = new Intl.NumberFormat("pt-BR");

/**
 * Centavos inteiros para moeda.
 *
 * O PostgREST devolve `bigint` como **string**, para não perder precisão —
 * tratar como número sem converter daria `NaN` na tela.
 */
export function reais(centavos: number | string | null): string {
  if (centavos === null || centavos === undefined) return "—";
  const n = Number(centavos);
  if (!Number.isFinite(n)) return "—";
  // O Intl separa "R$" do número com espaço INQUEBRÁVEL (U+00A0), não com
  // espaço comum. Na tela os dois são idênticos — e é por isso que o erro
  // que ele causa é o pior possível:
  //     expected 'R$ 18,64' to be 'R$ 18,64'
  // Duas strings visualmente iguais, e quem lê fica caçando o que não vê.
  // Normalizar num lugar só evita que todo `toBe("R$ ...")` futuro caia
  // na mesma armadilha invisível.
  return MOEDA.format(n / 100).replace(/[\u00A0\u202F]/g, " ");
}

export function numero(v: number | string | null): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? MILHAR.format(n) : "—";
}

/**
 * Data de uma coluna `date`, sem deslocar pelo fuso.
 *
 * `new Date("2026-09-18")` é interpretado como meia-noite UTC; a oeste de
 * Greenwich isso vira 17/09 às 21h e a tela mostra o dia errado. Como a
 * coluna não tem hora, o certo é fatiar a string.
 */
export function diaCurto(iso: string): string {
  const [, mes, dia] = iso.slice(0, 10).split("-");
  return `${dia}/${mes}`;
}

export function horaCurta(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
```

- [ ] **Passo 5: Rodar e confirmar que passa**

```bash
cd painel && npm test
```

Esperado: 15 testes passando.

- [ ] **Passo 6: Commit**

```bash
cd /Users/victorhugosantanaalmeida/Clientes-Victor-Tráfego
git add painel/src/lib/formato.ts painel/tests/formato.test.ts \
        painel/vitest.config.ts painel/package.json painel/package-lock.json
git commit -m "Formatacao da tela, com teste onde o erro seria silencioso

O PostgREST devolve bigint como string para nao perder precisao.
Tratar como numero sem converter daria NaN na tela — e gasto some
sem nenhum erro no console.

A data de coluna date e fatiada da string, nao passada pelo Date:
new Date('2026-09-18') e meia-noite UTC, que a oeste de Greenwich
vira 17/09 as 21h. A tela mostraria o dia errado, que e exatamente
o erro que a view de desempenho existe para evitar."
```

---

### Tarefa 3: As três consultas

**Arquivos:**
- Criar: `painel/src/lib/consultas.ts`
- Criar: `painel/tests/consultas.test.ts`

**Interfaces:**
- Consome: `servidor()` (Tarefa 1).
- Produz:
  `type Resumo = { gasto: number; leads: number; anuncios: number; cplMedio: number | null }`,
  `type PontoDia = { dia: string; gasto: number }`,
  `type LinhaAnuncio = { adId: string; nome: string | null; campanha: string | null; conta: string | null; destino: string | null; gasto: number; leads: number; cpl: number | null }`,
  `resumo(dias: number): Promise<Resumo>`,
  `gastoPorDia(dias: number): Promise<PontoDia[]>`,
  `anuncios(dias: number): Promise<LinhaAnuncio[]>`,
  `ultimaAtualizacao(): Promise<string | null>`.

- [ ] **Passo 1: Escrever os testes que falham**

Criar `painel/tests/consultas.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { anuncios, gastoPorDia, resumo } from "@/lib/consultas";

// Estes testes rodam contra o banco de verdade. Não há dublê aqui de
// propósito: o que se quer provar é que a agregação no TypeScript bate
// com a que o Postgres faria — e um mock provaria só que o mock concorda
// consigo mesmo.

describe("resumo", () => {
  it("soma gasto e leads do periodo", async () => {
    const r = await resumo(90);
    expect(r.gasto).toBeGreaterThan(0);
    expect(r.anuncios).toBeGreaterThan(0);
    expect(Number.isInteger(r.gasto)).toBe(true);
  });

  it("calcula o CPL medio sobre os totais, nao como media de CPLs", async () => {
    // Somar medias produz numero errado. Com gasto G e leads L, o CPL
    // medio e G/L — e nunca a media dos G_i/L_i de cada anuncio.
    const r = await resumo(90);
    if (r.leads > 0) {
      expect(r.cplMedio).toBe(Math.floor(r.gasto / r.leads));
    } else {
      expect(r.cplMedio).toBeNull();
    }
  });

  it("periodo menor nunca traz mais gasto que periodo maior", async () => {
    const [sete, noventa] = await Promise.all([resumo(7), resumo(90)]);
    expect(sete.gasto).toBeLessThanOrEqual(noventa.gasto);
  });
});

describe("gastoPorDia", () => {
  it("devolve os dias em ordem crescente", async () => {
    const pontos = await gastoPorDia(90);
    expect(pontos.length).toBeGreaterThan(0);
    const dias = pontos.map((p) => p.dia);
    expect([...dias].sort()).toEqual(dias);
  });

  it("a soma dos dias bate com o gasto do resumo", async () => {
    // Se o card divergir do grafico, ninguem confia em nenhum dos dois.
    const [pontos, r] = await Promise.all([gastoPorDia(90), resumo(90)]);
    const soma = pontos.reduce((s, p) => s + p.gasto, 0);
    expect(soma).toBe(r.gasto);
  });
});

describe("anuncios", () => {
  it("vem ordenado por gasto decrescente", async () => {
    const linhas = await anuncios(90);
    expect(linhas.length).toBeGreaterThan(0);
    for (let i = 1; i < linhas.length; i++) {
      expect(linhas[i - 1].gasto).toBeGreaterThanOrEqual(linhas[i].gasto);
    }
  });

  it("anuncio sem lead tem cpl nulo e leads zero, nunca infinito", async () => {
    const semLead = (await anuncios(90)).filter((l) => l.leads === 0);
    expect(semLead.length).toBeGreaterThan(0);
    for (const l of semLead) {
      expect(l.cpl).toBeNull();
      expect(Number.isFinite(l.gasto)).toBe(true);
    }
  });

  it("anuncios de contas diferentes com o mesmo nome sao linhas separadas", async () => {
    // O tenant real tem duas contas, e ha anuncios homonimos em cada uma:
    // dois "ad01" na campanha VAGA. Se a agregacao juntasse por nome em
    // vez de por ad_id, o gasto dos dois viraria um so — e o CPL sairia
    // errado sem nada indicar.
    const linhas = await anuncios(90);
    const porNome = new Map<string, number>();
    for (const l of linhas) {
      if (l.nome) porNome.set(l.nome, (porNome.get(l.nome) ?? 0) + 1);
    }
    const homonimos = [...porNome.values()].filter((n) => n > 1);
    if (homonimos.length > 0) {
      // Havendo homonimos, cada um precisa dizer de qual conta veio.
      const comNomeRepetido = linhas.filter(
        (l) => l.nome && porNome.get(l.nome)! > 1,
      );
      for (const l of comNomeRepetido) {
        expect(l.conta).not.toBeNull();
      }
    }
    // E os ad_id continuam unicos, aconteca o que acontecer com os nomes.
    const ids = linhas.map((l) => l.adId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a soma dos anuncios bate com o gasto do resumo", async () => {
    const [linhas, r] = await Promise.all([anuncios(90), resumo(90)]);
    const soma = linhas.reduce((s, l) => s + l.gasto, 0);
    expect(soma).toBe(r.gasto);
  });
});
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
cd painel && npm test
```

Esperado: FALHA com `Failed to resolve import "@/lib/consultas"`.

- [ ] **Passo 3: Carregar o `.env.local` nos testes**

Acrescentar a `painel/vitest.config.ts`, dentro de `test`:

```typescript
    setupFiles: ["./tests/setup.ts"],
```

Criar `painel/tests/setup.ts`:

```typescript
// Os testes de consulta falam com o banco de verdade, então precisam das
// mesmas variáveis que o servidor usa. O Next carrega `.env.local`
// sozinho; o Vitest não.
import { config } from "dotenv";
config({ path: ".env.local" });
```

```bash
cd painel && npm install -D dotenv
```

- [ ] **Passo 4: Implementar**

Criar `painel/src/lib/consultas.ts`:

```typescript
import "server-only";
import { cache } from "react";
import { servidor } from "./supabase";

export type Resumo = {
  gasto: number;
  leads: number;
  anuncios: number;
  cplMedio: number | null;
};

export type PontoDia = { dia: string; gasto: number };

export type LinhaAnuncio = {
  adId: string;
  nome: string | null;
  campanha: string | null;
  /**
   * De qual conta de anúncio o anúncio veio.
   *
   * Não é decoração: o tenant real tem duas contas, e existem anúncios com
   * o MESMO nome em cada uma — dois `ad01`, em contas diferentes, ambos na
   * campanha `VAGA`. Sem mostrar a conta, a tabela exibe duas linhas
   * idênticas no rótulo e o operador conclui que o painel duplicou.
   */
  conta: string | null;
  destino: string | null;
  gasto: number;
  leads: number;
  cpl: number | null;
};

/**
 * Data de corte do período, no formato que a coluna `dia` usa.
 *
 * Calculado em UTC. A conferência do Passo 6 usa `current_date` do banco,
 * que segue o fuso dele — perto da virada do dia os dois discordam de um
 * dia inteiro, e a divergência parece bug de agregação quando é só de
 * referencial. Se isso acontecer, rode a conferência com
 * `(now() at time zone 'UTC')::date - N` em vez de `current_date - N`.
 */
function desde(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Lê a view inteira do período — uma vez por carregamento.
 *
 * O `cache` do React deduplica dentro da mesma renderização: as três
 * funções abaixo chamam esta, e sem ele a página buscaria as mesmas
 * ~4 mil linhas **três vezes** para exibi-las uma. Com ele, a primeira
 * chamada busca e as outras duas recebem o mesmo resultado.
 *
 * Se o volume crescer a ponto de incomodar, o caminho é agregar no
 * Postgres — não paginar aqui.
 */
const linhasDoPeriodo = cache(async function (dias: number) {
  const db = servidor();
  const { data, error } = await db
    .from("desempenho_por_anuncio")
    .select("ad_id, ad_name, campaign_name, act_id, destination_type, dia, gasto_centavos, leads")
    .gte("dia", desde(dias))
    .limit(50000);

  if (error) {
    throw new Error(`Falha ao ler desempenho_por_anuncio: ${error.message}`);
  }
  return data ?? [];
});

export async function resumo(dias: number): Promise<Resumo> {
  const linhas = await linhasDoPeriodo(dias);

  let gasto = 0;
  let leads = 0;
  const ads = new Set<string>();

  for (const l of linhas) {
    gasto += Number(l.gasto_centavos);
    leads += Number(l.leads ?? 0);
    ads.add(l.ad_id);
  }

  // Sobre os totais, nunca a média dos CPLs individuais.
  const cplMedio = leads > 0 ? Math.floor(gasto / leads) : null;

  return { gasto, leads, anuncios: ads.size, cplMedio };
}

export async function gastoPorDia(dias: number): Promise<PontoDia[]> {
  const linhas = await linhasDoPeriodo(dias);

  const porDia = new Map<string, number>();
  for (const l of linhas) {
    const d = String(l.dia).slice(0, 10);
    porDia.set(d, (porDia.get(d) ?? 0) + Number(l.gasto_centavos));
  }

  return [...porDia.entries()]
    .map(([dia, gasto]) => ({ dia, gasto }))
    .sort((a, b) => a.dia.localeCompare(b.dia));
}

export async function anuncios(dias: number): Promise<LinhaAnuncio[]> {
  const linhas = await linhasDoPeriodo(dias);

  const porAd = new Map<string, LinhaAnuncio>();
  for (const l of linhas) {
    const atual = porAd.get(l.ad_id) ?? {
      adId: l.ad_id,
      nome: l.ad_name,
      campanha: l.campaign_name,
      conta: l.act_id,
      destino: l.destination_type,
      gasto: 0,
      leads: 0,
      cpl: null,
    };
    atual.gasto += Number(l.gasto_centavos);
    atual.leads += Number(l.leads ?? 0);
    // O nome chega pelo enriquecimento e pode faltar em algumas linhas do
    // mesmo anúncio; a primeira que tiver vale.
    atual.nome ??= l.ad_name;
    atual.campanha ??= l.campaign_name;
    atual.conta ??= l.act_id;
    porAd.set(l.ad_id, atual);
  }

  return [...porAd.values()]
    .map((a) => ({
      ...a,
      // Nulo quando não há lead — nunca infinito, nunca divisão por zero.
      cpl: a.leads > 0 ? Math.floor(a.gasto / a.leads) : null,
    }))
    .sort((a, b) => b.gasto - a.gasto);
}

/** Carimbo de "atualizado às", ignorando as execuções de carga histórica. */
export async function ultimaAtualizacao(): Promise<string | null> {
  const db = servidor();
  const { data } = await db
    .from("sync_runs")
    .select("iniciado_em")
    .in("tipo", ["recorrente", "manual"])
    .eq("status", "ok")
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.iniciado_em ?? null;
}
```

- [ ] **Passo 5: Rodar e confirmar que passa**

```bash
cd painel && npm test
```

Esperado: 24 testes passando (15 de formato + 9 de consultas).

- [ ] **Passo 6: Conferir contra o SQL direto**

```bash
cd /Users/victorhugosantanaalmeida/Clientes-Victor-Tráfego
set -a && . ./.env && set +a
python3 -c "
import sys; sys.path.insert(0,'scripts')
from run_pgtap import carregar_env, executar
carregar_env()
ok, r = executar('''select sum(gasto_centavos)::bigint gasto, sum(leads)::bigint leads,
  count(distinct ad_id)::int anuncios
  from desempenho_por_anuncio
 where dia >= (now() at time zone 'UTC')::date - 90''')
print('  SQL direto:', r[0])
"
```

Compare com o que o teste `resumo` viu. Divergência aqui significa que a
agregação no TypeScript não reproduz a do Postgres.

O corte usa `(now() at time zone 'UTC')::date` e não `current_date` de
propósito: `desde()` no TypeScript calcula em UTC, e `current_date` segue o
fuso do banco. Perto da virada do dia os dois discordam de um dia inteiro,
e a divergência pareceria erro de agregação quando é só de referencial.

> **Sobre o `cache` do React:** ele deduplica por renderização, não entre
> requisições. Nos testes do Vitest, cada chamada busca de novo — é por
> isso que as asserções que cruzam `resumo` com `gastoPorDia` provam algo:
> elas comparam duas leituras independentes do banco, não a mesma leitura
> devolvida duas vezes.

- [ ] **Passo 7: Commit**

```bash
cd /Users/victorhugosantanaalmeida/Clientes-Victor-Tráfego
git add painel/src/lib/consultas.ts painel/tests/consultas.test.ts \
        painel/tests/setup.ts painel/vitest.config.ts \
        painel/package.json painel/package-lock.json
git commit -m "As tres consultas do painel, conferidas contra o banco

Os testes rodam contra o banco de verdade, sem duble: o que se quer
provar e que a agregacao em TypeScript bate com a que o Postgres
faria, e um mock provaria so que o mock concorda consigo mesmo.

Tres assercoes cruzam os numeros entre si — a soma dos dias e a soma
dos anuncios precisam bater com o card do topo. Se o card divergir do
grafico, ninguem confia em nenhum dos dois.

CPL medio sai dos totais, nunca da media dos CPLs. E anuncio sem lead
tem cpl nulo, nunca infinito."
```

---

### Tarefa 4: Tokens do design system e os cards

**Arquivos:**
- Modificar: `painel/src/app/globals.css`
- Modificar: `painel/src/app/layout.tsx`
- Criar: `painel/src/componentes/Cards.tsx`
- Criar: `painel/src/componentes/AvisoCaptura.tsx`
- Modificar: `painel/src/app/page.tsx`

**Interfaces:**
- Consome: `resumo`, `Resumo` (Tarefa 3); `reais`, `numero` (Tarefa 2).
- Produz: `<Cards resumo={...} />`, `<AvisoCaptura desde="2026-09-18" />`.

- [ ] **Passo 1: Escrever os tokens**

Substituir `painel/src/app/globals.css`:

```css
/*
 * Tokens do design system: escuro, azul como destaque, cards densos.
 *
 * O azul #3B82F6 foi validado contra a superficie escura: passa na faixa
 * de luminosidade, no piso de croma e no contraste. Nao troque por outro
 * sem revalidar.
 */
:root {
  --fundo: #0a0a0b;
  --superficie: #141416;
  --superficie-alta: #1c1c20;
  --borda: #26262b;

  --texto: #f4f4f5;
  --texto-secundario: #a1a1aa;
  --texto-fraco: #6b6b73;

  --azul: #3b82f6;
  --azul-fraco: #1e3a8a;

  --positivo: #22c55e;
  --negativo: #ef4444;

  --raio: 12px;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--fundo);
  color: var(--texto);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.cartao {
  background: var(--superficie);
  border: 1px solid var(--borda);
  border-radius: var(--raio);
  padding: 20px;
}

/* Tabular para numero: sem isso as colunas dancam a cada atualizacao. */
.numero { font-variant-numeric: tabular-nums; }
```

- [ ] **Passo 2: Escrever o componente dos cards**

Criar `painel/src/componentes/Cards.tsx`:

```tsx
import type { Resumo } from "@/lib/consultas";
import { numero, reais } from "@/lib/formato";

function Cartao({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="cartao">
      <div style={{
        color: "var(--texto-fraco)",
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}>
        {rotulo}
      </div>
      <div className="numero" style={{ fontSize: 28, fontWeight: 600, marginTop: 8 }}>
        {valor}
      </div>
    </div>
  );
}

export function Cards({ resumo }: { resumo: Resumo }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
      gap: 16,
    }}>
      <Cartao rotulo="Gasto" valor={reais(resumo.gasto)} />
      <Cartao rotulo="Leads" valor={numero(resumo.leads)} />
      <Cartao rotulo="Custo por lead" valor={reais(resumo.cplMedio)} />
      <Cartao rotulo="Anúncios" valor={numero(resumo.anuncios)} />
    </div>
  );
}
```

- [ ] **Passo 3: Escrever o aviso**

Criar `painel/src/componentes/AvisoCaptura.tsx`:

```tsx
import { diaCurto } from "@/lib/formato";

/**
 * Explica por que quase nenhum anúncio tem custo por lead.
 *
 * O gasto tem 90 dias de histórico porque veio da Meta; lead só existe a
 * partir do dia em que a captura entrou no ar, e a Meta não guarda quem
 * mandou mensagem antes disso.
 *
 * Sem este aviso, o operador vê centenas de linhas sem CPL e a primeira
 * hipótese é que o cruzamento quebrou — quando o dado é que está
 * começando.
 */
export function AvisoCaptura({ desde }: { desde: string }) {
  return (
    <div style={{
      background: "var(--superficie-alta)",
      border: "1px solid var(--borda)",
      borderLeft: "3px solid var(--azul)",
      borderRadius: "var(--raio)",
      padding: "12px 16px",
      color: "var(--texto-secundario)",
      fontSize: 13,
    }}>
      Captura de leads ativa desde <strong style={{ color: "var(--texto)" }}>
      {diaCurto(desde)}</strong>. O gasto tem histórico maior porque vem da
      Meta — custo por lead só existe a partir dessa data.
    </div>
  );
}
```

- [ ] **Passo 4: Montar na página**

Substituir `painel/src/app/page.tsx`:

```tsx
import { Cards } from "@/componentes/Cards";
import { AvisoCaptura } from "@/componentes/AvisoCaptura";
import { resumo } from "@/lib/consultas";

export const dynamic = "force-dynamic";

export default async function Pagina() {
  const r = await resumo(90);

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: 32 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 24 }}>
        Track Machine
      </h1>

      <div style={{ display: "grid", gap: 20 }}>
        <AvisoCaptura desde="2026-09-18" />
        <Cards resumo={r} />
      </div>
    </main>
  );
}
```

- [ ] **Passo 5: Olhar**

```bash
cd painel && npm run dev
```

Abra `localhost:3000`. Esperado: quatro cards com os números do período de
90 dias, e o aviso acima deles. Confira que o gasto bate com o card.

- [ ] **Passo 6: Commit**

```bash
cd /Users/victorhugosantanaalmeida/Clientes-Victor-Tráfego
git add painel/src/app/globals.css painel/src/app/page.tsx \
        painel/src/componentes/Cards.tsx painel/src/componentes/AvisoCaptura.tsx
git commit -m "Cards do topo e o aviso sobre o inicio da captura

O aviso nao e enfeite: quase nenhum anuncio tem custo por lead
porque a captura entrou no ar em 18/09 e a Meta nao guarda quem
mandou mensagem antes. Sem explicar isso na tela, o operador ve
centenas de linhas sem CPL e conclui que o cruzamento quebrou.

Numero em fonte tabular porque sem isso as colunas dancam a cada
atualizacao."
```

---

### Tarefa 5: Gráfico de gasto por dia

**Arquivos:**
- Criar: `painel/src/componentes/GraficoGasto.tsx`
- Modificar: `painel/src/app/page.tsx`

**Interfaces:**
- Consome: `PontoDia`, `gastoPorDia` (Tarefa 3); `reais`, `diaCurto` (Tarefa 2).
- Produz: `<GraficoGasto pontos={PontoDia[]} />` — componente de cliente.

**As regras que este gráfico segue**, e que não são preferência:

- **Série única, sem legenda.** O título nomeia. Caixa de legenda para uma
  série só é ruído.
- **Eixo único.** Nunca dois eixos y — é o erro nº 1 em gráfico.
- **Linha de 2px, grade recessiva.** A grade orienta, não compete.
- **Texto em cor de texto, nunca na cor da série.** A cor pertence à marca,
  não ao rótulo.
- **Camada de hover por padrão.** Gráfico em SVG é interativo; crosshair e
  tooltip não são extra.
- **`#3B82F6` foi validado** contra a superfície escura — passa na faixa de
  luminosidade, no piso de croma e no contraste. Trocar exige revalidar.

- [ ] **Passo 1: Escrever o componente**

Criar `painel/src/componentes/GraficoGasto.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { PontoDia } from "@/lib/consultas";
import { diaCurto, reais } from "@/lib/formato";

const L = 8, R = 8, T = 12, B = 22;   // margens internas
const ALT = 160;

export function GraficoGasto({ pontos }: { pontos: PontoDia[] }) {
  const [ativo, setAtivo] = useState<number | null>(null);

  if (pontos.length === 0) {
    return (
      <div className="cartao" style={{ color: "var(--texto-fraco)" }}>
        Sem gasto no período.
      </div>
    );
  }

  const larg = 1000;
  const maximo = Math.max(...pontos.map((p) => p.gasto), 1);
  const passo = pontos.length > 1 ? (larg - L - R) / (pontos.length - 1) : 0;

  const x = (i: number) => L + i * passo;
  const y = (v: number) => T + (ALT - T - B) * (1 - v / maximo);

  const linha = pontos.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.gasto)}`).join(" ");
  const area = `${linha} L${x(pontos.length - 1)},${ALT - B} L${x(0)},${ALT - B} Z`;

  const p = ativo !== null ? pontos[ativo] : null;

  return (
    <div className="cartao">
      <div style={{
        color: "var(--texto-fraco)",
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        marginBottom: 4,
      }}>
        Gasto por dia
      </div>

      {/* Reserva a altura do tooltip para o gráfico não pular no hover */}
      <div className="numero" style={{ height: 22, fontSize: 14 }}>
        {p ? (
          <span>
            <span style={{ color: "var(--texto)" }}>{reais(p.gasto)}</span>
            <span style={{ color: "var(--texto-fraco)", marginLeft: 8 }}>
              {diaCurto(p.dia)}
            </span>
          </span>
        ) : (
          <span style={{ color: "var(--texto-fraco)" }}>
            passe o mouse para ver o dia
          </span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${larg} ${ALT}`}
        style={{ width: "100%", height: ALT, display: "block" }}
        onMouseLeave={() => setAtivo(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * larg;
          const i = Math.round((px - L) / (passo || 1));
          setAtivo(Math.min(Math.max(i, 0), pontos.length - 1));
        }}
      >
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Grade recessiva: orienta sem competir com a série */}
        {[0, 0.5, 1].map((f) => (
          <line key={f}
            x1={L} x2={larg - R}
            y1={y(maximo * f)} y2={y(maximo * f)}
            stroke="var(--borda)" strokeWidth="1" />
        ))}

        <path d={area} fill="url(#g)" />
        <path d={linha} fill="none" stroke="#3b82f6" strokeWidth="2"
              strokeLinejoin="round" strokeLinecap="round" />

        {ativo !== null && (
          <g>
            <line x1={x(ativo)} x2={x(ativo)} y1={T} y2={ALT - B}
                  stroke="var(--texto-fraco)" strokeWidth="1" />
            {/* Anel da cor da superfície separa a marca da linha */}
            <circle cx={x(ativo)} cy={y(pontos[ativo].gasto)} r="4"
                    fill="#3b82f6" stroke="var(--superficie)" strokeWidth="2" />
          </g>
        )}
      </svg>

      <div style={{
        display: "flex",
        justifyContent: "space-between",
        color: "var(--texto-fraco)",
        fontSize: 11,
        marginTop: -14,
      }}>
        <span>{diaCurto(pontos[0].dia)}</span>
        <span>{diaCurto(pontos[pontos.length - 1].dia)}</span>
      </div>
    </div>
  );
}
```

- [ ] **Passo 2: Montar na página**

Em `painel/src/app/page.tsx`, acrescentar o import e o componente:

```tsx
import { GraficoGasto } from "@/componentes/GraficoGasto";
import { gastoPorDia, resumo } from "@/lib/consultas";
```

E dentro do `Pagina`, buscar os dois em paralelo e renderizar:

```tsx
  const [r, pontos] = await Promise.all([resumo(90), gastoPorDia(90)]);
```

```tsx
        <Cards resumo={r} />
        <GraficoGasto pontos={pontos} />
```

- [ ] **Passo 3: Olhar e conferir**

```bash
cd painel && npm run dev
```

Confira três coisas na tela:

1. O pico do gráfico corresponde ao dia de maior gasto
2. Passar o mouse mostra valor e dia, e o gráfico **não pula** de altura
3. A linha tem 2px e a grade é mais fraca que ela

- [ ] **Passo 4: Commit**

```bash
cd /Users/victorhugosantanaalmeida/Clientes-Victor-Tráfego
git add painel/src/componentes/GraficoGasto.tsx painel/src/app/page.tsx
git commit -m "Grafico de gasto por dia, em SVG inline

Sem biblioteca de grafico: uma serie temporal com area e crosshair
cabe em SVG, e a dependencia custaria mais que o codigo.

Serie unica nao leva legenda — o titulo nomeia, e caixa de legenda
para uma serie e ruido. Eixo unico, linha de 2px, grade recessiva, e
texto em cor de texto, nunca na cor da serie.

A altura do tooltip e reservada mesmo sem hover: sem isso o grafico
pula quando o mouse entra, e movimento que nao significa nada tira a
atencao do que significa.

O azul foi validado contra a superficie escura antes de entrar."
```

---

### Tarefa 6: Tabela de anúncios

**Arquivos:**
- Criar: `painel/src/componentes/TabelaAnuncios.tsx`
- Modificar: `painel/src/app/page.tsx`

**Interfaces:**
- Consome: `LinhaAnuncio`, `anuncios` (Tarefa 3); `reais`, `numero` (Tarefa 2).
- Produz: `<TabelaAnuncios linhas={LinhaAnuncio[]} />`.

- [ ] **Passo 1: Escrever o componente**

Criar `painel/src/componentes/TabelaAnuncios.tsx`:

```tsx
import type { CSSProperties } from "react";
import type { LinhaAnuncio } from "@/lib/consultas";
import { numero, reais } from "@/lib/formato";

/**
 * Qual métrica faz sentido para cada tipo de campanha.
 *
 * Campanha de visita ao perfil não tem lead por definição — mostrar "0
 * leads" nela sugeriria fracasso onde não há nada a medir. `WHATSAPP` e
 * `MESSAGING_INSTAGRAM_DIRECT_WHATSAPP` são as que geram lead.
 */
function geraLead(destino: string | null): boolean {
  return destino === "WHATSAPP" ||
    destino === "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP";
}

const th: CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  color: "var(--texto-fraco)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontWeight: 500,
  borderBottom: "1px solid var(--borda)",
};

const td: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--borda)",
};

export function TabelaAnuncios({ linhas }: { linhas: LinhaAnuncio[] }) {
  return (
    <div className="cartao" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px 8px" }}>
        <span style={{
          color: "var(--texto-fraco)",
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}>
          Anúncios
        </span>
        <span style={{ color: "var(--texto-fraco)", fontSize: 11, marginLeft: 8 }}>
          {numero(linhas.length)} · por gasto
        </span>
      </div>

      {/* A tabela rola dentro do proprio cartao: sem isso a pagina inteira
          rola na horizontal em tela estreita. */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={th}>Anúncio</th>
              <th style={th}>Campanha</th>
              <th style={th}>Conta</th>
              <th style={{ ...th, textAlign: "right" }}>Gasto</th>
              <th style={{ ...th, textAlign: "right" }}>Leads</th>
              <th style={{ ...th, textAlign: "right" }}>CPL</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.adId}>
                <td style={td}>
                  {l.nome ?? (
                    <span style={{ color: "var(--texto-fraco)" }}>
                      {l.adId}
                    </span>
                  )}
                </td>
                <td style={{ ...td, color: "var(--texto-secundario)" }}>
                  {l.campanha ?? "—"}
                </td>
                {/* Sem esta coluna, dois anuncios homonimos em contas
                    diferentes viram duas linhas identicas no rotulo — e o
                    operador conclui que o painel duplicou. Acontece de
                    verdade: ha dois "ad01" na campanha VAGA. */}
                <td style={{ ...td, color: "var(--texto-fraco)", fontSize: 11 }}>
                  {l.conta?.replace(/^act_/, "") ?? "—"}
                </td>
                <td className="numero" style={{ ...td, textAlign: "right" }}>
                  {reais(l.gasto)}
                </td>
                <td className="numero" style={{
                  ...td,
                  textAlign: "right",
                  // Zero lead fica cinza, mas continua sendo um zero.
                  // "Gastou e nao trouxe ninguem" e a informacao que o
                  // operador mais precisa ver.
                  color: l.leads > 0 ? "var(--texto)" : "var(--texto-fraco)",
                }}>
                  {geraLead(l.destino) ? numero(l.leads) : "—"}
                </td>
                <td className="numero" style={{
                  ...td,
                  textAlign: "right",
                  color: l.cpl !== null ? "var(--texto)" : "var(--texto-fraco)",
                }}>
                  {l.cpl !== null ? reais(l.cpl) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Passo 2: Montar na página**

Acrescentar em `painel/src/app/page.tsx`:

```tsx
import { TabelaAnuncios } from "@/componentes/TabelaAnuncios";
import { anuncios, gastoPorDia, resumo } from "@/lib/consultas";
```

```tsx
  const [r, pontos, linhas] = await Promise.all([
    resumo(90), gastoPorDia(90), anuncios(90),
  ]);
```

```tsx
        <TabelaAnuncios linhas={linhas} />
```

- [ ] **Passo 3: Olhar e conferir**

Três coisas:

1. A primeira linha é a de maior gasto
2. Anúncio de campanha de mensagem sem lead mostra **`0`** em cinza, não um
   traço — traço significaria "não se aplica"
3. Campanha de visita ao perfil mostra traço nas duas colunas, porque lead
   não se aplica a ela
4. **Os dois `ad01` aparecem como linhas distintas, com contas diferentes.**
   São anúncios diferentes com o mesmo nome, um em cada conta — sem a
   coluna de conta pareceriam duplicação

- [ ] **Passo 4: Commit**

```bash
cd /Users/victorhugosantanaalmeida/Clientes-Victor-Tráfego
git add painel/src/componentes/TabelaAnuncios.tsx painel/src/app/page.tsx
git commit -m "Tabela de anuncios, distinguindo zero de nao se aplica

Anuncio de campanha de mensagem sem lead mostra 0 em cinza, nao um
traco: gastou e nao trouxe ninguem e a informacao que o operador mais
precisa ver, e traco leria como 'nao se aplica'.

Campanha de visita ao perfil mostra traco de verdade, porque lead nao
se aplica a ela — e destination_type e o que separa as duas, ja que o
objetivo e OUTCOME_ENGAGEMENT nas duas.

A tabela rola dentro do proprio cartao; sem isso a pagina inteira
rola na horizontal em tela estreita."
```

---

### Tarefa 7: Período e botão de atualizar

**Arquivos:**
- Criar: `painel/src/componentes/SeletorPeriodo.tsx`
- Criar: `painel/src/componentes/BotaoAtualizar.tsx`
- Criar: `painel/src/app/atualizar/route.ts`
- Modificar: `painel/src/app/page.tsx`

**Interfaces:**
- Consome: `ultimaAtualizacao` (Tarefa 3); `horaCurta` (Tarefa 2).
- Produz: `<SeletorPeriodo atual={number} />`, `<BotaoAtualizar em={string | null} />`,
  rota `POST /atualizar`.

- [ ] **Passo 1: Seletor de período**

Criar `painel/src/componentes/SeletorPeriodo.tsx`:

```tsx
import Link from "next/link";

const OPCOES = [7, 30, 90];

export function SeletorPeriodo({ atual }: { atual: number }) {
  return (
    <div style={{
      display: "inline-flex",
      background: "var(--superficie)",
      border: "1px solid var(--borda)",
      borderRadius: "var(--raio)",
      padding: 3,
      gap: 3,
    }}>
      {OPCOES.map((d) => (
        <Link
          key={d}
          href={`/?dias=${d}`}
          style={{
            padding: "5px 12px",
            borderRadius: 8,
            fontSize: 12,
            textDecoration: "none",
            background: d === atual ? "var(--azul)" : "transparent",
            color: d === atual ? "#fff" : "var(--texto-secundario)",
          }}
        >
          {d}d
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Passo 2: Rota que dispara a sincronização**

Criar `painel/src/app/atualizar/route.ts`:

```typescript
import { NextResponse } from "next/server";

/**
 * Dispara a sincronização manual da Fatia B1.
 *
 * A trava de 5 minutos por tenant vive no banco, não aqui: Edge Function
 * não guarda estado entre invocações. Quando ela recusa, a resposta traz
 * `pulado: "trava"` e quantos segundos faltam — e a tela mostra isso em
 * vez de fingir que atualizou.
 */
export async function POST() {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !chave) {
    return NextResponse.json(
      { erro: "Credenciais ausentes em .env.local" },
      { status: 500 },
    );
  }

  const r = await fetch(`${url}/functions/v1/sync-meta-insights`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${chave}`,
    },
    body: JSON.stringify({ tipo: "manual" }),
  });

  return NextResponse.json(await r.json(), { status: r.status });
}
```

- [ ] **Passo 3: Botão**

Criar `painel/src/componentes/BotaoAtualizar.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { horaCurta } from "@/lib/formato";

type Conta = { pulado?: string; faltam_segundos?: number; linhas?: number };

export function BotaoAtualizar({ em }: { em: string | null }) {
  const router = useRouter();
  const [rodando, setRodando] = useState(false);
  const [recado, setRecado] = useState<string | null>(null);

  async function atualizar() {
    setRodando(true);
    setRecado(null);
    try {
      const r = await fetch("/atualizar", { method: "POST" });
      const j = await r.json();

      const travadas = (j.contas ?? []).filter((c: Conta) => c.pulado === "trava");
      if (travadas.length > 0) {
        const s = Math.max(...travadas.map((c: Conta) => c.faltam_segundos ?? 0));
        // Dizer quanto falta e melhor que "tente de novo": a trava existe
        // para nao estourar a cota da Meta, e esconder o motivo faria o
        // operador clicar de novo achando que quebrou.
        setRecado(`aguarde ${Math.ceil(s / 60)} min`);
      } else {
        const linhas = (j.contas ?? [])
          .reduce((s: number, c: Conta) => s + (c.linhas ?? 0), 0);
        setRecado(`${linhas} linhas`);
        router.refresh();
      }
    } catch {
      setRecado("falhou");
    } finally {
      setRodando(false);
    }
  }

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span style={{ color: "var(--texto-fraco)", fontSize: 12 }}>
        {recado ?? `atualizado ${horaCurta(em)}`}
      </span>
      <button
        onClick={atualizar}
        disabled={rodando}
        style={{
          background: "var(--superficie)",
          border: "1px solid var(--borda)",
          borderRadius: "var(--raio)",
          color: rodando ? "var(--texto-fraco)" : "var(--texto)",
          padding: "6px 14px",
          fontSize: 12,
          cursor: rodando ? "default" : "pointer",
        }}
      >
        {rodando ? "atualizando…" : "↻ atualizar"}
      </button>
    </div>
  );
}
```

- [ ] **Passo 4: Ligar o período na página**

Substituir `painel/src/app/page.tsx`:

```tsx
import { AvisoCaptura } from "@/componentes/AvisoCaptura";
import { BotaoAtualizar } from "@/componentes/BotaoAtualizar";
import { Cards } from "@/componentes/Cards";
import { GraficoGasto } from "@/componentes/GraficoGasto";
import { SeletorPeriodo } from "@/componentes/SeletorPeriodo";
import { TabelaAnuncios } from "@/componentes/TabelaAnuncios";
import { anuncios, gastoPorDia, resumo, ultimaAtualizacao } from "@/lib/consultas";

export const dynamic = "force-dynamic";

export default async function Pagina(
  { searchParams }: { searchParams: Promise<{ dias?: string }> },
) {
  const { dias: bruto } = await searchParams;
  // Só 7, 30 e 90 são aceitos: qualquer outro valor na URL cairia em 90 em
  // silêncio, e o seletor mostraria um período diferente do exibido.
  const dias = [7, 30, 90].includes(Number(bruto)) ? Number(bruto) : 90;

  const [r, pontos, linhas, em] = await Promise.all([
    resumo(dias), gastoPorDia(dias), anuncios(dias), ultimaAtualizacao(),
  ]);

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: 32 }}>
      <header style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 24,
        gap: 16,
        flexWrap: "wrap",
      }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
          Track Machine
        </h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <SeletorPeriodo atual={dias} />
          <BotaoAtualizar em={em} />
        </div>
      </header>

      <div style={{ display: "grid", gap: 20 }}>
        <AvisoCaptura desde="2026-09-18" />
        <Cards resumo={r} />
        <GraficoGasto pontos={pontos} />
        <TabelaAnuncios linhas={linhas} />
      </div>
    </main>
  );
}
```

- [ ] **Passo 5: Exercitar tudo**

```bash
cd painel && npm run dev
```

Confira:

1. Trocar 7d / 30d / 90d muda **os três blocos juntos** — cards, gráfico e
   tabela
2. Clicar em atualizar traz o número de linhas e recarrega a tela
3. Clicar **de novo em seguida** mostra `aguarde 5 min`, não um erro
4. `localhost:3000/?dias=999` cai em 90 e o seletor mostra 90

- [ ] **Passo 6: Rodar os testes e o build**

```bash
cd painel && npm test && npm run build
```

Esperado: 18 testes passando e build sem erro. Se o build falhar com
`server-only`, algum componente de cliente está importando o servidor.

- [ ] **Passo 7: Escrever o README**

Criar `painel/README.md`:

```markdown
# Painel do Operador

Tela local para ver gasto, leads e custo por lead.

## Rodar

    npm install
    npm run dev

Abre em http://localhost:3000.

## ⚠️ Este painel não tem autenticação

Ele lê o banco com a chave de serviço, que ignora RLS e dá acesso total.
Isso é aceitável **porque roda só em localhost**.

**Não publique como está** e não rode com `-H 0.0.0.0`. O painel do
cliente, com link por tenant e JWT, é a segunda metade da Fatia B2.

## Variáveis

`.env.local` (fora do git) precisa de `SUPABASE_URL` e
`SUPABASE_SERVICE_ROLE_KEY`.
```

- [ ] **Passo 8: Commit**

```bash
cd /Users/victorhugosantanaalmeida/Clientes-Victor-Tráfego
git add painel/src/componentes/SeletorPeriodo.tsx \
        painel/src/componentes/BotaoAtualizar.tsx \
        painel/src/app/atualizar/route.ts \
        painel/src/app/page.tsx painel/README.md
git commit -m "Seletor de periodo e botao de atualizar

A trava de 5 minutos vive no banco, e o botao mostra quanto falta em
vez de so falhar: esconder o motivo faria o operador clicar de novo
achando que quebrou, e a trava existe justamente para nao estourar a
cota da Meta.

Periodo fora de 7/30/90 na URL cai em 90 de forma explicita. Sem
isso, ?dias=999 mostraria 90 dias com o seletor marcando outra coisa.

O README avisa que o painel nao tem autenticacao e nao deve ser
publicado: hoje a unica coisa que o protege e ser localhost."
```

---

## Ordem de Execução

```
Tarefa 1  projeto e conexão       ← precisa vir primeiro: cria painel/
Tarefa 2  formatação              ─┐ as duas criam arquivos dentro de
Tarefa 3  consultas               ─┘ painel/, e a 3 usa servidor() da 1
Tarefa 4  tokens e cards          ← depende de 2 e 3
Tarefa 5  gráfico                 ─┐ tocam arquivos diferentes, mas as
Tarefa 6  tabela                  ─┘ duas modificam page.tsx
Tarefa 7  período e atualizar     ← depende de todas
```

**Nada roda antes da Tarefa 1**, porque é ela que cria o diretório
`painel/` com `package.json` — sem ele não há onde instalar o Vitest nem
onde colocar `src/lib/`.

Depois dela, **as Tarefas 2 e 3 podem rodar em paralelo** — a 2 é módulo
puro, a 3 fala com o banco.

> **Mas elas não são inteiramente independentes**, e isso custou confusão
> na primeira execução: as duas mexem em `package.json`,
> `package-lock.json` e `vitest.config.ts`. Quem commitar primeiro leva
> junto o que a outra já tiver instalado.
>
> Pior: o `vitest.config.ts` da Tarefa 2 referencia `./tests/setup.ts`, que
> só chega no commit da Tarefa 3. **Entre os dois commits, um checkout
> limpo não roda os testes.** Não quebra nada em sequência, mas quem
> bisecar o histórico ali vai encontrar um estado que não funciona.
>
> Rodar as duas em sequência evita isso inteiro. Em paralelo, ganha-se
> tempo e paga-se com um commit intermediário quebrado.

As Tarefas 5 e 6 também podem, com uma ressalva: **as duas modificam
`page.tsx`**. Quem chegar em segundo precisa reler o arquivo antes de
editar, ou vai sobrescrever o import da outra.

## Cobertura da Spec

| Seção da spec | Tarefa |
|---|---|
| 5 Arquitetura (Server Components, service_role) | 1 |
| 6 A tela — cards | 4 |
| 6 A tela — gráfico | 5 |
| 6 A tela — tabela | 6 |
| 6 A tela — período e atualizar | 7 |
| 7 O problema do CPL ausente | 4 (aviso) e 6 (zero vs traço) |
| 8 Consultas | 3 |
| 9 Segurança | 1 (`server-only`, `.gitignore`) e 7 (README) |
| 10 Testes | 2 e 3 |
