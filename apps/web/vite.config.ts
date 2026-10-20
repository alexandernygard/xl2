import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const require = createRequire(import.meta.url)

/**
 * `virtual:ts-env`: what the in-browser TypeScript checker needs, as strings.
 * The ES2022 lib files (following their /// <reference lib> chain) and the
 * SDK's authoring sources, so the editor checks against the real types.
 */
function tsEnv(): Plugin {
  const id = "virtual:ts-env"
  const resolved = "\0" + id
  const libDir = dirname(require.resolve("typescript/lib/lib.es2022.d.ts"))
  const sdkDir = resolve(__dirname, "../../packages/sdk/src")
  return {
    name: "xl2-ts-env",
    resolveId: (source) => (source === id ? resolved : undefined),
    load(loadId) {
      if (loadId !== resolved) return
      const libs: Record<string, string> = {}
      const visit = (name: string) => {
        const file = `lib.${name}.d.ts`
        if (libs[file] !== undefined) return
        const text = readFileSync(join(libDir, file), "utf8")
        libs[file] = text
        for (const m of text.matchAll(/\/\/\/\s*<reference lib="([^"]+)"/g)) visit(m[1])
      }
      visit("es2022")
      const sdk: Record<string, string> = {}
      for (const f of ["types.ts", "builders.ts", "functions.ts"]) {
        const path = join(sdkDir, f)
        this.addWatchFile(path)
        sdk[f] = readFileSync(path, "utf8")
      }
      return `export const libs = ${JSON.stringify(libs)}\nexport const sdk = ${JSON.stringify(sdk)}\n`
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), tsEnv()],
  worker: { format: "es", plugins: () => [tsEnv()] },
  server: { port: 5199 },
})
