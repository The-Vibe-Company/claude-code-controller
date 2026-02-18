import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CompanionEnv {
  name: string;
  slug: string;
  variables: Record<string, string>;

  // Docker configuration
  /** Raw Dockerfile content (stored inline). When present, used to build a custom image. */
  dockerfile?: string;
  /** Tag of the built image (e.g. "companion-env-myproject:latest") */
  imageTag?: string;
  /** Base image to use when no custom Dockerfile is provided (e.g. "the-companion:latest") */
  baseImage?: string;
  /** Current build status */
  buildStatus?: "idle" | "building" | "success" | "error";
  /** Last build error message */
  buildError?: string;
  /** Timestamp of last successful build */
  lastBuiltAt?: number;
  /** Container ports to expose */
  ports?: number[];
  /** Extra volume mounts in "host:container[:opts]" format */
  volumes?: string[];
  /** Shell script to run inside the container before the CLI session starts */
  initScript?: string;

  createdAt: number;
  updatedAt: number;
}

/** Fields that can be updated via the update API */
export interface EnvUpdateFields {
  name?: string;
  variables?: Record<string, string>;
  dockerfile?: string;
  imageTag?: string;
  baseImage?: string;
  ports?: number[];
  volumes?: string[];
  initScript?: string;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const COMPANION_DIR = join(homedir(), ".companion");
const ENVS_DIR = join(COMPANION_DIR, "envs");

function ensureDir(): void {
  mkdirSync(ENVS_DIR, { recursive: true });
}

function filePath(slug: string): string {
  return join(ENVS_DIR, `${slug}.json`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function listEnvs(): CompanionEnv[] {
  ensureDir();
  try {
    const files = readdirSync(ENVS_DIR).filter((f) => f.endsWith(".json"));
    const envs: CompanionEnv[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(ENVS_DIR, file), "utf-8");
        envs.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }
    envs.sort((a, b) => a.name.localeCompare(b.name));
    return envs;
  } catch {
    return [];
  }
}

export function getEnv(slug: string): CompanionEnv | null {
  ensureDir();
  try {
    const raw = readFileSync(filePath(slug), "utf-8");
    return JSON.parse(raw) as CompanionEnv;
  } catch {
    return null;
  }
}

/**
 * Return the effective Docker image for an environment.
 * Priority: imageTag (custom built) > baseImage (user-selected) > default.
 */
export function getEffectiveImage(slug: string): string | null {
  const env = getEnv(slug);
  if (!env) return null;
  return env.imageTag || env.baseImage || null;
}

export function createEnv(
  name: string,
  variables: Record<string, string> = {},
  docker?: {
    dockerfile?: string;
    baseImage?: string;
    ports?: number[];
    volumes?: string[];
    initScript?: string;
  },
): CompanionEnv {
  if (!name || !name.trim()) throw new Error("Environment name is required");
  const slug = slugify(name.trim());
  if (!slug) throw new Error("Environment name must contain alphanumeric characters");

  ensureDir();
  if (existsSync(filePath(slug))) {
    throw new Error(`An environment with a similar name already exists ("${slug}")`);
  }

  const now = Date.now();
  const env: CompanionEnv = {
    name: name.trim(),
    slug,
    variables,
    createdAt: now,
    updatedAt: now,
  };

  // Apply Docker config if provided
  if (docker) {
    if (docker.dockerfile !== undefined) env.dockerfile = docker.dockerfile;
    if (docker.baseImage !== undefined) env.baseImage = docker.baseImage;
    if (docker.ports !== undefined) env.ports = docker.ports;
    if (docker.volumes !== undefined) env.volumes = docker.volumes;
    if (docker.initScript !== undefined) env.initScript = docker.initScript;
  }

  writeFileSync(filePath(slug), JSON.stringify(env, null, 2), "utf-8");
  return env;
}

export function updateEnv(
  slug: string,
  updates: EnvUpdateFields,
): CompanionEnv | null {
  ensureDir();
  const existing = getEnv(slug);
  if (!existing) return null;

  const newName = updates.name?.trim() || existing.name;
  const newSlug = slugify(newName);
  if (!newSlug) throw new Error("Environment name must contain alphanumeric characters");

  // If name changed, check for slug collision with a different env
  if (newSlug !== slug && existsSync(filePath(newSlug))) {
    throw new Error(`An environment with a similar name already exists ("${newSlug}")`);
  }

  const env: CompanionEnv = {
    ...existing,
    name: newName,
    slug: newSlug,
    variables: updates.variables ?? existing.variables,
    updatedAt: Date.now(),
  };

  // Apply Docker field updates (only override if explicitly provided)
  if (updates.dockerfile !== undefined) env.dockerfile = updates.dockerfile;
  if (updates.imageTag !== undefined) env.imageTag = updates.imageTag;
  if (updates.baseImage !== undefined) env.baseImage = updates.baseImage;
  if (updates.ports !== undefined) env.ports = updates.ports;
  if (updates.volumes !== undefined) env.volumes = updates.volumes;
  if (updates.initScript !== undefined) env.initScript = updates.initScript;

  // If slug changed, delete old file
  if (newSlug !== slug) {
    try { unlinkSync(filePath(slug)); } catch { /* ok */ }
  }

  writeFileSync(filePath(newSlug), JSON.stringify(env, null, 2), "utf-8");
  return env;
}

/**
 * Update the build status fields of an environment.
 * Used during Docker image builds to track progress.
 */
export function updateBuildStatus(
  slug: string,
  status: CompanionEnv["buildStatus"],
  opts?: { error?: string; imageTag?: string },
): CompanionEnv | null {
  ensureDir();
  const existing = getEnv(slug);
  if (!existing) return null;

  existing.buildStatus = status;
  existing.updatedAt = Date.now();

  if (opts?.error !== undefined) existing.buildError = opts.error;
  if (opts?.imageTag !== undefined) existing.imageTag = opts.imageTag;
  if (status === "success") {
    existing.lastBuiltAt = Date.now();
    existing.buildError = undefined;
  }

  writeFileSync(filePath(slug), JSON.stringify(existing, null, 2), "utf-8");
  return existing;
}

export function deleteEnv(slug: string): boolean {
  ensureDir();
  if (!existsSync(filePath(slug))) return false;
  try {
    unlinkSync(filePath(slug));
    return true;
  } catch {
    return false;
  }
}
