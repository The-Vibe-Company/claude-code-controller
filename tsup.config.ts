import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/api/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ["hono"],
});
