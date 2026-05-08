import { assert, assertStringIncludes } from "jsr:@std/assert@1";
import { checkSource, CompileError } from "../src/mod.ts";

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

async function fixtureFiles(kind: "good" | "bad") {
  const root = `tests/fixtures/language/${kind}`;
  const files: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (entry.isFile && entry.name.endsWith(".fig")) files.push(`${root}/${entry.name}`);
  }
  return files.sort();
}

Deno.test("language reference good fixtures check", async () => {
  const files = await fixtureFiles("good");
  assert(files.length > 0);
  for (const file of files) {
    try {
      await checkSource(await Deno.readTextFile(file), { resolveModule });
    } catch (error) {
      if (error instanceof CompileError) {
        throw new Error(
          `${file} failed: ${error.diagnostics.map((diagnostic) => diagnostic.code).join(", ")}`,
        );
      }
      throw error;
    }
  }
});

Deno.test("language reference bad fixtures report expected diagnostics", async () => {
  const files = await fixtureFiles("bad");
  assert(files.length > 0);
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    const firstLine = source.split(/\r?\n/, 1)[0];
    const match = firstLine.match(/^\/\/ expect: ([a-z0-9_.]+)$/);
    if (!match) throw new Error(`${file} missing first-line expectation`);
    try {
      await checkSource(source, { resolveModule });
      throw new Error(`${file} unexpectedly checked`);
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      assertStringIncludes(
        error.diagnostics.map((diagnostic) => diagnostic.code).join("\n"),
        match[1],
      );
    }
  }
});
