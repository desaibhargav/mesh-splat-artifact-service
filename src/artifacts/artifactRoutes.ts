import type { FastifyInstance, FastifyReply } from "fastify";
import { lstat } from "node:fs/promises";
import { derivativeFiles, regularFile, relativeFile } from "./derivativeFiles.js";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ArtifactRecord, ArtifactRepository } from "./ArtifactRepository.js";
import { HttpError } from "../errors/HttpError.js";

const searchSchema = z.object({
  query: z.string().trim().max(200).optional(),
  type: z.enum(["mesh", "splat"]).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24)
});

const artifactIdSchema = z.object({ artifactId: z.string().uuid() });
const artifactFileSchema = z.object({
  artifactId: z.string().uuid(),
  "*": relativeFile
});

export interface ArtifactRouteDependencies {
  repository: ArtifactRepository;
  config: { artifactRoot: string };
}

export async function registerArtifactRoutes(
  app: FastifyInstance,
  dependencies: ArtifactRouteDependencies
) {
  app.get("/api/v1/artifacts", async (request) => {
    const search = searchSchema.parse(request.query);
    const page = await dependencies.repository.search({
      limit: search.limit,
      ...(search.query ? { query: search.query } : {}),
      ...(search.type ? { type: search.type } : {}),
      ...(search.cursor ? { cursor: search.cursor } : {})
    });
    return {
      items: await Promise.all(page.items.map(artifact => toResponse(artifact, dependencies.config.artifactRoot))),
      nextCursor: page.nextCursor
    };
  });

  app.get("/api/v1/artifacts/:artifactId", async (request) => {
    const { artifactId } = artifactIdSchema.parse(request.params);
    const artifact = await dependencies.repository.findById(artifactId);
    if (!artifact) throw notFound();
    return toResponse(artifact, dependencies.config.artifactRoot);
  });

  // A bundle is immutable while published. Directory identity changes on the
  // pipeline's staged replacement; cache only that bundle's authorized file graph.
  const bundles = new Map<string, { identity: string; files: Set<string> }>();
  app.get("/files/:artifactId/*", async (request, reply) => {
    const { artifactId, "*": filename } = artifactFileSchema.parse(request.params);
    const artifact = await dependencies.repository.findById(artifactId);
    if (!artifact) throw notFound();
    const directory = dirname(artifact.contentPath);
    const root = dependencies.config.artifactRoot;
    let files: Set<string>;
    try {
      const info = await lstat(join(root, directory));
      if (!info.isDirectory()) throw notFound();
      const identity = `${info.dev}:${info.ino}:${info.mtimeMs}`;
      let cached = bundles.get(artifact.id);
      if (!cached || cached.identity !== identity) {
        cached = { identity, files: await derivativeFiles(root, artifact.contentPath) };
        bundles.set(artifact.id, cached);
      }
      files = cached.files;
      const path = join(directory, filename);
      if (!files.has(path)) throw notFound();
      await regularFile(root, path);
      return sendPublicDerivativeFile(reply, path, artifactComponentMimeType(filename));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      request.log.warn({ artifactId }, "Rejected invalid derivative bundle or file");
      throw notFound();
    }
  });

  app.get("/files/:artifactId/thumbnail", async (request, reply) => {
    const { artifactId } = artifactIdSchema.parse(request.params);
    const artifact = await dependencies.repository.findById(artifactId);
    if (!artifact?.thumbnailPath) throw notFound();
    if (!/^thumbnails\/[a-z0-9][a-z0-9-]*\.(webp|png|jpe?g)$/.test(artifact.thumbnailPath)) throw notFound();
    try { await regularFile(dependencies.config.artifactRoot, artifact.thumbnailPath); }
    catch { throw notFound(); }
    return sendPublicDerivativeFile(reply, artifact.thumbnailPath, thumbnailMimeType(artifact.thumbnailPath));
  });
}

function artifactComponentMimeType(filename: string): string {
  if (/\.glb$/i.test(filename)) return "model/gltf-binary";
  if (/\.json$/i.test(filename)) return "application/json";
  if (/\.webp$/i.test(filename)) return "image/webp";
  return "application/octet-stream";
}

function thumbnailMimeType(path: string): string {
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.png$/i.test(path)) return "image/png";
  return "image/webp";
}

async function toResponse(artifact: ArtifactRecord, root: string) {
  let lodUrl: string | null = null;
  if (/^derivatives\/[a-z0-9][a-z0-9-]*\/(content\.glb|meta\.json)$/.test(artifact.contentPath)) {
    try {
      await regularFile(root, join(dirname(artifact.contentPath), "lod.json"));
      lodUrl = `/files/${artifact.id}/lod.json`;
    } catch { /* Legacy derivatives remain usable without an LOD bundle. */ }
  }
  return {
    id: artifact.id,
    title: artifact.title,
    description: artifact.description,
    type: artifact.type,
    thumbnailUrl: artifact.thumbnailPath ? `/files/${artifact.id}/thumbnail` : null,
    contentUrl: `/files/${artifact.id}/${encodeURIComponent(artifact.contentFilename)}`,
    lodUrl,
    sizeBytes: artifact.sizeBytes
  };
}

function sendPublicDerivativeFile(reply: FastifyReply, relativePath: string, mimeType: string) {
  if (relativePath.endsWith(".bin.gz")) reply.header("Content-Encoding", "gzip");
  reply
    .header("Cache-Control", "private, no-store")
    .header("Pragma", "no-cache")
    .type(mimeType);
  return reply.sendFile(relativePath, {
    acceptRanges: !relativePath.endsWith(".bin.gz"),
    cacheControl: false,
    dotfiles: "deny",
    etag: false,
    lastModified: false
  });
}

function notFound() {
  return new HttpError(404, "artifact_not_found", "The artifact was not found.");
}
