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

await copyIfDifferent(`${root}/helix/runtime/grammars/fig.so`, grammarOut);

for await (const entry of Deno.readDir(`${root}/helix/runtime/queries/fig`)) {
  if (!entry.isFile) continue;
  await copyIfDifferent(
    `${root}/helix/runtime/queries/fig/${entry.name}`,
    `${queryOut}/${entry.name}`,
  );
}

const block = `# BEGIN fig managed
[language-server.fig-lsp]
command = "deno"
args = ["task", "--cwd", "${root}", "lsp"]

[[language]]
name = "fig"
scope = "source.fig"
file-types = ["fig"]
grammar = "fig"
roots = ["deno.json", "grammar.ebnf"]
comment-token = "//"
indent = { tab-width = 2, unit = "  " }
language-servers = ["fig-lsp"]
formatter = { command = "deno", args = ["run", "--allow-read", "${root}/src/cli.ts", "fmt", "-"] }
auto-format = true

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
  existing = `${existing.slice(0, start).trimEnd()}\n\n${
    existing.slice(stop + end.length).trimStart()
  }`;
}
existing = removeExistingFigConfig(existing);
existing = existing.trimEnd() ? `${existing.trimEnd()}\n\n${block}` : block;
await Deno.writeTextFile(languagesPath, `${existing.trim()}\n`);

function removeExistingFigConfig(source: string): string {
  return source
    .replace(
      /\n?\[language-server\.fig-lsp\][\s\S]*?(?=\n(?:\[language-server\.|\[\[language\]\]|\[\[grammar\]\])|$)/g,
      "",
    )
    .replace(
      /\n?\[\[language\]\]\nname = "fig"[\s\S]*?(?=\n(?:\[language-server\.|\[\[language\]\]|\[\[grammar\]\])|$)/g,
      "",
    )
    .replace(
      /\n?\[\[grammar\]\]\nname = "fig"[\s\S]*?(?=\n(?:\[language-server\.|\[\[language\]\]|\[\[grammar\]\])|$)/g,
      "",
    )
    .trim();
}

console.log(`installed Helix language config: ${languagesPath}`);
console.log(`installed Helix grammar: ${grammarOut}`);
console.log(`installed Helix queries: ${queryOut}`);

async function copyIfDifferent(from: string, to: string): Promise<void> {
  if (from === to) return;
  await Deno.copyFile(from, to);
}
