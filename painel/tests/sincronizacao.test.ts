import { describe, expect, it } from "vitest";
import { lerSincronizacao } from "@/lib/sincronizacao";

// A leitura da resposta do botão de atualizar, separada do botão.
//
// Isto é lógica de decisão, não desenho: dado o que a Edge Function
// respondeu, o que o operador lê e se a tela recarrega. Dentro do
// componente ela precisaria de DOM e de `fetch` para ser exercitada, e na
// prática não seria — que é como "0 linhas" acabaria aparecendo para uma
// resposta de erro sem ninguém notar.
//
// A regra que todos os casos abaixo servem: **sucesso silencioso é
// proibido**. Toda resposta que não sincronizou tem de dizer isso na tela.
// O contrário — o operador lê "12 linhas", conclui que atualizou, e toma
// decisão de verba sobre um número velho.

/** A forma que `sync-meta-insights` devolve quando tudo correu bem. */
function ok(contas: unknown) {
  return { ok: true, tipo: "manual", desde: "2026-09-17", ate: "2026-09-24", contas };
}

describe("quando a trava recusa", () => {
  it("diz quanto falta, em vez de dizer que atualizou", () => {
    const r = lerSincronizacao(200, ok([
      { act_id: "act_1", pulado: "trava", faltam_segundos: 250 },
    ]));

    expect(r).toEqual({ texto: "aguarde 5 min", atualizou: false });
  });

  it("arredonda para cima, e nunca para zero", () => {
    // `Math.ceil(0/60)` é 0, e "aguarde 0 min" manda o operador esperar
    // nada — ele clica de novo na hora e leva outra recusa. Piso de 1.
    expect(lerSincronizacao(200, ok([
      { act_id: "act_1", pulado: "trava", faltam_segundos: 1 },
    ])).texto).toBe("aguarde 1 min");

    expect(lerSincronizacao(200, ok([
      { act_id: "act_1", pulado: "trava", faltam_segundos: 0 },
    ])).texto).toBe("aguarde 1 min");

    expect(lerSincronizacao(200, ok([
      { act_id: "act_1", pulado: "trava" },
    ])).texto).toBe("aguarde 1 min");
  });

  it("usa a espera mais longa quando as contas discordam", () => {
    // Dizer 1 min quando uma das contas ainda tem 5 faria o operador
    // clicar de novo e levar outra recusa — a mensagem tem de cobrir a
    // última a liberar.
    expect(lerSincronizacao(200, ok([
      { act_id: "act_1", pulado: "trava", faltam_segundos: 40 },
      { act_id: "act_2", pulado: "trava", faltam_segundos: 280 },
    ])).texto).toBe("aguarde 5 min");
  });

  it("nao esconde a recusa atras do que as outras contas trouxeram", () => {
    // A trava é por tenant, então misturar é raro — mas é exatamente o caso
    // que a própria Edge Function chama de "meia verdade": parte
    // sincronizou, parte não, e mostrar só as linhas afirmaria um período
    // atualizado que não está.
    const r = lerSincronizacao(200, ok([
      { act_id: "act_1", linhas: 812, por_recorte: {}, erro: null },
      { act_id: "act_2", pulado: "trava", faltam_segundos: 120 },
    ]));

    expect(r.texto).toBe("812 linhas · aguarde 2 min");
    // Recarrega assim mesmo: uma das contas escreveu, e a tela está velha.
    expect(r.atualizou).toBe(true);
  });
});

describe("quando sincronizou", () => {
  it("soma as linhas das contas e manda recarregar", () => {
    const r = lerSincronizacao(200, ok([
      { act_id: "act_1", linhas: 812, por_recorte: {}, erro: null },
      { act_id: "act_2", linhas: 430, por_recorte: {}, erro: null },
    ]));

    expect(r).toEqual({ texto: "1242 linhas", atualizou: true });
  });

  it("zero linhas e um resultado legitimo quando as contas rodaram", () => {
    // Janela sem gasto novo devolve 0 de verdade. É diferente de "0" saído
    // de uma resposta de erro, que o caso de erro abaixo separa.
    expect(lerSincronizacao(200, ok([
      { act_id: "act_1", linhas: 0, por_recorte: {}, erro: null },
    ]))).toEqual({ texto: "0 linhas", atualizou: true });
  });
});

describe("quando nao deu certo", () => {
  it("mostra o erro da conta, e nao so as linhas que ela nao trouxe", () => {
    // `linhas: 0` com `erro` preenchido é o formato que a Edge Function usa
    // para token ausente. Ler só `linhas` mostraria "0 linhas" — indistin-
    // guível de "não havia o que buscar", que é o sintoma errado.
    const r = lerSincronizacao(200, ok([
      {
        act_id: "act_1", linhas: 0, por_recorte: {},
        erro: "token ausente: META_TOKEN nao esta no ambiente da funcao",
      },
    ]));

    expect(r.texto).toBe("0 linhas · 1 com erro");
    expect(r.atualizou).toBe(true);
  });

  it("resposta de erro nao vira '0 linhas'", () => {
    // O modo de falhar mais caro: `contas` ausente, a soma dá 0, e a tela
    // escreve "0 linhas" com ar de sucesso — sobre uma sincronização que
    // nem começou.
    const r = lerSincronizacao(500, {
      ok: false,
      erro: "falha ao listar contas: permission denied",
    });

    expect(r.atualizou).toBe(false);
    expect(r.texto).toContain("permission denied");
    expect(r.texto).not.toContain("linhas");
  });

  it("status de erro sem corpo util ainda reclama", () => {
    const r = lerSincronizacao(401, {});

    expect(r.atualizou).toBe(false);
    expect(r.texto).not.toContain("linhas");
    expect(r.texto).toContain("401");
  });

  it("nenhuma conta cadastrada nao e sucesso", () => {
    // Aqui `contas` é um NÚMERO, não uma lista: `{ ok: true, contas: 0,
    // motivo: "nenhuma cadastrada" }`. Tratar como lista estoura, e tratar
    // como lista vazia diria "0 linhas" — sucesso para uma varredura que
    // não tinha o que varrer.
    const r = lerSincronizacao(200, {
      ok: true, contas: 0, motivo: "nenhuma cadastrada",
    });

    expect(r.atualizou).toBe(false);
    expect(r.texto).toBe("nenhuma cadastrada");

    // E a lista vazia, pelo mesmo motivo: nenhuma conta rodou, então não há
    // linha nenhuma a anunciar.
    const vazia = lerSincronizacao(200, ok([]));
    expect(vazia.atualizou).toBe(false);
    expect(vazia.texto).not.toContain("linhas");
  });

  it("corpo que nao e objeto nao finge nada", () => {
    for (const corpo of [null, undefined, "Method Not Allowed", 42, []]) {
      const r = lerSincronizacao(200, corpo);
      expect(r.atualizou).toBe(false);
      expect(r.texto).not.toContain("linhas");
    }
  });
});
