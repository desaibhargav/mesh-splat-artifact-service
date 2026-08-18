# Security model

## Trust boundaries

- The public gateway is not an identity authority.
- The artifact service accepts only credentials it can independently validate.
- `X-Authenticated-User` and similar gateway-supplied identity headers are ignored.
- The gateway must not have a universal service credential that can read every restricted artifact.
- PostgreSQL and the artifact service must not be publicly reachable.

## Artifact access

Every catalog, metadata, thumbnail, and content request is authenticated. Every artifact-specific request is then authorized against the verified subject. Authentication alone never grants access to an artifact.

The current demonstration exposes only its public test assets. It deliberately does not yet implement the agreed web-derivative pipeline. No IU preservation master or restricted IU data may be placed in `ARTIFACT_ROOT` until that work and IU policy review are complete.

## Temporary authentication

The demo adapter stores only an Argon2 password hash and places the verified subject in an encrypted, HttpOnly, SameSite session cookie. Sessions expire after one hour by default. Authentication routes are rate-limited, and application logs redact authorization and cookie headers.

Nginx forwards the session cookie and therefore remains a sensitive component. Compromise of the gateway could permit theft and replay of a live user's session; independently repeating authorization at the artifact service prevents invented identity headers and over-broad gateway service credentials, but it cannot make a compromised TLS endpoint harmless. The private network boundary, short session life, least-privilege artifact permissions, patching, and monitoring remain required.

## Known deployment work

- Configure Nginx to stream `/files/` responses without proxy caching or storage.
- Restrict the service network listener to the gateway.
- Replace demo authentication with IU OIDC configuration before using IU data.
- Add production monitoring, backups, and security-event retention before handling restricted data.
