# LOD publication/security review — 2026-10-19

## Code boundary implemented

Public API content remains under `derivatives/<slug>/`, with thumbnails under
`thumbnails/`. `derivativeFiles.ts` builds an explicit file graph from the registered
entry point, strict LOD descriptor, and native SOG manifests. Neither a known master
path nor an arbitrary neighbouring file is authorized. Manifest paths cannot
traverse directories; requested files and their parent components must be regular
files/directories, without symlinks. Catalog validation rejects extra bundle files.
Private processing manifests remain under `data/authorization/`, outside delivery.
Nested streamed textures and gzip edit maps are authorized explicitly. The HTTP
response declares gzip encoding so browsers decompress the maps natively.

Tests exercise poisoned catalog paths, direct master requests, traversal, symlink
parents, private siblings, nested stream files, gzip response data and GLB ranges.
Staged generation preserves the previous bundle if processing fails and rejects
output aliases containing the input or a private processing manifest. Public LOD
metadata contains only published derivative locations/counts and correspondence,
never master paths or master IDs. Publication still trusts the administrator who
creates bundles and the local filesystem; it is not a malicious-upload sandbox.

Local regeneration found unreferenced legacy mesh GLBs alongside `content.glb`.
They were preserved in ignored `data/authorization/legacy-derivatives/`, rather
than deleting them or teaching public delivery to allow arbitrary GLB siblings.
Their hashes differ from the preservation masters; this does not establish their
historic origin or detail policy. No corresponding AWS files were moved.

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

## What the percentage cap protects

The finest *individual published level* is at most 70% of the source primitive
count. Independent lower levels can reveal complementary information, and a user
can download everything their browser receives. Textures are not capped by triangle
percentage. This policy reduces published detail; it is not encryption, DRM, a 70%
information-disclosure bound, or a guarantee that reconstruction is impossible.
Master protection depends on storage, process and network access controls.
