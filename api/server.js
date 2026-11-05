import http from "node:http";
import crypto from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const required = ["DATABASE_URL", "FAMILY_CODE", "ADMIN_CODE", "ALLOWED_ORIGIN"];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`Variável de ambiente ausente: ${name}`);
    process.exit(1);
  }
}

const { DATABASE_URL, FAMILY_CODE, ADMIN_CODE } = process.env;
const PORT = Number(process.env.PORT || 8787);
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGIN.split(",").map((o) => o.trim());
const MIN_PARTICIPANTS = 3;
const MAX_BODY_BYTES = 10_000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const scrypt = promisify(crypto.scrypt);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS evento (
    id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    fase text NOT NULL DEFAULT 'cadastro' CHECK (fase IN ('cadastro', 'sorteado', 'revelado'))
  );
  INSERT INTO evento (id) VALUES (1) ON CONFLICT DO NOTHING;

  CREATE TABLE IF NOT EXISTS participantes (
    id serial PRIMARY KEY,
    nome text NOT NULL,
    nome_chave text NOT NULL UNIQUE,
    senha_hash text NOT NULL,
    livro text NOT NULL,
    bebida text NOT NULL,
    combo_id integer REFERENCES participantes (id),
    palpite_id integer REFERENCES participantes (id),
    criado_em timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sessoes (
    token_hash text PRIMARY KEY,
    participante_id integer NOT NULL REFERENCES participantes (id) ON DELETE CASCADE,
    criado_em timestamptz NOT NULL DEFAULT now()
  );
`;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- segurança ----------

const sha256 = (value) => crypto.createHash("sha256").update(value).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 32);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

async function checkPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), 32);
  return crypto.timingSafeEqual(derived, Buffer.from(hashHex, "hex"));
}

// Conta só tentativas erradas, para frear quem tenta adivinhar senhas curtas.
const failures = new Map();

function assertNotLocked(key, limit) {
  const entry = failures.get(key);
  if (!entry) return;
  if (Date.now() > entry.resetAt) failures.delete(key);
  else if (entry.count >= limit) {
    throw new ApiError(429, "Muitas tentativas erradas. Espere 15 minutos.");
  }
}

function recordFailure(key) {
  const entry = failures.get(key);
  if (entry && Date.now() <= entry.resetAt) entry.count += 1;
  else failures.set(key, { count: 1, resetAt: Date.now() + FAILURE_WINDOW_MS });
}

function clientIp(req) {
  // O Caddy acrescenta o IP real no fim da lista.
  const forwarded = req.headers["x-forwarded-for"];
  return forwarded ? forwarded.split(",").pop().trim() : req.socket.remoteAddress;
}

function assertSecret(req, provided, expected, message) {
  const key = `ip:${clientIp(req)}`;
  assertNotLocked(key, 20);
  if (!provided || !sameSecret(provided, expected)) {
    recordFailure(key);
    throw new ApiError(403, message);
  }
}

const assertFamily = (req, body) =>
  assertSecret(req, body.codigo, FAMILY_CODE, "Código da família incorreto.");
const assertAdmin = (req, body) =>
  assertSecret(req, body.codigoOrganizador, ADMIN_CODE, "Código do organizador incorreto.");

// ---------- validação ----------

function cleanText(value, label, max) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) throw new ApiError(400, `Preencha: ${label}.`);
  if (text.length > max) throw new ApiError(400, `${label} pode ter até ${max} caracteres.`);
  return text;
}

function cleanPassword(value) {
  if (typeof value !== "string" || value.length < 4 || value.length > 64) {
    throw new ApiError(400, "A senha precisa ter pelo menos 4 caracteres.");
  }
  return value;
}

function cleanId(value) {
  if (!Number.isInteger(value) || value < 1) throw new ApiError(400, "Pessoa inválida.");
  return value;
}

const nameKey = (name) =>
  name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

// ---------- sessões e fase ----------

async function createSession(participantId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO sessoes (token_hash, participante_id) VALUES ($1, $2)", [
    sha256(token).toString("hex"),
    participantId,
  ]);
  return token;
}

async function currentUser(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token) throw new ApiError(401, "Entre novamente.");
  const { rows } = await pool.query(
    `SELECT p.* FROM sessoes s JOIN participantes p ON p.id = s.participante_id
     WHERE s.token_hash = $1`,
    [sha256(token).toString("hex")],
  );
  if (!rows[0]) throw new ApiError(401, "Entre novamente.");
  return rows[0];
}

async function currentPhase(client = pool) {
  const { rows } = await client.query("SELECT fase FROM evento WHERE id = 1");
  return rows[0].fase;
}

async function assertPhase(expected, message) {
  if ((await currentPhase()) !== expected) throw new ApiError(409, message);
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Trava o evento: dois sorteios simultâneos não podem se atropelar.
    await client.query("SELECT 1 FROM evento WHERE id = 1 FOR UPDATE");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function shuffled(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ---------- rotas ----------

async function buildState(user) {
  const fase = await currentPhase();
  const { rows } = await pool.query(
    "SELECT id, nome, livro, bebida, combo_id, palpite_id FROM participantes ORDER BY nome",
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const combo = user.combo_id ? byId.get(user.combo_id) : null;

  return {
    fase,
    eu: { id: user.id, nome: user.nome, livro: user.livro, bebida: user.bebida },
    participantes: rows.map(({ id, nome }) => ({ id, nome })),
    palpitesFeitos: rows.filter((row) => row.palpite_id).length,
    combo: combo ? { livro: combo.livro, bebida: combo.bebida } : null,
    palpiteId: user.palpite_id,
    revelacao:
      fase === "revelado"
        ? rows.map((row) => {
            const autor = byId.get(row.combo_id);
            const palpite = byId.get(row.palpite_id);
            return {
              livro: autor.livro,
              bebida: autor.bebida,
              autor: autor.nome,
              recebedor: row.nome,
              palpite: palpite ? palpite.nome : null,
              acertou: row.palpite_id === row.combo_id,
            };
          })
        : null,
  };
}

const routes = {
  "GET /health": async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  },

  "POST /api/cadastro": async (req, body) => {
    assertFamily(req, body);
    await assertPhase("cadastro", "O sorteio já aconteceu. Fale com o organizador.");
    const nome = cleanText(body.nome, "Nome", 60);
    const livro = cleanText(body.livro, "Livro", 200);
    const bebida = cleanText(body.bebida, "Bebida", 200);
    const senhaHash = await hashPassword(cleanPassword(body.senha));

    const { rows } = await pool.query(
      `INSERT INTO participantes (nome, nome_chave, senha_hash, livro, bebida)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (nome_chave) DO NOTHING RETURNING id`,
      [nome, nameKey(nome), senhaHash, livro, bebida],
    );
    if (!rows[0]) throw new ApiError(409, "Esse nome já está cadastrado. Use \"Já me cadastrei\".");
    return { token: await createSession(rows[0].id) };
  },

  "POST /api/entrar": async (req, body) => {
    assertFamily(req, body);
    const nome = cleanText(body.nome, "Nome", 60);
    const key = `nome:${nameKey(nome)}`;
    assertNotLocked(key, 5);

    const { rows } = await pool.query("SELECT id, senha_hash FROM participantes WHERE nome_chave = $1", [
      nameKey(nome),
    ]);
    const valid = rows[0] && (await checkPassword(String(body.senha ?? ""), rows[0].senha_hash));
    if (!valid) {
      recordFailure(key);
      throw new ApiError(403, "Nome ou senha incorretos.");
    }
    return { token: await createSession(rows[0].id) };
  },

  "GET /api/estado": async (req) => buildState(await currentUser(req)),

  "PUT /api/sugestao": async (req, body) => {
    const user = await currentUser(req);
    await assertPhase("cadastro", "O sorteio já aconteceu e a sugestão não muda mais.");
    await pool.query("UPDATE participantes SET livro = $1, bebida = $2 WHERE id = $3", [
      cleanText(body.livro, "Livro", 200),
      cleanText(body.bebida, "Bebida", 200),
      user.id,
    ]);
    return { ok: true };
  },

  "PUT /api/palpite": async (req, body) => {
    const user = await currentUser(req);
    await assertPhase("sorteado", "Os palpites não estão abertos agora.");
    const palpiteId = cleanId(body.participanteId);
    if (palpiteId === user.id) throw new ApiError(400, "O combo que saiu para você não é o seu.");
    const { rowCount } = await pool.query("SELECT 1 FROM participantes WHERE id = $1", [palpiteId]);
    if (!rowCount) throw new ApiError(400, "Pessoa inválida.");
    await pool.query("UPDATE participantes SET palpite_id = $1 WHERE id = $2", [palpiteId, user.id]);
    return { ok: true };
  },

  "POST /api/admin/sortear": async (req, body) => {
    assertAdmin(req, body);
    return inTransaction(async (client) => {
      if ((await currentPhase(client)) !== "cadastro") {
        throw new ApiError(409, "O sorteio já foi feito.");
      }
      const { rows } = await client.query("SELECT id FROM participantes");
      if (rows.length < MIN_PARTICIPANTS) {
        throw new ApiError(409, `São necessárias pelo menos ${MIN_PARTICIPANTS} pessoas.`);
      }
      // Um único círculo: ninguém tira o próprio combo nem forma dupla com outra pessoa.
      const circle = shuffled(rows.map((row) => row.id));
      for (const [index, id] of circle.entries()) {
        const comboId = circle[(index + 1) % circle.length];
        await client.query("UPDATE participantes SET combo_id = $1 WHERE id = $2", [comboId, id]);
      }
      await client.query("UPDATE evento SET fase = 'sorteado'");
      return { ok: true };
    });
  },

  "POST /api/admin/revelar": async (req, body) => {
    assertAdmin(req, body);
    return inTransaction(async (client) => {
      if ((await currentPhase(client)) !== "sorteado") {
        throw new ApiError(409, "A revelação só acontece depois do sorteio.");
      }
      await client.query("UPDATE evento SET fase = 'revelado'");
      return { ok: true };
    });
  },

  "POST /api/admin/refazer": async (req, body) => {
    assertAdmin(req, body);
    return inTransaction(async (client) => {
      await client.query("UPDATE participantes SET combo_id = NULL, palpite_id = NULL");
      await client.query("UPDATE evento SET fase = 'cadastro'");
      return { ok: true };
    });
  },

  "POST /api/admin/remover": async (req, body) => {
    assertAdmin(req, body);
    const id = cleanId(body.participanteId);
    return inTransaction(async (client) => {
      if ((await currentPhase(client)) !== "cadastro") {
        throw new ApiError(409, "Volte para o cadastro antes de remover alguém.");
      }
      await client.query("DELETE FROM participantes WHERE id = $1", [id]);
      return { ok: true };
    });
  },

  "POST /api/admin/trocar-senha": async (req, body) => {
    assertAdmin(req, body);
    const id = cleanId(body.participanteId);
    const senhaHash = await hashPassword(cleanPassword(body.senha));
    await pool.query("UPDATE participantes SET senha_hash = $1 WHERE id = $2", [senhaHash, id]);
    await pool.query("DELETE FROM sessoes WHERE participante_id = $1", [id]);
    return { ok: true };
  },
};

// ---------- servidor ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8"); // não quebra acentos divididos entre dois pacotes
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) reject(new ApiError(413, "Dados grandes demais."));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new ApiError(400, "Dados inválidos."));
      }
    });
    req.on("error", reject);
  });
}

function setCors(req, res) {
  const { origin } = req.headers;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

function send(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const { pathname } = new URL(req.url, "http://localhost");
  const route = routes[`${req.method} ${pathname}`];
  if (!route) {
    send(res, 404, { erro: "Rota não encontrada." });
    return;
  }

  try {
    const body = req.method === "GET" ? {} : await readBody(req);
    send(res, 200, await route(req, body));
  } catch (error) {
    if (error instanceof ApiError) {
      send(res, error.status, { erro: error.message });
    } else {
      console.error(error);
      send(res, 500, { erro: "Algo deu errado no servidor." });
    }
  }
});

await pool.query(SCHEMA);
server.listen(PORT, () => console.log(`API do amigo secreto na porta ${PORT}`));
