#!/usr/bin/env bash
# Instala a API no VPS, ao lado do Filatrix. Pode rodar de novo sem perder dados.
# Uso: FAMILY_CODE=... ADMIN_CODE=... bash deploy/install.sh
set -euo pipefail

: "${FAMILY_CODE:?Informe FAMILY_CODE}"
: "${ADMIN_CODE:?Informe ADMIN_CODE}"
DOMAIN="${DOMAIN:-amigo.filatrix3d.com}"
ORIGIN="${ORIGIN:-https://guilherme07.github.io}"
PG_CONTAINER="${PG_CONTAINER:-filatrix-postgres}"
CADDY_CONTAINER="${CADDY_CONTAINER:-filatrix-caddy}"

cd "$(dirname "$0")/.."

first_network() {
  docker inspect "$1" -f '{{range $name, $value := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
    | grep -v '^$' | head -1
}

run_sql() {
  docker exec -i "$PG_CONTAINER" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

DB_NETWORK="$(first_network "$PG_CONTAINER")"
PROXY_NETWORK="$(first_network "$CADDY_CONTAINER")"
echo "Redes: banco=$DB_NETWORK proxy=$PROXY_NETWORK"

CADDYFILE="${CADDYFILE:-$(docker inspect "$CADDY_CONTAINER" \
  -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')}"
[ -f "$CADDYFILE" ] || { echo "Caddyfile não encontrado: '$CADDYFILE'"; exit 1; }

# Reaproveita a senha numa reinstalação.
DB_PASSWORD="$(sed -n 's#^DATABASE_URL=postgres://amigo:\([^@]*\)@.*#\1#p' .env 2>/dev/null || true)"
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -hex 24)}"

echo "Criando banco e usuário próprios..."
run_sql <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'amigo') THEN CREATE ROLE amigo LOGIN; END IF;
END \$\$;
ALTER ROLE amigo PASSWORD '$DB_PASSWORD';
SELECT 'CREATE DATABASE amigo OWNER amigo'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'amigo')\gexec
SQL

(
  umask 077
  cat > .env <<ENV
DATABASE_URL=postgres://amigo:$DB_PASSWORD@$PG_CONTAINER:5432/amigo
FAMILY_CODE=$FAMILY_CODE
ADMIN_CODE=$ADMIN_CODE
ALLOWED_ORIGIN=$ORIGIN
PORT=8787
DB_NETWORK=$DB_NETWORK
PROXY_NETWORK=$PROXY_NETWORK
ENV
)

echo "Subindo a API..."
docker compose up -d --build

for _ in $(seq 1 30); do
  docker exec amigo-api wget -qO- http://127.0.0.1:8787/health >/dev/null 2>&1 && break
  sleep 1
done
docker exec amigo-api wget -qO- http://127.0.0.1:8787/health >/dev/null \
  || { echo "A API não respondeu. Veja: docker logs amigo-api"; exit 1; }

if grep -q "^$DOMAIN " "$CADDYFILE"; then
  echo "Caddy já tem $DOMAIN."
else
  echo "Adicionando $DOMAIN ao Caddy..."
  cp "$CADDYFILE" "$CADDYFILE.antes-amigo"
  printf '\n%s {\n    reverse_proxy amigo-api:8787\n}\n' "$DOMAIN" >> "$CADDYFILE"
  # Se a configuração nova falhar, o Caddy segue com a antiga e o arquivo volta ao que era.
  if ! docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile; then
    cat "$CADDYFILE.antes-amigo" > "$CADDYFILE"
    echo "O Caddy recusou a mudança. Nada foi alterado nele."
    exit 1
  fi
fi

echo "Pronto. Confira em instantes: curl https://$DOMAIN/health"
