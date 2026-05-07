const root = new URL("../", import.meta.url).pathname;
const parser = `${root}generated/baba-workbench/src/parser.c`;
const object = `${root}helix/runtime/grammars/fig.o`;
const output = `${root}helix/runtime/grammars/fig.so`;
const generatedQueries = `${root}generated/baba-workbench/queries`;
const helixQueries = `${root}helix/runtime/queries/fig`;

await Deno.mkdir(`${root}helix/runtime/grammars`, { recursive: true });
await Deno.remove(helixQueries, { recursive: true }).catch(() => {});
await Deno.mkdir(helixQueries, { recursive: true });
for await (const entry of Deno.readDir(generatedQueries)) {
  if (!entry.isFile || !entry.name.endsWith(".scm")) continue;
  await Deno.copyFile(`${generatedQueries}/${entry.name}`, `${helixQueries}/${entry.name}`);
}

await run("tree-sitter", ["generate"], `${root}generated/baba-workbench`);
await run("cc", ["-fPIC", "-I", `${root}generated/baba-workbench/src`, "-c", parser, "-o", object]);
await run("cc", ["-shared", object, "-o", output]);
await Deno.remove(object);

async function run(command: string, args: string[], cwd = root) {
  const child = new Deno.Command(command, {
    args,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.output();
  if (!status.success) throw new Error(`${command} ${args.join(" ")} failed`);
}
