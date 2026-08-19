import { resolve } from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  DATABASE_URL: z.string().min(1),
  ARTIFACT_ROOT: z.string().min(1).default("./data/assets")
});

export interface AppConfig {
  environment: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  artifactRoot: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);

  return {
    environment: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    artifactRoot: resolve(parsed.ARTIFACT_ROOT)
  };
}
