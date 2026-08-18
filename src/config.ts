import { resolve } from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  DATABASE_URL: z.string().min(1),
  ARTIFACT_ROOT: z.string().min(1).default("./data/assets"),
  AUTH_MODE: z.enum(["demo-session", "oidc-bearer"]).default("demo-session"),
  DEMO_USERNAME: z.string().min(1).optional(),
  DEMO_PASSWORD_HASH: z.string().min(1).optional(),
  DEMO_SESSION_KEY: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  DEMO_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(3_600),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).optional(),
  OIDC_JWKS_URI: z.string().url().optional()
});

export type AuthConfig =
  | {
      mode: "demo-session";
      username: string;
      passwordHash: string;
      sessionKey: Buffer;
      sessionTtlSeconds: number;
    }
  | {
      mode: "oidc-bearer";
      issuer: string;
      audience: string;
      jwksUri: string;
    };

export interface AppConfig {
  environment: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  artifactRoot: string;
  auth: AuthConfig;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const auth: AuthConfig = parsed.AUTH_MODE === "demo-session"
    ? {
        mode: "demo-session",
        username: required(parsed.DEMO_USERNAME, "DEMO_USERNAME"),
        passwordHash: required(parsed.DEMO_PASSWORD_HASH, "DEMO_PASSWORD_HASH"),
        sessionKey: Buffer.from(required(parsed.DEMO_SESSION_KEY, "DEMO_SESSION_KEY"), "hex"),
        sessionTtlSeconds: parsed.DEMO_SESSION_TTL_SECONDS
      }
    : {
        mode: "oidc-bearer",
        issuer: required(parsed.OIDC_ISSUER, "OIDC_ISSUER"),
        audience: required(parsed.OIDC_AUDIENCE, "OIDC_AUDIENCE"),
        jwksUri: required(parsed.OIDC_JWKS_URI, "OIDC_JWKS_URI")
      };

  return {
    environment: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    artifactRoot: resolve(parsed.ARTIFACT_ROOT),
    auth
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for the selected authentication mode.`);
  return value;
}
