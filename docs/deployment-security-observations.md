# Deployment security observations — 2026-10-19 audit

These findings remain applicable independently of the archived LOD experiment. They record a read-only audit, not new hardening or a complete penetration test.

## Read-only deployment observations

- Public frontend Nginx proxies `/api/` and `/files/` to the backend's private IP,
  with no inspected alias/root exposing preservation storage. The inspected
  deployment uses HTTP, with no TLS configuration observed. Network tampering
  remains possible; HTTPS is also required for normal immersive WebXR deployment.
- The backend listens on `0.0.0.0:3000`; PostgreSQL listens on loopback. UFW is
  inactive. A public-IP port-3000 connection probe timed out, which establishes
  only that this probe did not connect. EC2 security-group rules were **not
  inspected**; confirm ingress permits the gateway security group/private path
  and restricts SSH appropriately before certifying network isolation.
- The systemd service runs as `ubuntu`, with `ProtectHome=no`,
  `ProtectSystem=full`, and writable `data/assets`. Masters live under that same
  account's home. An API process compromise could therefore read masters and
  write asset storage despite route checks. Use a separate serving identity and
  a read-only derivative-only mount/directory, with private masters/manifests
  inaccessible to that identity, when hardening deployment. Keep processing under
  a different identity/workspace. This infrastructure isolation is **not applied**
  by the LOD change.
- Path checks reduce accidental/malicious route access, but an attacker with
  filesystem mutation privileges can race path checks and sends. Immutable
  serving storage and process privilege separation are the appropriate boundary.
- The current file rate limit also applies to chunk requests. These fixtures fit
  it; benchmark larger streamed scenes, repeated zooms and shared-client IPs before
  increasing asset sizes. Do not remove the limiter without measured replacement.

No AWS code, files, service settings or firewall rules were changed by this audit.
These observations must be rechecked after infrastructure changes.

## Derivative detail is not access control

The current policy serves a single 30% derivative, with the existing mesh triangle cap. Downloaded derivatives and their textures can be extracted. Simplification is not DRM or an information-disclosure guarantee. Keep masters private and enforce both route authorization and process/storage isolation.
