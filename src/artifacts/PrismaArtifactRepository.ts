import type { PrismaClient } from "../generated/prisma/client.js";
import type {
  ArtifactPage,
  ArtifactRecord,
  ArtifactRepository,
  ArtifactSearch
} from "./ArtifactRepository.js";

export class PrismaArtifactRepository implements ArtifactRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async search(search: ArtifactSearch): Promise<ArtifactPage> {
    const queryFilter = search.query
      ? {
          OR: [
            { title: { contains: search.query, mode: "insensitive" as const } },
            { description: { contains: search.query, mode: "insensitive" as const } }
          ]
        }
      : {};

    const records = await this.prisma.artifact.findMany({
      where: {
        AND: [
          queryFilter,
          search.type ? { type: search.type.toUpperCase() as "MESH" | "SPLAT" } : {}
        ]
      },
      orderBy: { id: "asc" },
      take: search.limit + 1,
      ...(search.cursor ? { cursor: { id: search.cursor }, skip: 1 } : {})
    });

    const hasMore = records.length > search.limit;
    const visibleRecords = records.slice(0, search.limit);
    return {
      items: visibleRecords.map(toRecord),
      nextCursor: hasMore ? visibleRecords.at(-1)?.id ?? null : null
    };
  }

  async findById(artifactId: string): Promise<ArtifactRecord | null> {
    const record = await this.prisma.artifact.findFirst({
      where: { id: artifactId }
    });
    return record ? toRecord(record) : null;
  }
}

function toRecord(record: {
  id: string;
  title: string;
  description: string;
  type: "MESH" | "SPLAT";
  thumbnailPath: string | null;
  contentPath: string;
  contentFilename: string;
  mimeType: string;
  sizeBytes: bigint;
}): ArtifactRecord {
  const sizeBytes = Number(record.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes)) {
    throw new Error(`Artifact ${record.id} has an unsupported file size.`);
  }
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    type: record.type.toLowerCase() as "mesh" | "splat",
    thumbnailPath: record.thumbnailPath,
    contentPath: record.contentPath,
    contentFilename: record.contentFilename,
    mimeType: record.mimeType,
    sizeBytes
  };
}
