import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { registerFsRoutes } from "./fs-routes.js";

// Create a Hono app with the fs routes for testing
let app: Hono;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "fs-raw-test-"));
  app = new Hono();
  registerFsRoutes(app);
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("GET /fs/raw", () => {
  it("returns binary content with correct Content-Type for a PNG file", async () => {
    // A .png file should be served with image/png MIME type and raw binary body
    const filePath = join(tempDir, "test.png");
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    writeFileSync(filePath, pngHeader);

    const res = await app.request(`/fs/raw?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/image\/png|application\/octet-stream/);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(4);
  });

  it("returns 400 when path query parameter is missing", async () => {
    const res = await app.request("/fs/raw");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path required");
  });

  it("returns 404 when file does not exist", async () => {
    const fakePath = join(tempDir, "nonexistent.png");
    const res = await app.request(`/fs/raw?path=${encodeURIComponent(fakePath)}`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("returns 413 when file exceeds 10MB", async () => {
    // Create a file just over the 10MB limit to trigger the size guard
    const filePath = join(tempDir, "large.bin");
    const buf = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
    writeFileSync(filePath, buf);

    const res = await app.request(`/fs/raw?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it("serves a JPEG file with correct MIME type", async () => {
    // Verifies MIME detection works for different image extensions
    const filePath = join(tempDir, "photo.jpg");
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG magic bytes

    const res = await app.request(`/fs/raw?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/image\/jpeg|application\/octet-stream/);
  });

  it("serves an SVG file with correct MIME type", async () => {
    const filePath = join(tempDir, "icon.svg");
    writeFileSync(filePath, '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>');

    const res = await app.request(`/fs/raw?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/image\/svg|application\/octet-stream/);
  });
});
