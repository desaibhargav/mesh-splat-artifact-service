# Mesh–Splat Artifact Service

The API responsible for the public artifact catalog, server-side search, object/file boundary checks, metadata, thumbnails, and delivery of mesh and Gaussian-splat web derivatives.

## Intended stack

- Node.js and TypeScript
- Fastify
- PostgreSQL
- Prisma

For the AWS demonstration, this service and its public test assets run on a private second server. Only the Nginx gateway on the portal server communicates with it.

## Repository boundary

This repository owns catalog data, artifact delivery, and the server-side derivative pipeline.

The production rule is:

```text
preservation master -> private processing -> public web derivative
```

Preservation masters must not be served by the portal. Public `/files` routes should point only at generated web derivatives under `data/assets`. Private derivative manifests and processing records belong under `data/authorization`, which is not part of the public asset route.

The current demo seeds a small public collection whose content paths point at generated derivatives. Original/source files are present under `data/assets/master` as inputs for the pipeline, but catalog records should not point at preservation masters or raw source files.

Directory convention:

```text
data/assets/master       source inputs for derivative processing
data/assets/derivatives  generated web-viewer derivatives served through /files
data/assets/thumbnails   generated public thumbnail images
data/authorization        private processing manifests and server-side records
```

## Web derivative pipeline

The pipeline uses maintained open-source libraries instead of custom geometry algorithms:

- Meshes: `@gltf-transform/core`, `@gltf-transform/functions`, `@gltf-transform/extensions`, and `meshoptimizer`
- Splats: `@playcanvas/splat-transform`

Default policy:

| Type | Public derivative rule |
| --- | --- |
| Mesh | Simplify to 30% of original triangle count, capped at 1,000,000 triangles, using MeshOpt's simplifier; remove source normals before simplification and regenerate normals afterward so split/custom normals cannot silently block decimation; aggressive quantization; no emitted `EXT_meshopt_compression` until the viewer path supports it reliably. |
| Splat | Decimate to 30% of original Gaussian count; convert to ordinary SOG; no Streamed SOG or LOD for now. |

Generate a mesh derivative:

```bash
npm run process:mesh -- \
  --input data/assets/master/scattering-skull.glb \
  --output data/assets/derivatives/scattering-skull/content.glb \
  --force
```

Generate a splat derivative:

```bash
npm run process:splat -- \
  --input data/assets/master/sakura-garden.ply \
  --output data/assets/derivatives/sakura-garden/meta.json \
  --force
```

Generate derivatives for every new or updated source under `data/assets/master`:

```bash
npm run process:derivatives
```

The batch processor scans `data/assets/master` directly. It recognizes top-level `.glb` files as meshes, top-level `.ply` files as splats, and top-level directories containing `meta.json` as SOG splats. It ignores `data/assets/derivatives`. The script processes entries one at a time, prints progress as `[current/total]`, and skips derivatives that are already newer than their source. Use `npm run process:derivatives -- --force` to regenerate everything.

The scripts write public-route-eligible derivatives under the path supplied with `--output`. They also write a private manifest under:

```text
data/authorization/derivative-manifests
```

That manifest records the source path, output path, file sizes, processing policy, tool versions, and whether simplification/decimation was applied. It is for server-side/admin review and should not be exposed through `/files`.

Mesh simplification is required, not best-effort. The script fails loudly if the derivative exceeds the target triangle count by more than a small tolerance. This prevents accidentally serving a near-master mesh when a source asset's topology blocks simplification. One observed example was the chess photogrammetry mesh: preserving its source normals allowed almost no triangle reduction, while removing and regenerating normals allowed the expected `288,557 -> 86,566` triangle reduction.

## Thumbnail generation

Thumbnails are generated from derivatives, not masters. This keeps catalog images aligned with what the public viewer can actually load.

Generate one mesh thumbnail:

```bash
npm run generate:thumbnail -- \
  --type mesh \
  --input data/assets/derivatives/scattering-skull/content.glb \
  --output data/assets/thumbnails/scattering-skull.webp \
  --force
```

Generate one splat thumbnail:

```bash
npm run generate:thumbnail -- \
  --type splat \
  --input data/assets/derivatives/sakura-garden/meta.json \
  --output data/assets/thumbnails/sakura-garden.webp \
  --force
```

Generate or refresh thumbnails for every derivative under `data/assets/derivatives`:

```bash
npm run generate:thumbnails
```

The batch generator scans `data/assets/derivatives` directly. It recognizes derivative directories containing `content.glb` as meshes and directories containing `meta.json` as splats. It processes entries one at a time, prints progress as `[current/total]`, and skips thumbnails that are already newer than their derivative. Use `npm run generate:thumbnails -- --force` to regenerate everything.

Mesh and splat thumbnails use Puppeteer with Puppeteer's bundled Chrome for Testing. The bundled browser is preferred deliberately: Puppeteer chooses a compatible browser revision for the installed Puppeteer version. The script starts a temporary local-only PlayCanvas render page, loads the derivative with the same PlayCanvas asset types used by the portal (`container` for GLB meshes, `gsplat` for SOG splats), applies the same camera-fit approach as the viewer, screenshots the canvas, and writes WebP.

On AWS/Linux, the server needs the shared libraries required by Chrome for Testing. `./scripts/setup-server.sh` calls:

```bash
./scripts/install-thumbnail-browser.sh
```

That helper installs the required Linux libraries and then runs `npx puppeteer browsers install chrome`. If this browser is missing, thumbnail generation fails clearly instead of silently switching to an arbitrary system browser.

## Security boundary

The current portal is intentionally public: anyone who can reach the gateway URL can view the catalog and public web derivatives.

Even without login, the service keeps important server-side boundaries:

- The browser never receives direct filesystem paths or raw storage locations.
- Catalog records point only at generated derivatives, not preservation masters.
- `/files/:artifactId/content/:filename` serves only the exact registered content file for that artifact.
- SOG splats may request component files beside their registered `meta.json`, but still only inside that artifact's registered derivative directory.
- Dotfiles and path traversal are denied.
- Unknown artifact IDs and unregistered files return 404.
- Browser/proxy caching is disabled for file responses as a conservative demo policy.

This protects against accidental exposure and simple URL guessing. It does not prevent a user from copying bytes that are intentionally delivered to their browser for client-side rendering. If IU later requires restricted artifacts, authentication and per-artifact authorization should be reintroduced before serving those records.

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

`npm run setup:local` creates an ignored `.env` and downloads public demonstration assets. It does not overwrite an existing `.env` or existing assets. If Homebrew services are unavailable, start PostgreSQL directly with the `pg_ctl` command printed by Homebrew.

The included starter files are public demonstration assets such as Khronos Group's CC0 Scattering Skull sample and WakuFactory's CC0 Sakura splat sample. Confirm licensing before adding any new public demo asset.

## AWS demo deployment notes

Requirements: Ubuntu, Node.js 24, npm, Git, and a cloned copy of this repository.

For a fresh backend server, run the first-time setup script from an SSH session:

```bash
./scripts/setup-server.sh
```

The setup script installs PostgreSQL, Vulkan runtime packages needed by `splat-transform`, and the Linux shared libraries needed by Puppeteer's bundled Chrome. It starts/enables PostgreSQL, creates the `ubuntu` database role and `mesh_splat` database if needed, assigns a URL-safe database password, creates 2 GiB of swap if needed, runs `npm ci`, installs Puppeteer's bundled Chrome for Testing, creates a server-local `.env`, rewrites it with production backend defaults, and pushes the Prisma schema to PostgreSQL. It does not contain SSH keys, public IPs, passwords, or private artifact files.

The setup script refuses to overwrite an existing `.env` by default. Redeployments should use `./scripts/deploy-server.sh`; they preserve the existing database password and server-local configuration.

First-time setup script inputs:

| Variable | Default | How to choose it |
| --- | --- | --- |
| `DB_NAME` | `mesh_splat` | Keep the default unless the PostgreSQL database must have a different name. |
| `DB_USER` | `ubuntu` | Keep the default when running the service as the Ubuntu EC2 user. |
| `DB_PASSWORD` | generated | Usually omit it. Set only when an administrator must supply a specific PostgreSQL password. |
| `SWAPFILE` | `/swapfile` | Keep the default on a small EC2 instance. |
| `SWAP_SIZE` | `2G` | Keep the default for `t3.micro`; increase if dependency installation/builds are still killed for memory. |
| `FORCE_SETUP` | empty | Do not set during normal use. Set `FORCE_SETUP=1` only when intentionally regenerating setup values on a server. |

The downloaded public demonstration inputs are placed under:

```text
data/assets/master
```

Any assets not downloaded by the setup script, such as contributor-provided meshes, must be placed under that same directory before derivative generation and seeding/deployment. For example:

```text
data/assets/master/chess-set-photogrammetry.glb
```

If doing setup manually instead of using `./scripts/setup-server.sh`, install PostgreSQL, Vulkan support for splat processing, Chrome-for-Testing dependencies for mesh thumbnails, and create the application database:

```bash
sudo apt install -y postgresql postgresql-contrib libvulkan1 mesa-vulkan-drivers vulkan-tools
npm ci
./scripts/install-thumbnail-browser.sh
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
npm run setup:local
npm run db:push
npm run db:generate
npm run db:seed
npm run build
```

`npm run build` also runs `prisma generate`, so repeated Prisma client generation is expected and harmless.

If updating an older authenticated database to the current public schema, remove obsolete permission tables with:

```bash
npm run db:push -- --accept-data-loss
npm run db:seed
```

Use that command only for this demo database or after confirming the removed tables are no longer needed.

The setup script downloads the public skull, Sakura, and chess splat files. The contributor-provided chess mesh is not stored in Git. Upload it before seeding if the seed expects it:

```bash
scp -i /path/to/key.pem \
  "/Users/bhargavdesai/Desktop/[v2] Chess Set.glb" \
  ubuntu@BACKEND_PUBLIC_IP:/home/ubuntu/mesh-splat-artifact-service/data/assets/master/chess-set-photogrammetry.glb
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

After PostgreSQL, `.env`, and assets have been configured once, future backend deployments can be run from an SSH session on the backend server:

```bash
./scripts/deploy-server.sh
```

The script pulls the latest `main`, installs dependencies from the lockfile, regenerates Prisma, reseeds the public artifact catalog, rebuilds TypeScript, installs or updates the `systemd` service file, enables the service, and restarts it. It checks that `.env` exists before running. It does not contain SSH keys, passwords, IP addresses, or other secrets.

Because the seed points at generated derivatives, a fresh server or a server missing `data/assets/derivatives` should run deployment with derivative generation enabled:

```bash
GENERATE_DERIVATIVES=1 ./scripts/deploy-server.sh
```

That opt-in mode runs `npm run process:derivatives` after `npm ci` and before `npm run db:seed`. Normal redeployments can omit the flag after derivatives already exist.

To also generate or refresh thumbnails on the backend server during deployment:

```bash
GENERATE_THUMBNAILS=1 ./scripts/deploy-server.sh
```

That opt-in mode first runs `./scripts/install-thumbnail-browser.sh`, then runs `npm run generate:thumbnails`. This makes an existing AWS backend work even if it was originally set up before the thumbnail pipeline existed.

On a fresh server, run both steps together after source assets are in `data/assets/master`:

```bash
GENERATE_DERIVATIVES=1 GENERATE_THUMBNAILS=1 ./scripts/deploy-server.sh
```

Redeployment script inputs:

| Variable | Default | How to choose it |
| --- | --- | --- |
| `SERVICE_NAME` | `mesh-splat-artifact-service` | Keep the default unless the systemd service should use a different name. |
| `GENERATE_DERIVATIVES` | `0` | Set to `1` when derivatives need to be created before seeding. |
| `GENERATE_THUMBNAILS` | `0` | Set to `1` when thumbnails need to be created or refreshed from derivatives before seeding. |

## Current status

The service includes a public catalog API, cursor-paginated server-side search, object/file boundary checks, range-capable derivative file delivery, security headers, rate limiting, a fixed Prisma/PostgreSQL schema, graceful shutdown, derivative processing scripts, and security-focused route tests.
