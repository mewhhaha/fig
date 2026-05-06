const root = new URL("../", import.meta.url).pathname;

await run("tree-sitter", ["generate"], `${root}generated/baba-workbench`);
await run("tree-sitter", ["build", "--wasm"], `${root}generated/baba-workbench`);

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
