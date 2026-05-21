import { buildReleaseBinaries } from "./build_release_binaries.ts";

const tempDir = await Deno.makeTempDir({ prefix: "fig-release-binary-" });

try {
  await buildReleaseBinaries({ tag: "check", outDir: tempDir, nativeOnly: true });
  const artifacts = [];
  for await (const entry of Deno.readDir(tempDir)) {
    if (entry.isFile) artifacts.push(entry.name);
  }
  const hasArchive = artifacts.some((name) => name.endsWith(".tar.gz") || name.endsWith(".zip"));
  if (!hasArchive) throw new Error("release binary check did not create an archive");
  if (!artifacts.includes("SHA256SUMS")) {
    throw new Error("release binary check did not create SHA256SUMS");
  }
} finally {
  await Deno.remove(tempDir, { recursive: true }).catch(() => {});
}
