import { open } from "node:fs/promises";
import { getInputFormat, readFileInfo, ReadStream, type ReadFileSystem } from "@playcanvas/splat-transform";

// Node file transport for SplatTransform's public reader interface. Parsing and
// format validation remain entirely in the library; do not load a master into RAM.
export const splatFileSystem: ReadFileSystem = {
  async createSource(filename: string) {
    const file = await open(filename, "r");
    const { size } = await file.stat();
    let closed = false;
    return {
      size, seekable: true,
      read(start = 0, end = size) {
        if (closed) throw new Error("Source has been closed.");
        let position = Math.max(0, Math.min(start, size));
        const limit = Math.max(position, Math.min(end, size));
        let streamClosed = false;
        return new class extends ReadStream {
          constructor() { super(limit - position); }
          async pull(target: Uint8Array) {
            if (streamClosed || closed) return 0;
            const length = Math.min(target.byteLength, limit - position);
            if (length <= 0) return 0;
            const { bytesRead } = await file.read(target, 0, length, position);
            position += bytesRead;
            return bytesRead;
          }
          close() { streamClosed = true; }
        }();
      },
      close() { if (!closed) { closed = true; void file.close(); } }
    };
  }
};

export async function splatInfo(filename: string) {
  return readFileInfo({ filename, inputFormat: getInputFormat(filename), fileSystem: splatFileSystem });
}
