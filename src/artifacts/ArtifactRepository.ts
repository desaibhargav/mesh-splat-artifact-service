export type ArtifactType = "mesh" | "splat";

export interface ArtifactRecord {
  id: string;
  title: string;
  description: string;
  type: ArtifactType;
  thumbnailPath: string | null;
  contentPath: string;
  contentFilename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ArtifactPage {
  items: ArtifactRecord[];
  nextCursor: string | null;
}

export interface ArtifactSearch {
  subject: string;
  query?: string;
  type?: ArtifactType;
  cursor?: string;
  limit: number;
}

export interface ArtifactRepository {
  searchAuthorized(search: ArtifactSearch): Promise<ArtifactPage>;
  findAuthorizedById(subject: string, artifactId: string): Promise<ArtifactRecord | null>;
}
