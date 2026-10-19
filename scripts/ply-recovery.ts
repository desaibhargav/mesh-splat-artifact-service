import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface PlyRecovery {
  kind: "ply-record-count";
  declaredVertices: number;
  recoveredVertices: number;
  recordBytes: number;
  expectedBytes: number;
  discardedBytes: number;
}

// PLY scalar widths, including the aliases recognized by common exporters.
const scalarBytes = new Map(Object.entries({
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8
}));

async function readHeaderBytes(input: string): Promise<Buffer> {
  let header = Buffer.alloc(0);
  for await (const chunk of createReadStream(input)) {
    header = Buffer.concat([header, chunk]);
    const text = header.toString("latin1");
    const end = /(?:^|\n)end_header\r?\n/.exec(text);
    if (end) return header.subarray(0, end.index + end[0].length);
    // An incomplete text header must not make us buffer the binary payload.
    if (/[^\t\r\n\x20-\x7e]/.test(text)) break;
  }
  throw new Error("Invalid PLY: missing complete end_header line.");
}

interface VertexLayout {
  lines: string[];
  vertexLine: number;
  declaredVertices: number;
  recordBytes: number;
}

// PlayCanvas's header parser is private. Inspect only the layout we can recover;
// all other PLY variants remain the native reader's responsibility.
function recoverableLayout(header: Buffer): VertexLayout | null {
  const lines = header.toString("latin1").split(/\r?\n/);
  const fields = lines.map(line => line.trim().split(/\s+/));
  const format = fields.find(([keyword]) => keyword === "format");
  const elements = fields.filter(([keyword]) => keyword === "element");
  const vertex = elements[0];
  if (lines[0] !== "ply" || format?.[1] !== "binary_little_endian" || format[2] !== "1.0") return null;
  if (elements.length !== 1 || vertex?.length !== 3 || vertex[1] !== "vertex" || !/^\d+$/.test(vertex[2] ?? "")) return null;

  let recordBytes = 0;
  for (const [keyword, type, name, extra] of fields) {
    if (keyword !== "property") continue;
    const width = scalarBytes.get(type ?? "");
    if (!width || !name || extra || name.startsWith("packed_")) return null;
    recordBytes += width;
  }
  if (!recordBytes) return null;
  return { lines, vertexLine: fields.indexOf(vertex), declaredVertices: Number(vertex[2]), recordBytes };
}

export async function recoverPly(input: string, output: string): Promise<{ input: string; recovery?: PlyRecovery }> {
  if (extname(input).toLowerCase() !== ".ply") return { input };
  const header = await readHeaderBytes(input);
  const layout = recoverableLayout(header);
  if (!layout) return { input };

  const { declaredVertices, recordBytes } = layout;
  const size = (await stat(input)).size;
  const expectedBytes = header.length + declaredVertices * recordBytes;
  if (!Number.isSafeInteger(expectedBytes)) throw new Error("Invalid PLY: vertex count exceeds safe file-size arithmetic.");
  if (size === expectedBytes) return { input };
  const recoveredVertices = Math.floor((size - header.length) / recordBytes);
  if (!recoveredVertices) throw new Error("Cannot recover PLY: no complete vertex records remain.");
  const payloadBytes = recoveredVertices * recordBytes;
  const recovery: PlyRecovery = { kind: "ply-record-count", declaredVertices, recoveredVertices,
    recordBytes, expectedBytes, discardedBytes: size - header.length - payloadBytes };
  layout.lines[layout.vertexLine] = `element vertex ${recoveredVertices}`;
  const corrected = Buffer.from(layout.lines.join("\n"), "latin1");
  await pipeline(Readable.from((async function* () {
    yield corrected;
    yield* createReadStream(input, { start: header.length, end: header.length + payloadBytes - 1 });
  })()), createWriteStream(output, { flags: "wx" }));
  console.warn(`WARNING: PLY recovery for ${input}: header declared ${declaredVertices} vertices; retained ${recoveredVertices} complete records; discarded ${recovery.discardedBytes} trailing bytes. Data may be incomplete. The preservation master is unchanged.`);
  return { input: output, recovery };
}
