// Teste de ponta a ponta. Use só contra um banco descartável: ele apaga o sorteio.
// Uso: API=http://localhost:8787 FAMILY_CODE=... ADMIN_CODE=... node test-e2e.mjs
import assert from "node:assert/strict";

const { API = "http://localhost:8787", FAMILY_CODE, ADMIN_CODE } = process.env;

async function call(method, path, { body, token, origin } = {}) {
  const response = await fetch(API + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, headers: response.headers, data: await response.json().catch(() => ({})) };
}

const admin = (action, extra = {}) =>
  call("POST", `/api/admin/${action}`, { body: { codigoOrganizador: ADMIN_CODE, ...extra } });
const state = async (token) => (await call("GET", "/api/estado", { token })).data;

const names = ["Ana", "Bia", "Caio", "Davi", "Edu"];
const people = [];

// Cadastro
assert.equal((await call("POST", "/api/cadastro", {
  body: { codigo: "errado", nome: "X", senha: "1234", livro: "l", bebida: "b" },
})).status, 403, "código da família errado é barrado");

for (const nome of names) {
  const result = await call("POST", "/api/cadastro", {
    body: { codigo: FAMILY_CODE, nome, senha: "1234", livro: `Livro de ${nome}`, bebida: `Bebida de ${nome}` },
  });
  assert.equal(result.status, 200, `cadastro de ${nome}`);
  people.push({ nome, token: result.data.token });
}

assert.equal((await call("POST", "/api/cadastro", {
  body: { codigo: FAMILY_CODE, nome: "  ÁNA ", senha: "1234", livro: "l", bebida: "b" },
})).status, 409, "nome repetido com acento e caixa diferentes é barrado");

const before = await state(people[0].token);
assert.equal(before.fase, "cadastro");
assert.equal(before.participantes.length, names.length);
assert.ok(!JSON.stringify(before).includes("Livro de Bia"), "sugestão alheia não vaza no cadastro");

assert.equal((await call("GET", "/api/estado")).status, 401, "estado exige sessão");
assert.equal((await call("POST", "/api/entrar", {
  body: { codigo: FAMILY_CODE, nome: "Ana", senha: "0000" },
})).status, 403, "senha errada é barrada");
assert.equal((await call("POST", "/api/entrar", {
  body: { codigo: FAMILY_CODE, nome: "ana", senha: "1234" },
})).status, 200, "login ignora caixa do nome");

assert.equal((await call("PUT", "/api/sugestao", {
  token: people[0].token, body: { livro: "Livro de Ana", bebida: "Bebida de Ana" },
})).status, 200, "edita a própria sugestão");

// CORS
const allowed = await call("GET", "/health", { origin: "http://localhost:5501" });
assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5501");
const blocked = await call("GET", "/health", { origin: "https://site-estranho.example" });
assert.equal(blocked.headers.get("access-control-allow-origin"), null, "origem estranha sem CORS");

// Sorteio, repetido para pegar azar: ninguém tira o próprio combo nem forma dupla
assert.equal((await call("POST", "/api/admin/sortear", {
  body: { codigoOrganizador: "errado" },
})).status, 403, "código do organizador errado é barrado");

for (let round = 0; round < 50; round += 1) {
  assert.equal((await admin("sortear")).status, 200);
  const owners = new Map();
  for (const person of people) {
    const { combo, eu } = await state(person.token);
    assert.notEqual(combo.livro, `Livro de ${eu.nome}`, "ninguém tira o próprio combo");
    owners.set(eu.nome, combo.livro.replace("Livro de ", ""));
  }
  assert.equal(new Set(owners.values()).size, names.length, "cada combo sai uma vez só");
  for (const [person, owner] of owners) {
    assert.notEqual(owners.get(owner), person, "sem pares recíprocos");
  }
  assert.equal((await admin("refazer")).status, 200);
}

assert.equal((await admin("sortear")).status, 200);
assert.equal((await admin("sortear")).status, 409, "não sorteia duas vezes");

// Depois do sorteio
const drawn = await state(people[0].token);
assert.equal(drawn.revelacao, null, "revelação fechada");
const text = JSON.stringify(drawn);
assert.equal(names.filter((nome) => text.includes(`Livro de ${nome}`)).length, 2, "só aparecem a própria sugestão e o combo sorteado");
assert.ok(!text.includes("combo_id") && !text.includes("autor"), "estado não diz de quem é o combo");
assert.equal((await call("PUT", "/api/sugestao", {
  token: people[0].token, body: { livro: "x", bebida: "y" },
})).status, 409, "sugestão travada depois do sorteio");
assert.equal((await call("POST", "/api/cadastro", {
  body: { codigo: FAMILY_CODE, nome: "Atrasado", senha: "1234", livro: "l", bebida: "b" },
})).status, 409, "cadastro fechado depois do sorteio");

// Palpites
const ids = new Map(drawn.participantes.map((person) => [person.nome, person.id]));
assert.equal((await call("PUT", "/api/palpite", {
  token: people[0].token, body: { participanteId: ids.get("Ana") },
})).status, 400, "não dá palpite em si mesmo");

const first = await state(people[1].token);
const rightOwner = first.combo.livro.replace("Livro de ", "");
assert.equal((await call("PUT", "/api/palpite", {
  token: people[1].token, body: { participanteId: ids.get(rightOwner) },
})).status, 200);

// Revelação
assert.equal((await admin("revelar")).status, 200);
const revealed = await state(people[0].token);
assert.equal(revealed.revelacao.length, names.length);
const bia = revealed.revelacao.find((item) => item.recebedor === "Bia");
assert.equal(bia.autor, rightOwner);
assert.equal(bia.acertou, true, "acerto é contado");
assert.equal(revealed.revelacao.filter((item) => item.acertou).length, 1, "sem palpite não conta acerto");
assert.equal((await call("PUT", "/api/palpite", {
  token: people[0].token, body: { participanteId: ids.get("Bia") },
})).status, 409, "palpite fechado depois da revelação");

// Organizador
assert.equal((await admin("trocar-senha", { participanteId: ids.get("Edu"), senha: "nova1" })).status, 200);
assert.equal((await call("GET", "/api/estado", { token: people[4].token })).status, 401, "troca derruba a sessão antiga");
assert.equal((await call("POST", "/api/entrar", {
  body: { codigo: FAMILY_CODE, nome: "Edu", senha: "nova1" },
})).status, 200, "entra com a senha nova");

assert.equal((await admin("remover", { participanteId: ids.get("Edu") })).status, 409, "só remove no cadastro");
assert.equal((await admin("refazer")).status, 200);
assert.equal((await admin("remover", { participanteId: ids.get("Edu") })).status, 200);
assert.equal((await state(people[0].token)).participantes.length, names.length - 1);

console.log("Todos os testes passaram.");
