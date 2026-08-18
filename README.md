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

`npm run setup:local` creates an ignored `.env`, prints a random local password once, and downloads two public CC0 fixtures. It does not overwrite an existing `.env` or existing assets. If Homebrew services are unavailable, start PostgreSQL directly with the `pg_ctl` command printed by Homebrew.

The generated demo subject receives explicit permission for both seeded artifacts. The included files are Khronos Group's CC0 Scattering Skull sample and WakuFactory's CC0 Sakura splat sample.

## Current status

The service includes the temporary session adapter, OIDC/JWKS adapter, per-artifact authorization, cursor-paginated server-side search, protected range-capable file delivery, security headers, rate limiting, a fixed Prisma/PostgreSQL schema, graceful shutdown, and security-focused route tests.
