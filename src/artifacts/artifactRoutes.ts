import type { FastifyInstance, FastifyReply } from "fastify";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { RequestAuthenticator } from "../auth/RequestAuthenticator.js";
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
  filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/)
});

export interface ArtifactRouteDependencies {
  repository: ArtifactRepository;
  authenticator: RequestAuthenticator;
}

export async function registerArtifactRoutes(
  app: FastifyInstance,
  dependencies: ArtifactRouteDependencies
) {
  app.get("/api/v1/artifacts", async (request) => {
    const principal = await dependencies.authenticator.authenticate(request);
    const search = searchSchema.parse(request.query);
    const page = await dependencies.repository.searchAuthorized({
      subject: principal.subject,
      limit: search.limit,
      ...(search.query ? { query: search.query } : {}),
      ...(search.type ? { type: search.type } : {}),
      ...(search.cursor ? { cursor: search.cursor } : {})
    });
    return {
      items: page.items.map(toResponse),
      nextCursor: page.nextCursor
    };
  });

  app.get("/api/v1/artifacts/:artifactId", async (request) => {
    const principal = await dependencies.authenticator.authenticate(request);
    const { artifactId } = artifactIdSchema.parse(request.params);
    const artifact = await dependencies.repository.findAuthorizedById(principal.subject, artifactId);
    if (!artifact) throw notFound();
    return toResponse(artifact);
  });

  app.get("/files/:artifactId/:filename", async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(request);
    const { artifactId, filename } = artifactFileSchema.parse(request.params);
    const artifact = await dependencies.repository.findAuthorizedById(principal.subject, artifactId);
    const file = artifact && resolveArtifactFile(artifact, filename);
    if (!file) throw notFound();
    return sendProtectedFile(reply, file.path, file.mimeType);
  });

  app.get("/files/:artifactId/thumbnail", async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(request);
    const { artifactId } = artifactIdSchema.parse(request.params);
    const artifact = await dependencies.repository.findAuthorizedById(principal.subject, artifactId);
    if (!artifact?.thumbnailPath) throw notFound();
    return sendProtectedFile(reply, artifact.thumbnailPath, thumbnailMimeType(artifact.thumbnailPath));
  });
}

function resolveArtifactFile(
  artifact: ArtifactRecord,
  filename: string
): { path: string; mimeType: string } | null {
  if (filename === artifact.contentFilename) {
    return { path: artifact.contentPath, mimeType: artifact.mimeType };
  }

  // A SOG artifact is an isolated directory containing meta.json and its texture components.
  // Each component request reaches this route and repeats authentication and authorization.
  if (artifact.contentFilename === "meta.json" && dirname(artifact.contentPath) !== ".") {
    return { path: join(dirname(artifact.contentPath), filename), mimeType: artifactComponentMimeType(filename) };
  }
  return null;
}

function artifactComponentMimeType(filename: string): string {
  if (/\.json$/i.test(filename)) return "application/json";
  if (/\.webp$/i.test(filename)) return "image/webp";
  return "application/octet-stream";
}

function thumbnailMimeType(path: string): string {
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.png$/i.test(path)) return "image/png";
  return "image/webp";
}

function toResponse(artifact: ArtifactRecord) {
  return {
    id: artifact.id,
    title: artifact.title,
    description: artifact.description,
    type: artifact.type,
    thumbnailUrl: artifact.thumbnailPath ? `/files/${artifact.id}/thumbnail` : null,
    contentUrl: `/files/${artifact.id}/${encodeURIComponent(artifact.contentFilename)}`,
    sizeBytes: artifact.sizeBytes
  };
}

function sendProtectedFile(reply: FastifyReply, relativePath: string, mimeType: string) {
  reply
    .header("Cache-Control", "private, no-store")
    .header("Pragma", "no-cache")
    .type(mimeType);
  return reply.sendFile(relativePath, {
    acceptRanges: true,
    cacheControl: false,
    dotfiles: "deny",
    etag: false,
    lastModified: false
  });
}

function notFound() {
  return new HttpError(404, "artifact_not_found", "The artifact was not found.");
}
