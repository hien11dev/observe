import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // esbuild, Vite's default transformer, cannot emit the design-time type
  // metadata Nest's DI reads back at runtime. SWC can, so it handles the
  // TypeScript instead - configured to match tsconfig.json, because the
  // instrumentation reads class and function names back off `Error.stack`
  // and a downlevelled or name-mangled build changes what V8 prints there.
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2023",
        keepClassNames: true,
        parser: { syntax: "typescript", decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
    }),
  ],
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/**/*.int-spec.ts", "src/testing/**"],
    },
  },
});
