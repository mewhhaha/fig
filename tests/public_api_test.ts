import { assert, assertEquals } from "jsr:@std/assert@1";
import * as fig from "../src/mod.ts";
import * as unstable from "../src/unstable.ts";
import { FIG_VERSION } from "../src/version.ts";

Deno.test("public package version matches deno metadata", async () => {
  const metadata = JSON.parse(await Deno.readTextFile("deno.json")) as { version?: string };
  assertEquals(metadata.version, FIG_VERSION);
});

Deno.test("root API stays focused and optimizer internals are under unstable", () => {
  assertEquals(typeof fig.checkSource, "function");
  assertEquals(typeof fig.compileArtifactsFromSource, "function");
  assertEquals(typeof fig.formatSource, "function");
  assertEquals(typeof fig.FIG_VERSION, "string");
  assert(!("optimizeProgram" in fig));
  assert(!("summarizeOptimizationPlan" in fig));
  assertEquals(typeof unstable.optimizeProgram, "function");
  assertEquals(typeof unstable.summarizeOptimizationPlan, "function");
});
