import { describe, expect, it } from "vitest";
import {
  anuncios,
  gastoPorDia,
  inicioDaCaptura,
  resumo,
  ultimaAtualizacao,
} from "@/lib/consultas";
import { servidor } from "@/lib/supabase";

// Estes testes rodam contra o banco de verdade. Não há dublê aqui de
// propósito: o que se quer provar é que a agregação no TypeScript bate
// com a que o Postgres faria — e um mock provaria só que o mock concorda
// consigo mesmo.

// Cada caso lê alguns milhares de linhas pela rede, às vezes duas vezes
// para cruzar dois números. Os 5s padrão do Vitest estouram nisso, e o
// timeout se disfarçaria de falha de agregação.
/**
 * Orçamento por teste, generoso de propósito.
 *
 * Esta suíte fala com o banco de produção pela rede: uma leitura completa
 * da view são 5 páginas de 1000 linhas, medidas em ~1,4s cada, e há caso
 * que faz duas leituras concorrentes. Com 30s o caso de `gastoPorDia` vs
 * `resumo` ficava em ~25s — passava quase sempre e falhava quando a rede
 * respirava, que é o pior dos mundos: vermelho intermitente ensina a
 * ignorar vermelho.
 *
 * Em produção o custo é outro: o `cache()` do React deduplica dentro do
 * mesmo request, então a página faz UMA leitura. Aqui cada teste chama as
 * funções isoladamente, de fora de um request, e nada deduplica.
 */
const TEMPO = 90_000;

describe("leitura do periodo", () => {
  it(
    "le a view inteira, nao so a primeira pagina do PostgREST",
    async () => {
      // O teto de 1000 linhas do PostgREST e do servidor, nao do pedido:
      // `.limit(50000)` e aceito sem reclamar e devolve 1000 mesmo assim.
      // Sem erro, sem aviso — um quarto da view com cara de view inteira.
      //
      // Nenhuma das somas cruzadas deste arquivo pega isso sozinha. Ler
      // menos linhas deixa o painel coerente CONSIGO MESMO: a soma dos
      // dias continua batendo com a soma dos anuncios, porque as duas
      // saem das mesmas 1000 linhas. Card, grafico e tabela concordam, e
      // os tres estao errados. (Medido: com a leitura truncada, 10 dos 11
      // casos deste arquivo continuavam verdes.)
      //
      // Por isso a ancora aqui e uma contagem exata do proprio banco, que
      // nao passa pelo caminho capaz de truncar.
      const db = servidor();
      const corte = new Date();
      corte.setUTCDate(corte.getUTCDate() - 90);
      const desde90 = corte.toISOString().slice(0, 10);

      const { count, error } = await db
        .from("desempenho_por_anuncio")
        .select("*", { count: "exact", head: true })
        .gte("dia", desde90);

      expect(error).toBeNull();
      // Se um dia o periodo couber numa pagina so, este teste deixa de
      // provar o que diz — e melhor ficar vermelho do que verde a toa.
      expect(count!).toBeGreaterThan(1000);

      // Releitura independente, paginada e conferida contra a contagem.
      let lidas = 0;
      let soma = 0;
      for (let de = 0; de < count!; de += 1000) {
        const { data } = await db
          .from("desempenho_por_anuncio")
          .select("gasto_centavos")
          .gte("dia", desde90)
          .order("dia", { ascending: true })
          .order("ad_id", { ascending: true })
          .range(de, de + 999);
        for (const l of data ?? []) {
          soma += Number(l.gasto_centavos);
          lidas++;
        }
      }
      expect(lidas).toBe(count);

      const r = await resumo(90);
      expect(r.gasto).toBe(soma);
    },
    TEMPO,
  );
});

describe("resumo", () => {
  it(
    "soma gasto e leads do periodo",
    async () => {
      const r = await resumo(90);
      expect(r.gasto).toBeGreaterThan(0);
      expect(r.anuncios).toBeGreaterThan(0);
      expect(Number.isInteger(r.gasto)).toBe(true);
      // O nome do teste promete leads, e sem estas duas linhas ele nunca
      // olhava para leads: `leads` poderia vir NaN — `Number(undefined)`
      // se a coluna fosse renomeada — e nada aqui reclamaria. NaN
      // contamina o CPL logo adiante e chega na tela como "—", que lê
      // como "ainda não há lead" em vez de "a consulta quebrou".
      expect(r.leads).toBeGreaterThan(0);
      expect(Number.isInteger(r.leads)).toBe(true);
    },
    TEMPO,
  );

  it(
    "calcula o CPL medio sobre os totais, nao como media de CPLs",
    async () => {
      // Somar medias produz numero errado. Com gasto G e leads L, o CPL
      // medio e G/L — e nunca a media dos G_i/L_i de cada anuncio.
      //
      // O G aqui e o gasto da janela em que ja havia captura, nao o do
      // periodo inteiro: ver "CPL sobre a janela de captura", no fim deste
      // arquivo, para por que os dois nao podem ser o mesmo numero.
      const r = await resumo(90);
      if (r.leads > 0) {
        expect(r.cplMedio).toBe(Math.floor(r.gastoComCaptura / r.leads));
      } else {
        expect(r.cplMedio).toBeNull();
      }
    },
    TEMPO,
  );

  it(
    "o CPL agregado difere mesmo da media dos CPLs neste periodo",
    async () => {
      // A asserção acima sozinha não prova nada sobre a regra que ela diz
      // defender: ela repete a fórmula da implementação. Se por acaso os
      // dois cálculos coincidissem nestes dados, trocar a implementação
      // pela média dos CPLs não faria teste nenhum ficar vermelho.
      //
      // Aqui se verifica que os dois números são de fato distinguíveis:
      // parte do gasto da janela de captura está em anúncios que não
      // trouxeram lead nenhum (medido em 23/09: R$ 110,82 dos R$ 323,86, um
      // terço), e esse gasto entra no agregado sem entrar em nenhum CPL
      // individual — então o agregado fica acima da média dos individuais.
      const [r, linhas] = await Promise.all([resumo(90), anuncios(90)]);
      const comLead = linhas.filter((l) => l.cpl !== null);
      expect(comLead.length).toBeGreaterThan(0);

      const mediaDosCpls =
        comLead.reduce((s, l) => s + l.cpl!, 0) / comLead.length;

      expect(r.cplMedio).not.toBe(Math.floor(mediaDosCpls));
      expect(r.cplMedio!).toBeGreaterThan(mediaDosCpls);
    },
    TEMPO,
  );

  it(
    "periodo menor traz menos gasto que periodo maior",
    async () => {
      const [sete, noventa] = await Promise.all([resumo(7), resumo(90)]);
      // `toBeLessThanOrEqual` sozinho passa de graça no pior caso: um
      // `desde()` que ignorasse o argumento devolveria os mesmos números
      // para 7 e para 90, e a igualdade satisfaz "menor ou igual". Como há
      // gasto de sobra fora da janela de 7 dias, a desigualdade aqui é
      // estrita — e é ela que prova que o corte olha para `dias`.
      expect(sete.gasto).toBeGreaterThan(0);
      expect(sete.gasto).toBeLessThan(noventa.gasto);
      expect(sete.anuncios).toBeLessThan(noventa.anuncios);
    },
    TEMPO,
  );
});

describe("gastoPorDia", () => {
  it(
    "devolve os dias em ordem crescente, um por dia",
    async () => {
      const pontos = await gastoPorDia(90);
      expect(pontos.length).toBeGreaterThan(1);
      const dias = pontos.map((p) => p.dia);
      expect([...dias].sort()).toEqual(dias);

      // Ordenação não enxerga duplicata: dois dias iguais ficam lado a
      // lado e continuam ordenados. Sem esta linha, uma agregação que
      // deixasse de agrupar — uma chave errada no Map — passaria pelo
      // teste acima, e o gráfico desenharia dois pontos sobre o mesmo dia.
      expect(new Set(dias).size).toBe(dias.length);

      // `dia` vem de uma coluna `date` e precisa chegar como YYYY-MM-DD.
      // Se viesse com hora, `diaCurto` fatiaria a string errada e a
      // ordenação alfabética deixaria de coincidir com a cronológica.
      for (const p of pontos) {
        expect(p.dia).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isInteger(p.gasto)).toBe(true);
        expect(p.gasto).toBeGreaterThanOrEqual(0);
      }
    },
    TEMPO,
  );

  it(
    "a soma dos dias bate com o gasto do resumo",
    async () => {
      // Se o card divergir do grafico, ninguem confia em nenhum dos dois.
      const [pontos, r] = await Promise.all([gastoPorDia(90), resumo(90)]);
      const soma = pontos.reduce((s, p) => s + p.gasto, 0);
      expect(soma).toBe(r.gasto);
    },
    TEMPO,
  );
});

describe("anuncios", () => {
  it(
    "vem ordenado por gasto decrescente",
    async () => {
      const linhas = await anuncios(90);
      expect(linhas.length).toBeGreaterThan(0);
      for (let i = 1; i < linhas.length; i++) {
        expect(linhas[i - 1].gasto).toBeGreaterThanOrEqual(linhas[i].gasto);
      }
    },
    TEMPO,
  );

  it(
    "anuncio sem lead tem cpl nulo e leads zero, nunca infinito",
    async () => {
      const linhas = await anuncios(90);
      const semLead = linhas.filter((l) => l.leads === 0);
      expect(semLead.length).toBeGreaterThan(0);
      for (const l of semLead) {
        expect(l.cpl).toBeNull();
        expect(Number.isFinite(l.gasto)).toBe(true);
      }

      // O filtro acima só olha para as linhas que já têm `leads === 0`.
      // Um CPL infinito, NaN ou fracionário nasceria justamente fora
      // desse recorte, e ninguém estava conferindo o outro lado: todo
      // CPL não nulo precisa ser inteiro, finito e sair dos totais
      // daquele anúncio.
      for (const l of linhas) {
        expect(Number.isInteger(l.leads)).toBe(true);
        expect(Number.isInteger(l.gasto)).toBe(true);
        if (l.cpl === null) {
          expect(l.leads).toBe(0);
        } else {
          expect(Number.isInteger(l.cpl)).toBe(true);
          expect(l.cpl).toBe(Math.floor(l.gasto / l.leads));
        }
      }
    },
    TEMPO,
  );

  it(
    "anuncios de contas diferentes com o mesmo nome sao linhas separadas",
    async () => {
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

      // Sem esta linha o teste inteiro era condicional: uma agregação por
      // nome não deixaria homônimo nenhum de pé, `homonimos` viria vazio,
      // o `if` seria pulado e o teste passaria verde justamente no caso
      // que ele existe para pegar.
      expect(homonimos.length).toBeGreaterThan(0);

      const comNomeRepetido = linhas.filter(
        (l) => l.nome && porNome.get(l.nome)! > 1,
      );

      // O plano pedia `conta` nao nula em todo homonimo. Contra o banco
      // real isso e falso, e nao por erro de agregacao: 42 dos 840
      // anuncios estao em `ad_metadata_cache` sem `act_id` — o
      // enriquecimento gravou a linha sem a conta. A funcao devolve o nulo
      // que o banco tem, que e a leitura honesta.
      //
      // O que da para exigir aqui e que a busca da conta funcione. Se ela
      // quebrasse — tabela errada, coluna errada, join pelo campo errado —
      // TODA linha viria sem conta, e a coluna da tabela viraria uma fila
      // de tracos sem nenhum erro no console. O teto abaixo pega esse caso
      // sem travar no numero exato de hoje, que muda a cada sincronizacao.
      const semConta = linhas.filter((l) => l.conta === null);
      expect(semConta.length).toBeLessThan(linhas.length * 0.1);
      expect(comNomeRepetido.length).toBeGreaterThan(0);

      // E o caso que dá nome ao teste: pelo menos um nome repetido tem de
      // aparecer em mais de uma conta. É o que separa "o mesmo anúncio
      // contado duas vezes" de "dois anúncios diferentes que se chamam
      // igual" — e só a segunda leitura está certa.
      const contasPorNome = new Map<string, Set<string>>();
      for (const l of comNomeRepetido) {
        if (!l.nome || !l.conta) continue;
        const contas = contasPorNome.get(l.nome) ?? new Set<string>();
        contas.add(l.conta);
        contasPorNome.set(l.nome, contas);
      }
      const cruzamContas = [...contasPorNome.values()].filter((c) => c.size > 1);
      expect(cruzamContas.length).toBeGreaterThan(0);

      // O par documentado no plano, conferido de perto: dois `ad01`,
      // mesmo nome, mesma campanha, contas diferentes, linhas separadas.
      const adZeroUm = linhas.filter((l) => l.nome === "ad01");
      expect(adZeroUm.length).toBe(2);
      expect(new Set(adZeroUm.map((l) => l.adId)).size).toBe(2);
      expect(new Set(adZeroUm.map((l) => l.conta)).size).toBe(2);
      for (const l of adZeroUm) {
        expect(l.conta).not.toBeNull();
        expect(l.campanha).toBe("VAGA");
      }

      // E os ad_id continuam unicos, aconteca o que acontecer com os nomes.
      const ids = linhas.map((l) => l.adId);
      expect(new Set(ids).size).toBe(ids.length);
    },
    TEMPO,
  );

  it(
    "a soma dos anuncios bate com o gasto do resumo",
    async () => {
      const [linhas, r] = await Promise.all([anuncios(90), resumo(90)]);
      const soma = linhas.reduce((s, l) => s + l.gasto, 0);
      expect(soma).toBe(r.gasto);
      // O card conta anúncios distintos por um caminho (um Set em
      // `resumo`) e a tabela por outro (as chaves do Map em `anuncios`).
      // Divergir aqui significa que um dos dois perdeu linha pelo caminho.
      expect(linhas.length).toBe(r.anuncios);
      const somaLeads = linhas.reduce((s, l) => s + l.leads, 0);
      expect(somaLeads).toBe(r.leads);
    },
    TEMPO,
  );
});

describe("ultimaAtualizacao", () => {
  it(
    "devolve um carimbo de tempo real, nao nulo por engano",
    async () => {
      // Esta função não tinha teste, e o modo dela falhar é silencioso:
      // tabela errada, coluna errada ou um valor de `tipo`/`status` que
      // não existe devolvem `null` sem erro nenhum, e a tela mostra "—"
      // para sempre — que é indistinguível de "nunca sincronizou".
      const em = await ultimaAtualizacao();
      expect(em).not.toBeNull();
      expect(Number.isNaN(new Date(em!).getTime())).toBe(false);
    },
    TEMPO,
  );
});

// ---------------------------------------------------------------------------
// A janela de captura.
//
// O gasto tem 90 dias porque veio de um backfill da Meta; lead so existe a
// partir do dia em que a captura entrou no ar. Dividir um pelo outro mistura
// duas janelas e produz um CPL ~97x maior que o real. Medido em 23/09:
// R$ 31.459,21 / 29 = R$ 1.084,80 contra R$ 323,86 / 29 = R$ 11,16.
// ---------------------------------------------------------------------------

/** O mesmo corte que `desde()` faz na implementacao — em UTC, nao local. */
function desdeUTC(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/** Le uma janela curta da view inteira, provando que nao truncou. */
async function janela(desdeISO: string) {
  const db = servidor();
  const { data, count, error } = await db
    .from("desempenho_por_anuncio")
    .select("dia, gasto_centavos, leads", { count: "exact" })
    .gte("dia", desdeISO)
    .order("dia", { ascending: true })
    .order("ad_id", { ascending: true })
    .range(0, 999);

  expect(error).toBeNull();
  // Uma leitura truncada pelo teto de 1000 linhas do PostgREST daria um
  // total menor sem erro nenhum, e a conferencia abaixo compararia o
  // numero da implementacao com um numero igualmente errado.
  expect(count!).toBeLessThan(1000);
  expect(data!.length).toBe(count);

  const porDia = new Map<string, { gasto: number; leads: number }>();
  for (const l of data!) {
    const d = String(l.dia).slice(0, 10);
    const atual = porDia.get(d) ?? { gasto: 0, leads: 0 };
    atual.gasto += Number(l.gasto_centavos);
    atual.leads += Number(l.leads ?? 0);
    porDia.set(d, atual);
  }
  return porDia;
}

describe("CPL sobre a janela de captura", () => {
  it(
    "divide o gasto de quando ja havia captura, nao o do periodo inteiro",
    async () => {
      const r = await resumo(90);

      expect(r.inicioCaptura).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.leads).toBeGreaterThan(0);
      expect(Number.isInteger(r.gastoComCaptura)).toBe(true);

      expect(r.gastoComCaptura).toBeGreaterThan(0);
      // Invariante permanente: o numerador nunca passa do gasto do periodo.
      expect(r.gastoComCaptura).toBeLessThanOrEqual(r.gasto);

      // A assercao que vale sempre.
      expect(r.cplMedio).toBe(Math.floor(r.gastoComCaptura / r.leads));

      // A que distingue os dois numeros so vale enquanto houver gasto
      // anterior a captura. Escrita como `toBeLessThan(r.gasto)` fixo, ela
      // viraria vermelha sozinha por volta de 17/12/2026, quando a captura
      // completar 90 dias e as duas janelas convergirem: ninguem teria
      // mudado codigo, e o vermelho seria do calendario. Vermelho que chega
      // sem culpado ensina a ignorar vermelho.
      if (r.gastoComCaptura < r.gasto) {
        expect(r.cplMedio).not.toBe(Math.floor(r.gasto / r.leads));
        expect(r.cplMedio!).toBeLessThan(Math.floor(r.gasto / r.leads));
      } else {
        // Convergiram. Este caso deixou de distinguir numerador de
        // denominador, e nenhum outro teste desta suite distingue: trocar
        // `gastoComCaptura` por `gasto` em `resumo` passaria despercebido a
        // partir daqui. Se isso acontecer e o CPL ainda importar, o caminho
        // e injetar as linhas em `resumo` para poder testa-la com fixture.
        expect(r.gastoComCaptura).toBe(r.gasto);
      }
    },
    TEMPO,
  );

  it(
    "ancora a janela no primeiro dia com lead, conferido contra o banco",
    async () => {
      // A ancora nao pode sair do mesmo caminho que se quer conferir: aqui
      // ela vem de uma consulta independente, sem filtro de periodo.
      const db = servidor();
      const { data, error } = await db
        .from("desempenho_por_anuncio")
        .select("dia")
        .gt("leads", 0)
        .order("dia", { ascending: true })
        .limit(1);

      expect(error).toBeNull();
      expect(data!.length).toBe(1);
      const primeiro = String(data![0].dia).slice(0, 10);

      const r = await resumo(90);
      expect(r.inicioCaptura).toBe(primeiro);

      // E o numerador e de fato a soma do gasto a partir dessa data.
      const porDia = await janela(primeiro);
      const soma = [...porDia.values()].reduce((s, d) => s + d.gasto, 0);
      expect(r.gastoComCaptura).toBe(soma);
    },
    TEMPO,
  );

  it(
    "janela inteiramente dentro da captura nao tem ressalva nenhuma",
    async () => {
      // Quando o periodo pedido comeca DEPOIS do inicio da captura, gasto e
      // gasto-com-captura sao a mesma coisa, e a tela nao deve exibir
      // ressalva — ela seria ruido sobre uma janela que nao esta misturada.
      const r90 = await resumo(90);
      const inicio = r90.inicioCaptura!;

      // A maior janela cujo primeiro dia cai depois do inicio da captura.
      const hoje = new Date();
      const hojeUTC = Date.UTC(
        hoje.getUTCFullYear(),
        hoje.getUTCMonth(),
        hoje.getUTCDate(),
      );
      const dias =
        Math.round((hojeUTC - Date.parse(`${inicio}T00:00:00Z`)) / 86_400_000) -
        1;

      // Se a captura comecou ontem nao existe janela assim, e este caso
      // deixa de provar o que diz. Vermelho e melhor que verde a toa.
      expect(dias).toBeGreaterThanOrEqual(1);
      const corte = desdeUTC(dias);
      expect(corte > inicio).toBe(true);

      const porDia = await janela(corte);
      const ordenados = [...porDia.keys()].sort();
      const primeiroComLead = ordenados.find((d) => porDia.get(d)!.leads > 0);
      expect(primeiroComLead).toBeDefined();

      // O dente deste caso. Uma implementacao que ancorasse no primeiro dia
      // com lead DENTRO da janela — em vez do inicio real da captura —
      // jogaria fora o gasto destes dias e mostraria ressalva numa janela
      // que nao precisa de nenhuma. Sem gasto aqui, as duas implementacoes
      // coincidem e o caso passa sem exercer nada.
      const gastoAntes = ordenados
        .filter((d) => d < primeiroComLead!)
        .reduce((s, d) => s + porDia.get(d)!.gasto, 0);
      expect(gastoAntes).toBeGreaterThan(0);

      const r = await resumo(dias);
      expect(r.gasto).toBeGreaterThan(0);
      expect(r.leads).toBeGreaterThan(0);
      expect(r.gastoComCaptura).toBe(r.gasto);
      expect(r.cplMedio).toBe(Math.floor(r.gasto / r.leads));
      // A data continua vindo do dado, mesmo quando a janela nao a alcanca.
      expect(r.inicioCaptura).toBe(inicio);
    },
    TEMPO,
  );
});

describe("falha de leitura nao vira 'nao ha captura'", () => {
  it(
    "a consulta da ancora levanta quando o banco nao responde",
    async () => {
      // Lista vazia e a resposta legitima para "ainda nao houve lead". Um
      // erro de rede, de permissao ou de nome de coluna produz a MESMA lista
      // vazia se ninguem olhar para `error` — e ai o painel some com o aviso,
      // some com a ressalva, e volta a dividir os 90 dias de gasto pelos
      // leads de 5 dias. O numero errado de antes, agora sem nada na tela
      // explicando de onde veio.
      const url = process.env.SUPABASE_URL;
      // Porta 1 recusa conexao na hora; nao ha espera nem dependencia de rede.
      process.env.SUPABASE_URL = "http://127.0.0.1:1";
      try {
        await expect(inicioDaCaptura()).rejects.toThrow(/inicio da captura/i);
      } finally {
        process.env.SUPABASE_URL = url;
      }

      // E o env voltou: sem isto, um caso posterior herdaria a URL quebrada
      // e a falha apareceria longe da causa.
      expect(await inicioDaCaptura()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
    TEMPO,
  );
});
