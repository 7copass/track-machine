import { describe, expect, it } from "vitest";
import {
  anuncios,
  gastoPorDia,
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
const TEMPO = 30_000;

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
      const r = await resumo(90);
      if (r.leads > 0) {
        expect(r.cplMedio).toBe(Math.floor(r.gasto / r.leads));
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
      // a maior parte do gasto está em anúncios sem lead nenhum, então o
      // agregado é muito maior que a média dos CPLs individuais.
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
