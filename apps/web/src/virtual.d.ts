declare module "virtual:ts-env" {
  /** TypeScript lib files by name, e.g. "lib.es2022.d.ts". */
  export const libs: Record<string, string>
  /** The SDK's authoring sources by file name. */
  export const sdk: Record<string, string>
}
