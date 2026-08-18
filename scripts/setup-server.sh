#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_NAME="${DB_NAME:-mesh_splat}"
DB_USER="${DB_USER:-ubuntu}"
SWAPFILE="${SWAPFILE:-/swapfile}"
SWAP_SIZE="${SWAP_SIZE:-2G}"

cd "$APP_ROOT"

if [[ -f .env && "${FORCE_SETUP:-}" != "1" ]]; then
  echo ".env already exists; preserving existing server credentials." >&2
  echo "Use ./scripts/deploy-server.sh for redeployment." >&2
  echo "Set FORCE_SETUP=1 only if you intentionally want to regenerate setup values." >&2
  exit 1
fi

DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -hex 24)}"

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y postgresql postgresql-contrib
else
  echo "This setup script expects an apt-based Linux server such as Ubuntu." >&2
  exit 1
fi

sudo systemctl enable postgresql >/dev/null
sudo systemctl start postgresql

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  sudo -u postgres createuser "$DB_USER"
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
fi

sudo -u postgres psql -c "ALTER USER \"$DB_USER\" WITH PASSWORD '$DB_PASSWORD';" >/dev/null

if [[ ! -f "$SWAPFILE" ]]; then
  sudo fallocate -l "$SWAP_SIZE" "$SWAPFILE" || sudo dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048 status=progress
  sudo chmod 600 "$SWAPFILE"
  sudo mkswap "$SWAPFILE"
fi

if ! swapon --show=NAME | grep -qx "$SWAPFILE"; then
  sudo swapon "$SWAPFILE"
fi

if ! grep -q "^${SWAPFILE} " /etc/fstab; then
  echo "$SWAPFILE none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi

npm ci
npm run setup:local

sed -i \
  -e "s#^NODE_ENV=.*#NODE_ENV=production#" \
  -e "s#^HOST=.*#HOST=0.0.0.0#" \
  -e "s#^PORT=.*#PORT=3000#" \
  -e "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}#" \
  .env

npm run db:push

echo
echo "Server prerequisites are ready."
echo "Review .env before deployment. This script set production server defaults for NODE_ENV, HOST, PORT, and DATABASE_URL."
echo "The generated demo username and password were printed above by npm run setup:local."
echo "Save them now; the password is not stored in plaintext."
echo
echo "Place any non-downloaded assets under:"
echo "  $APP_ROOT/data/assets"
echo
echo "Then run:"
echo "  ./scripts/deploy-server.sh"
