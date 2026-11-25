/** A file that Bun embeds in the executable (`with { type: "file" }`): the import is its path. */
declare module "*/pi-env" {
  const path: string;
  export default path;
}
