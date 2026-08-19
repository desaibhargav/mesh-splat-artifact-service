# Security model

## Trust boundaries

- The public gateway is not an identity authority.
- The current portal is public and does not authenticate viewers.
- `X-Authenticated-User` and similar gateway-supplied identity headers are ignored because the service does not use viewer identity.
- PostgreSQL and the artifact service must not be publicly reachable.
- Preservation masters must not be served through `/files`.

## Artifact access

Every catalog, metadata, thumbnail, and content request is public. Artifact-specific file requests still pass through object/file boundary checks: the artifact must exist, and the requested file must be the registered mesh derivative or a SOG component in the registered derivative directory.

The current demonstration exposes only public test derivatives. No IU preservation master or restricted IU data may be placed in a public route. Source/master files belong under `data/assets/master`; catalog records should point only at `data/assets/derivatives` and `data/assets/thumbnails`.

## Public viewing limitation

A public browser receives the derivative bytes needed for client-side rendering. This is not download prevention. Asset protection relies on serving only intentionally degraded web derivatives, omitting download UI, rate limiting, avoiding public master paths, and keeping source/preservation files outside the served catalog.

## Known deployment work

- Configure Nginx to stream `/files/` responses without proxy caching or storage.
- Restrict the service network listener to the gateway.
- Reintroduce authentication/authorization only if IU policy later requires restricted artifacts.
- Add production monitoring, backups, and security-event retention before handling restricted data.
