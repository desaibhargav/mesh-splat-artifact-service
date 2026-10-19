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
const scalarBytes: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8
};

async function readHeader(input: string): Promise<Buffer> {
  let header = Buffer.alloc(0);
  for await (const chunk of createReadStream(input)) {
    header = Buffer.concat([header, chunk]);
    const text = header.toString("latin1");
    const end = /(?:^|\n)end_header\r?\n/.exec(text);
    if (end) return header.subarray(0, end.index + end[0].length);
    if (!/^[\t\r\n\x20-\x7e]*$/.test(text)) break;
  }
  throw new Error("Invalid PLY: missing complete end_header line.");
}

// Only a single fixed-width vertex element has an unambiguous count derivable
// from byte length. Other layouts stay with the native loader; never guess their
// record boundaries. Valid inputs incur only a header read and stat, no copy.
export async function recoverPly(input: string, output: string): Promise<{ input: string; recovery?: PlyRecovery }> {
  if (extname(input).toLowerCase() !== ".ply") return { input };
  const header = await readHeader(input), text = header.toString("latin1");
  const lines = text.trimEnd().split(/\r?\n/);
  const elements = lines.filter(line => line.startsWith("element "));
  const vertex = /^element vertex (\d+)$/.exec(elements[0] ?? "");
  if (lines[0] !== "ply" || !lines.includes("format binary_little_endian 1.0") || elements.length !== 1 || !vertex) return { input };
  let recordBytes = 0;
  for (const line of lines.filter(line => line.startsWith("property "))) {
    const property = /^property (\w+) (\w+)$/.exec(line);
    const width = property && scalarBytes[property[1]!];
    if (!width || property![2]!.startsWith("packed_")) return { input };
    recordBytes += width;
  }
  if (!recordBytes) return { input };
  const declaredVertices = Number(vertex[1]), size = (await stat(input)).size;
  const expectedBytes = header.length + declaredVertices * recordBytes;
  if (!Number.isSafeInteger(expectedBytes)) throw new Error("Invalid PLY: vertex count exceeds safe file-size arithmetic.");
  if (size === expectedBytes) return { input };
  const recoveredVertices = Math.floor((size - header.length) / recordBytes);
  if (!recoveredVertices) throw new Error("Cannot recover PLY: no complete vertex records remain.");
  const payloadBytes = recoveredVertices * recordBytes;
  const recovery: PlyRecovery = { kind: "ply-record-count", declaredVertices, recoveredVertices,
    recordBytes, expectedBytes, discardedBytes: size - header.length - payloadBytes };
  const corrected = text.replace(/\r\n/g, "\n").replace(/^element vertex \d+$/m, `element vertex ${recoveredVertices}`);
  await pipeline(Readable.from((async function* () {
    yield Buffer.from(corrected, "latin1");
    yield* createReadStream(input, { start: header.length, end: header.length + payloadBytes - 1 });
  })()), createWriteStream(output, { flags: "wx" }));
  console.warn(`WARNING: PLY recovery for ${input}: header declared ${declaredVertices} vertices; retained ${recoveredVertices} complete records; discarded ${recovery.discardedBytes} trailing bytes. Data may be incomplete. The preservation master is unchanged.`);
  return { input: output, recovery };
}
