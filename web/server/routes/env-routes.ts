import { existsSync } from "node:fs";
import type { Hono } from "hono";
import { join } from "node:path";
import * as envManager from "../env-manager.js";
import { containerManager } from "../container-manager.js";
import { imagePullManager } from "../image-pull-manager.js";

export function registerEnvRoutes(
  api: Hono,
  options: { webDir: string },
): void {
  api.get("/envs", (c) => {
    try {
      return c.json(envManager.listEnvs());
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/envs/:slug", (c) => {
    const env = envManager.getEnv(c.req.param("slug"));
    if (!env) return c.json({ error: "Environment not found" }, 404);
    return c.json(env);
  });

  api.post("/envs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const env = envManager.createEnv(body.name, body.variables || {}, {
        dockerfile: body.dockerfile,
        baseImage: body.baseImage,
        ports: body.ports,
        volumes: body.volumes,
        initScript: body.initScript,
      });
      return c.json(env, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/envs/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({}));
    try {
      const env = envManager.updateEnv(slug, {
        name: body.name,
        variables: body.variables,
        dockerfile: body.dockerfile,
        imageTag: body.imageTag,
        baseImage: body.baseImage,
        ports: body.ports,
        volumes: body.volumes,
        initScript: body.initScript,
      });
      if (!env) return c.json({ error: "Environment not found" }, 404);
      return c.json(env);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/envs/:slug", (c) => {
    const deleted = envManager.deleteEnv(c.req.param("slug"));
    if (!deleted) return c.json({ error: "Environment not found" }, 404);
    return c.json({ ok: true });
  });

  api.post("/envs/:slug/build", async (c) => {
    const slug = c.req.param("slug");
    const env = envManager.getEnv(slug);
    if (!env) return c.json({ error: "Environment not found" }, 404);
    if (!env.dockerfile) return c.json({ error: "No Dockerfile configured for this environment" }, 400);
    if (!containerManager.checkDocker()) return c.json({ error: "Docker is not available" }, 503);

    const tag = `companion-env-${slug}:latest`;
    envManager.updateBuildStatus(slug, "building");

    try {
      const result = await containerManager.buildImageStreaming(env.dockerfile, tag);
      if (result.success) {
        envManager.updateBuildStatus(slug, "success", { imageTag: tag });
        return c.json({ success: true, imageTag: tag, log: result.log });
      } else {
        envManager.updateBuildStatus(slug, "error", { error: result.log.slice(-500) });
        return c.json({ success: false, log: result.log }, 500);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      envManager.updateBuildStatus(slug, "error", { error: msg });
      return c.json({ success: false, error: msg }, 500);
    }
  });

  api.get("/envs/:slug/build-status", (c) => {
    const env = envManager.getEnv(c.req.param("slug"));
    if (!env) return c.json({ error: "Environment not found" }, 404);
    return c.json({
      buildStatus: env.buildStatus || "idle",
      buildError: env.buildError,
      lastBuiltAt: env.lastBuiltAt,
      imageTag: env.imageTag,
    });
  });

  api.post("/docker/build-base", async (c) => {
    if (!containerManager.checkDocker()) return c.json({ error: "Docker is not available" }, 503);
    const dockerfilePath = join(options.webDir, "docker", "Dockerfile.the-companion");
    if (!existsSync(dockerfilePath)) {
      return c.json({ error: "Base Dockerfile not found at " + dockerfilePath }, 404);
    }
    try {
      const log = containerManager.buildImage(dockerfilePath, "the-companion:latest");
      return c.json({ success: true, log });
    } catch (e: unknown) {
      return c.json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/docker/base-image", (c) => {
    const exists = containerManager.imageExists("the-companion:latest");
    return c.json({ exists, image: "the-companion:latest" });
  });

  api.get("/images/:tag/status", (c) => {
    const tag = decodeURIComponent(c.req.param("tag"));
    if (!tag) return c.json({ error: "Image tag is required" }, 400);
    return c.json(imagePullManager.getState(tag));
  });

  api.post("/images/:tag/pull", (c) => {
    const tag = decodeURIComponent(c.req.param("tag"));
    if (!tag) return c.json({ error: "Image tag is required" }, 400);
    if (!containerManager.checkDocker()) {
      return c.json({ error: "Docker is not available" }, 503);
    }
    imagePullManager.pull(tag);
    return c.json({ ok: true, state: imagePullManager.getState(tag) });
  });
}
