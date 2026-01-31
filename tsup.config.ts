import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "client/index": "src/client/index.ts",
    "server/index": "src/server/index.ts",
    "transport/tcp/index": "src/transport/tcp/index.ts",
    "transport/ws/index": "src/transport/ws/index.ts",
    "transport/http/index": "src/transport/http/index.ts",
    "errors/index": "src/errors/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  minify: false,
  treeshake: true,
  target: "node20",
  outDir: "dist",
  external: ["ws"],
});
