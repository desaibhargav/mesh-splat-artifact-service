# Mesh–Splat Artifact Service

The API responsible for the artifact catalog, server-side search, authorization boundaries, metadata, thumbnails, and protected delivery of mesh and Gaussian-splat files.

## Intended stack

- Node.js and TypeScript
- Fastify
- PostgreSQL
- Prisma

For the AWS demonstration, this service and its public test assets run on a private second server. Only the Nginx gateway on the portal server communicates with it.

## Repository boundary

This repository owns catalog data and artifact delivery. The current local demonstration intentionally uses public source files directly. A separate preservation-master/web-derivative workflow is deferred to the next iteration and must be restored before restricted production collections are ingested.

## Security boundary

The temporary demo adapter verifies an Argon2 password and issues an encrypted, HttpOnly, SameSite session cookie. The future production adapter independently verifies IU OIDC identity. Neither mode trusts identity headers supplied by Nginx. Catalog queries return only artifacts visible to the verified subject, and metadata, thumbnail, and content routes repeat that authorization check before returning anything.

Every artifact requires an explicit `(artifactId, userSubject)` permission. Authentication alone never grants collection-wide access. Unauthorized lookups return 404 to avoid confirming that an artifact exists.

Protected files are served only from the configured asset root with browser/proxy caching disabled. An authorized browser still receives the bytes needed for client-side rendering; this is not download prevention.

## Run locally

Requirements: Node.js 24 and PostgreSQL 17.

```bash
brew install postgresql@17
brew services start postgresql@17
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
npm install
npm run setup:local
createdb mesh_splat
npm run db:push
npm run db:seed
npm run dev
```

`npm run setup:local` creates an ignored `.env`, prints a generated local username and password once, and downloads public CC0 demonstration assets. It does not overwrite an existing `.env` or existing assets. If Homebrew services are unavailable, start PostgreSQL directly with the `pg_ctl` command printed by Homebrew.

The generated demo subject receives explicit permission for both seeded artifacts. The included files are Khronos Group's CC0 Scattering Skull sample and WakuFactory's CC0 Sakura splat sample.

## AWS demo deployment notes

On the backend artifact-service instance, install PostgreSQL and create the application database:

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql
sudo -u postgres createuser ubuntu
sudo -u postgres createdb -O ubuntu mesh_splat
```

Prisma connects to PostgreSQL over TCP at `127.0.0.1:5432`, so the `ubuntu` database role needs a database password even though the Linux user is also named `ubuntu`.

Generate a URL-safe password:

```bash
openssl rand -hex 24
```

Set that password in PostgreSQL:

```bash
sudo -u postgres psql
```

```sql
ALTER USER ubuntu WITH PASSWORD 'PASTE_PASSWORD_HERE';
\q
```

The `.env` file must contain exactly one `DATABASE_URL=` prefix:

```env
DATABASE_URL=postgresql://ubuntu:PASTE_PASSWORD_HERE@127.0.0.1:5432/mesh_splat
```

If a password contains URL-reserved characters, encode them before placing the password in `DATABASE_URL`. For example, `+` becomes `%2B`.

For the AWS backend service, use:

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
```

Run setup and database commands:

```bash
npm ci
npm run setup:local
npm run db:push
npm run db:generate
npm run db:seed
npm run build
```

`npm run build` also runs `prisma generate`, so repeated Prisma client generation is expected and harmless.

The setup script downloads the public skull, Sakura, and chess splat files. The contributor-provided chess mesh is not stored in Git. Upload it before seeding if the seed expects it:

```bash
scp -i /path/to/key.pem \
  "/Users/bhargavdesai/Desktop/[v2] Chess Set.glb" \
  ubuntu@BACKEND_PUBLIC_IP:/home/ubuntu/mesh-splat-artifact-service/data/assets/chess-set-photogrammetry.glb
```

The demo backend security group should allow SSH from the maintainer's IP and TCP `3000` only from the frontend gateway security group. It should not expose HTTP `80` or HTTPS `443` to the internet.

Run the compiled backend with `systemd` so it survives SSH disconnects and instance restarts:

```bash
sudo nano /etc/systemd/system/mesh-splat-artifact-service.service
```

```ini
[Unit]
Description=Mesh-Splat Artifact Service
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/mesh-splat-artifact-service
EnvironmentFile=/home/ubuntu/mesh-splat-artifact-service/.env
ExecStart=/usr/bin/node /home/ubuntu/mesh-splat-artifact-service/dist/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ReadWritePaths=/home/ubuntu/mesh-splat-artifact-service/data/assets

[Install]
WantedBy=multi-user.target
```

Enable, start, and inspect the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable mesh-splat-artifact-service
sudo systemctl start mesh-splat-artifact-service
sudo systemctl status mesh-splat-artifact-service --no-pager
journalctl -u mesh-splat-artifact-service -n 80 --no-pager
```

From the frontend gateway instance, verify private connectivity to the backend:

```bash
curl -i http://BACKEND_PRIVATE_IP:3000/health
```

The expected response is `HTTP/1.1 200 OK` with `{"status":"ok"}`.

## Current status

The service includes the temporary session adapter, OIDC/JWKS adapter, per-artifact authorization, cursor-paginated server-side search, protected range-capable file delivery, security headers, rate limiting, a fixed Prisma/PostgreSQL schema, graceful shutdown, and security-focused route tests.
