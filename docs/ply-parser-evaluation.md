# PLY parser evaluation

Evaluated on 2026-10-19 using unmodified Tinyply revision
`c9bb690dfe5e9105961e9e28120c48c9ae084bc6` from
<https://github.com/ddiakopoulos/tinyply>.

## Method and results

Compiled a temporary C++17 probe with the macOS Clang compiler. It calls public
`PlyFile::parse_header`, `get_elements`, `is_binary_file`, and `is_big_endian`.
The input stream position after parsing gives the header byte length; filesystem
length minus that position gives the available payload bytes. Property types and
`PropertyTable` supply scalar widths. Selected valid fixtures also use the public
payload reader and verify a decoded coordinate, rather than checking metadata only.

- ASCII, binary little-endian, and binary big-endian fixtures passed with LF and
  CRLF headers. Header lengths and decoded coordinates matched in all six cases.
- A mixed-width, reordered scalar fixture passed with the expected 13-byte binary
  record width. A vertex-plus-list-valued-face fixture also loaded successfully.
- The damaged master reported 1,532 header bytes, 217,087,366 available payload
  bytes, 1,629,455 declared vertices, and 248 bytes per vertex. Parsing the header
  succeeded despite the payload mismatch; header parsing alone does not validate
  the declared file size.
- The existing recovery helper produced a temporary copy that Tinyply parsed with
  875,352 declared vertices and 217,087,296 payload bytes. Recovery discarded 70
  trailing bytes. The temporary recovery copy was removed; the master was unchanged.
- Unknown scalar types returned failure; a missing end marker and a negative
  element count threw errors.
- Header parsing nevertheless returned success for missing magic, missing format,
  an unknown format, an unknown version, and extra tokens after count/property
  declarations. These are observed acceptance behaviors, not guarantees that the
  corresponding payloads can be read.
- All 11 existing recovery tests passed, including native PlayCanvas acceptance of
  recovered fixtures and rejection of their inconsistent originals.

The probe, fixture generator, downloaded source, and detailed results remain
temporary evaluation artifacts outside the repository, under
`/private/tmp/gab-tinyply-evaluation`; that directory is not a persistent dependency.
The probe is not part of the processing pipeline.

## Integration assessment

Tinyply supports the three standard encodings and broader element/property
structures than our current helper. Its public header API is usable without
decoding the payload, but it documents limited validation and assumes that the
header correctly describes the payload. It is not a strict validator or a recovery
implementation. Do not describe its supported formats as coverage of every
malformed or exporter-specific PLY variant.

The existing helper handles one scalar-only little-endian vertex block with
metadata-derived properties and stride; it is not a universal PLY recovery step.
No production parser replacement was made in this evaluation. A Tinyply integration
would require a native helper/build dependency, additional header validation, and
an explicit recovery policy. Evaluate those costs before adding it to Node setup.

Available bytes are measurable for any encoding. Expected bytes are computable
from counts and scalar widths only for fixed-width binary elements. ASCII and
variable-length lists require payload scanning. Incorrect counts across multiple
element blocks can leave boundaries ambiguous even when the header is fully
parsed. A general parser therefore does not justify applying the current
`floor(payloadBytes / recordBytes)` repair to every PLY.

## RPly callback evaluation

The desired broader recovery boundary is a decoder that exposes completed records
before failure, rather than only header metadata. Tested the official RPly 1.1.4
distribution from <https://w3.impa.br/~diego/software/rply/> on 2026-10-19 with a
temporary C++ adapter linked to unmodified `rply.c`. Public element/property
iteration identifies each element's last property. A callback on that property
increments the completed-record count only after the scalar, final list entry, or
empty list has decoded. RPly handles all preceding properties and parsing failures.

Eleven cases passed: incomplete scalar records, incomplete face lists, and valid
empty/nonempty lists in each of ASCII, binary little-endian, and binary big-endian;
an invalid ASCII numeric token; and the real truncated master. On that master the
callbacks counted 875,352 complete vertices before `ply_read` reported failure,
independently confirming the fixed-width helper's recovered count. The probe counts
records; it does not yet spool their values, write a recovered file, or integrate
with the pipeline. Evaluation artifacts are under `/private/tmp/rply-1.1.4`.

RPly also exposes `ply_write_header`, unlike Tinyply's internal header-only writer.
It is a more suitable candidate for library-decoded prefix recovery. Integration
would still need completed-record buffering/spooling, corrected counts, output
validation, native build setup, and performance checks. Its callbacks pass numeric
values as doubles; numeric round trips are not a guarantee of byte-identical payloads.
No production dependency or processing behavior changed in this evaluation.

Limits remain explicit: a completed record means syntactically decoded, not proven
uncorrupted; a truncated numeric ASCII token may itself still be a valid number.
RPly follows declared element counts, so underreported counts and ambiguous block
boundaries need separate policy. Neither parser can infer the cause of the missing
bytes, reconstruct missing records, or universally resynchronize after corruption.

## Shipped integration

The pipeline now uses RPly through `scripts/ply-recovery.ts` and a streaming native
adapter, replacing the application's header regex/token parser. See
[`vendor/rply/README.md`](../vendor/rply/README.md) for the pinned release,
reproducible local patch, build requirements, and exact guarantees. Earlier
"no production change" statements above describe the initial evaluation only.
The parser and writer now run on real processing inputs; retained-record policy
and pipeline coordination remain application responsibilities.

Integration validation: all 52 backend tests (35 recovery cases), TypeScript, and
the production build passed. Address/undefined-behavior sanitizers passed on 123
fixtures and every byte prefix of an ASCII header/payload example. Cleanup is
asserted after successful and failed recovery tests. On the real damaged asset,
recovery retained 875,352 vertices and discarded 70 bytes in approximately 1.6
seconds on the development Mac with the helper cached. The recovered payload hash
matched the surviving source payload byte for byte:
`c29fc8d22ae230aaf23afb9858151fe7213461ae8720615286a9be8485875476`.
PlayCanvas's actual CLI then loaded, filtered NaNs, and decimated the recovered
file successfully with GPU access. That integration's temporary files were removed;
the preservation master was unchanged. This is a local measurement, not a portable
performance guarantee. Linux execution and a full SOG re-encode were not repeated
for this change; no viewer code changed.
