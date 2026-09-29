import { build } from "esbuild";
// The generated Prisma client locates its native engine relative to itself,
// so it stays a separate file and is required from dist-electron at runtime.
const prismaClient = {
  name: "prisma-client-external",
  setup(b) {
    b.onResolve({ filter: /(^|\/)generated$/ }, (args) =>
      args.resolveDir.includes("packages/database") ||
      args.path.includes("packages/database")
        ? { path: "../packages/database/generated/index.js", external: true }
        : undefined,
    );
  },
};
await build({
  entryPoints: {
    main: "apps/desktop/electron/main.ts",
    preload: "apps/desktop/electron/preload.ts",
    "preload-floating": "apps/desktop/electron/preload-floating.ts",
  },
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  plugins: [prismaClient],
  supported: { "dynamic-import": false },
  sourcemap: true,
});
