const root = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const home = Deno.env.get("HOME");
if (!home) throw new Error("HOME is not set");

const configRoot = Deno.env.get("XDG_CONFIG_HOME") ?? `${home}/.config`;
const helixConfig = Deno.env.get("FIG_HELIX_CONFIG") ?? `${configRoot}/helix`;
const helixRuntime = Deno.env.get("FIG_HELIX_RUNTIME") ?? `${helixConfig}/runtime`;

const languagesPath = `${helixConfig}/languages.toml`;
const grammarOut = `${helixRuntime}/grammars/fig.so`;
const queryOut = `${helixRuntime}/queries/fig`;

await Deno.mkdir(`${helixRuntime}/grammars`, { recursive: true });
await Deno.mkdir(queryOut, { recursive: true });
await Deno.mkdir(helixConfig, { recursive: true });

await Deno.copyFile(`${root}/helix/runtime/grammars/fig.so`, grammarOut);

for await (const entry of Deno.readDir(`${root}/helix/runtime/queries/fig`)) {
  if (!entry.isFile) continue;
  await Deno.copyFile(
    `${root}/helix/runtime/queries/fig/${entry.name}`,
    `${queryOut}/${entry.name}`,
  );
}

const block = `# BEGIN fig managed
[[language]]
name = "fig"
scope = "source.fig"
file-types = ["fig"]
grammar = "fig"
roots = ["deno.json", "grammar.ebnf"]
comment-token = "//"
indent = { tab-width = 2, unit = "  " }

[[grammar]]
name = "fig"
source = { path = "${root}/generated/baba-workbench" }
# END fig managed
`;

const begin = "# BEGIN fig managed";
const end = "# END fig managed";
let existing = await Deno.readTextFile(languagesPath).catch(() => "");
const start = existing.indexOf(begin);
const stop = existing.indexOf(end);
if (start >= 0 && stop >= start) {
  existing = `${existing.slice(0, start).trimEnd()}\n\n${block}${
    existing.slice(stop + end.length).trimStart()
  }`;
} else {
  existing = existing.trimEnd() ? `${existing.trimEnd()}\n\n${block}` : block;
}
await Deno.writeTextFile(languagesPath, `${existing.trim()}\n`);

console.log(`installed Helix language config: ${languagesPath}`);
console.log(`installed Helix grammar: ${grammarOut}`);
console.log(`installed Helix queries: ${queryOut}`);
