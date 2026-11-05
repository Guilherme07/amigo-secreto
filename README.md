# Livro & Copo

Amigo secreto da família: cada pessoa sugere um livro e uma bebida, o sorteio distribui os combos e, na revelação, todos tentam adivinhar quem sugeriu o quê.

- `docs/index.html`: a página, publicada no GitHub Pages.
- `api/`: API pequena em Node que roda no VPS e fala com o Postgres.
- `deploy/install.sh`: instala a API no VPS, ao lado do Filatrix.

O navegador não conecta direto no Postgres. A página chama a API por HTTPS, e só a API conhece a senha do banco.

## Como funciona

1. **Cadastro:** cada pessoa entra com o código da família, cria uma senha e registra livro e bebida.
2. **Sorteio:** o organizador sorteia. Ninguém tira o próprio combo, e os combos formam um único círculo, sem duplas que trocam entre si.
3. **Palpites:** cada pessoa abre o combo que saiu para ela e escolhe quem acha que sugeriu.
4. **Revelação:** o organizador abre o resultado, e cada combo mostra o autor quando alguém toca em "Quem sugeriu?".

O organizador também participa e não vê as sugestões pela página. Quem tiver acesso direto ao banco consegue ver tudo.

## Deploy no VPS

O DNS de `amigo.filatrix3d.com` precisa apontar para o VPS. No servidor, rode:

```bash
git clone https://github.com/Guilherme07/amigo-secreto.git
```

```bash
cd amigo-secreto && FAMILY_CODE=codigo-da-familia ADMIN_CODE=codigo-do-organizador bash deploy/install.sh
```

O instalador descobre as redes do Filatrix, cria um banco e um usuário próprios, grava o `.env`, sobe a API e adiciona o subdomínio ao Caddy. Ele pode rodar de novo sem apagar dados.

O `caddy/Caddyfile` do VPS ganha 3 linhas que não estão no repositório do Filatrix. Copie essas linhas para lá, ou o próximo deploy do Filatrix pode apagá-las.

Depois confira se a API respondeu `{"ok":true}`:

```bash
curl https://amigo.filatrix3d.com/health
```

## Link para a família

```
https://guilherme07.github.io/amigo-secreto/#codigo=CODIGO_DA_FAMILIA
```

## Testar localmente

Use um banco descartável, porque o teste apaga o sorteio.

```bash
docker run -d --rm --name amigo-test-pg -e POSTGRES_PASSWORD=teste -e POSTGRES_DB=amigo -p 127.0.0.1:55432:5432 postgres:15
```

```bash
cd api && npm install
DATABASE_URL=postgres://postgres:teste@127.0.0.1:55432/amigo FAMILY_CODE=familia ADMIN_CODE=org ALLOWED_ORIGIN=http://localhost:5501 node server.js
```

Em outro terminal:

```bash
cd api && FAMILY_CODE=familia ADMIN_CODE=org node test-e2e.mjs
```
