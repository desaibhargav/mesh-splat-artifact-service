import { link, mkdtemp, rm } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { execute, nativePly } from "./native-ply.js";

export interface PlyRecovery {
  kind: "ply-record-count";
  decoder: "RPly 1.1.4";
  declaredVertices: number;
  recoveredVertices: number;
  recordBytes?: number;
  expectedBytes?: number;
  discardedBytes: number;
  elements: { name: string; declared: number; recovered: number }[];
}

export async function recoverPly(input: string, output: string): Promise<{ input: string; recovery?: PlyRecovery }> {
  if (extname(input).toLowerCase() !== ".ply") return { input };
  const executable = await nativePly();
  // Stage beside the destination so exclusive publication uses an atomic hard link.
  const temporary = await mkdtemp(join(dirname(resolve(output)), ".ply-recovery-"));
  try {
    const staged = join(temporary, "recovered.ply");
    const { stdout } = await execute(executable, [resolve(input), staged]);
    const recovery = JSON.parse(stdout) as PlyRecovery | null;
    if (!recovery) return { input };
    if (![recovery.declaredVertices, recovery.recoveredVertices, recovery.discardedBytes,
      ...(recovery.recordBytes === undefined ? [] : [recovery.recordBytes]),
      ...(recovery.expectedBytes === undefined ? [] : [recovery.expectedBytes]),
      ...recovery.elements.flatMap(element => [element.declared, element.recovered])]
      .every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error("PLY recovery metadata exceeds safe integer arithmetic.");
    }
    await link(staged, output);
    console.warn(`WARNING: PLY recovery for ${input}: RPly retained ${recovery.recoveredVertices} complete vertices (declared ${recovery.declaredVertices}); discarded ${recovery.discardedBytes} trailing bytes. Data may be incomplete. The preservation master is unchanged.`);
    return { input: output, recovery };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
