# RPly 1.1.4

Vendored from Diego Nehab's official MIT-licensed release:
<https://w3.impa.br/~diego/software/rply/rply-1.1.4.tar.gz>

Archive SHA-256:
`daf0b060fe701adf72aab0d525323d2e2e1bde9aa6aa9713ff1a5ef1e768d703`.
Retain `LICENSE` and the notices in the source files.

`local.patch` records every difference from that release. The vendored files are
already patched; there is no runtime patching or network download. The application
adapter calls public functions, including the small diagnostic/metadata extensions
listed below. RPly owns parsing, numeric/list decoding, and output encoding.

## Local changes

- Expose the consumed byte position (accounting for RPly's buffered input), storage
  mode, and a structured read failure category. Mark actual EOF separately from
  numeric/syntax errors and I/O errors. Do not interpret human error-message text
  as a recovery signal.
- Expose an element-count setter: a single element can be scanned to EOF without
  trusting its count, and the writing pass can read only the completed prefix.
- Reject negative/overflowing/partially parsed element counts; non-integer list
  count types; list-valued list item types; and negative list lengths. Use a long
  list loop counter, matching the count API.
- Do not advance the token cursor beyond the buffer when the final ASCII token
  has no following whitespace. This matters when attempting the next record at EOF.
- Handle a leading zero-count output element and stop safely after the final one.
- Bound diagnostic formatting with `vsnprintf` rather than `vsprintf`.
- Allow binary float32 NaN/infinity values to round-trip to the downstream NaN
  filter; finite values outside float32's range still fail.

These are owned compatibility/validation patches, not claims about unmodified
RPly. The recovery tests exercise these boundaries. On upgrades, compare the
patch, run tests across alternate encodings/layouts and malformed inputs, and
check surviving numerical values and PlayCanvas acceptance.

PBRT v4's `src/ext/rply/rply.cpp` was inspected during evaluation. Its C++/gzip
integration adds dependencies that this local-file processing path does not need;
its inspected list/header routines do not supply the above recovery diagnostics
or all the validation guards. We therefore retain the official small C release
with explicit local changes rather than importing PBRT's renderer dependencies.

## Build and runtime

`scripts/native-ply.ts` compiles this source and `scripts/native/recover-ply.cpp`
on first use. The binary is cached under `node_modules/.cache/ply-recovery`, keyed
by source contents, operating system, and architecture. No binaries are committed.
Processing requires `cc` and `c++` with C11/C++17 support; macOS Command Line Tools
or Ubuntu `build-essential` provide them. This does not add a native dependency to
the running artifact API or the browser bundle. The helper targets the project's
macOS/Linux processing environments (64-bit `long`/file offsets).

The adapter makes one decoding pass for valid files. If recovery is necessary,
a second pass streams complete records through RPly's writer; it does not allocate
a full vertex array or buffer an entire variable-length record. A staged file is
published exclusively only after success and cleaned up on every exit path.
Recovered files are binary little-endian for SplatTransform; `obj_info` text is
preserved as comments because the pinned SplatTransform reader rejects that keyword.

## Recovery limits

Only EOF permits prefix recovery. Other parse failures abort. Multiple element
blocks retain declared boundaries: a decoder cannot infer that bytes belonging
to a later block were misdeclared as earlier records. Extra data after completed
multiple blocks is rejected as ambiguous. A single element can recover both
underreported and overreported counts by scanning to EOF.

Complete means syntactically decoded, not geometrically valid or proven uncorrupted.
ASCII truncation can leave a token that is itself a valid number; no general reader
can identify that as a shortened original value. RPly passes values through doubles:
finite standard PLY scalar values round-trip without loss of their represented
precision, but NaN payload bits and original ASCII spelling are not preserved.
Masters remain untouched. PlayCanvas still validates and filters the recovered
input before generating derivatives; compressed/custom PLY semantics and mesh
reference integrity remain the consuming format/tool's responsibility.
