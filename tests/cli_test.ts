import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { type CliIo, type CliWatchEvent, runCli } from "../src/cli_app.ts";
import { FIG_VERSION } from "../src/version.ts";

interface MockWatchEvent extends CliWatchEvent {
  before?: () => void;
}

function mockIo(
  files: Record<string, string> = {},
  stdin = "",
  watchEvents: MockWatchEvent[] = [],
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writes = new Map<string, string | Uint8Array>();
  const watchCalls: string[][] = [];
  let lspRuns = 0;
  const io: CliIo = {
    async readTextFile(path) {
      if (path in files) return files[path]!;
      throw new Deno.errors.NotFound(path);
    },
    async writeTextFile(path, data) {
      writes.set(path, data);
    },
    async writeFile(path, data) {
      writes.set(path, data);
    },
    watch(paths) {
      watchCalls.push(paths);
      let closed = false;
      return {
        close() {
          closed = true;
        },
        async *[Symbol.asyncIterator]() {
          while (!closed && watchEvents.length) {
            const event = watchEvents.shift()!;
            event.before?.();
            yield { paths: event.paths };
          }
        },
      };
    },
    async stdinText() {
      return stdin;
    },
    stdout(text) {
      stdout.push(text);
    },
    stderr(text) {
      stderr.push(text);
    },
    async runLsp() {
      lspRuns++;
    },
  };
  return { io, stdout, stderr, writes, watchCalls, lspRuns: () => lspRuns };
}

function cwdPath(path: string): string {
  return new URL(path, `file://${Deno.cwd()}/`).pathname;
}

Deno.test("CLI version prints central Fig version", async () => {
  const harness = mockIo();
  assertEquals(await runCli(["version"], harness.io), 0);
  assertEquals(harness.stdout, [FIG_VERSION]);
  assertEquals(harness.stderr, []);
});

Deno.test("CLI lsp runs language server entry without a file argument", async () => {
  const harness = mockIo();
  assertEquals(await runCli(["lsp"], harness.io), 0);
  assertEquals(harness.lspRuns(), 1);
});

Deno.test("CLI lsp rejects extra args", async () => {
  const harness = mockIo();
  assertEquals(await runCli(["lsp", "extra"], harness.io), 2);
  assertEquals(harness.lspRuns(), 0);
  assertStringIncludes(harness.stderr.join("\n"), "fig lsp");
});

Deno.test("CLI usage reports missing command", async () => {
  const harness = mockIo();
  assertEquals(await runCli([], harness.io), 2);
  assertStringIncludes(harness.stderr.join("\n"), "usage: fig");
});

Deno.test("CLI wat honors debug and release flags", async () => {
  const source = `
    fn add1(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 { add1(41) }
  `;
  const debug = mockIo({ "main.fig": source });
  assertEquals(await runCli(["wat", "main.fig"], debug.io), 0);
  assertStringIncludes(debug.stdout.join("\n"), "call $add1");

  const release = mockIo({ "main.fig": source });
  assertEquals(await runCli(["wat", "main.fig", "--release"], release.io), 0);
  assert(!release.stdout.join("\n").includes("call $add1"));
});

Deno.test("CLI run prints debug traces to stderr and release erases them", async () => {
  const source = `
    pub fn main() -> i32 {
      @trace("entered main");
      42
    }
  `;

  const debug = mockIo({ "main.fig": source });
  assertEquals(await runCli(["run", "main.fig"], debug.io), 0);
  assertEquals(debug.stdout, ["42"]);
  assertEquals(debug.stderr, ["[trace] entered main"]);

  const release = mockIo({ "main.fig": source });
  assertEquals(await runCli(["run", "main.fig", "--release"], release.io), 0);
  assertEquals(release.stdout, ["42"]);
  assertEquals(release.stderr, []);
});

Deno.test("CLI run prints runtime profile summary when enabled", async () => {
  const source = `pub fn main() -> i32 { @profile("work") { 42 } }`;
  const harness = mockIo({ "main.fig": source });

  assertEquals(await runCli(["run", "main.fig", "--runtime-profile"], harness.io), 0);
  assertEquals(harness.stdout, ["42"]);
  assertStringIncludes(harness.stderr.join("\n"), "[profile] label count total_ms avg_ms");
  assertStringIncludes(harness.stderr.join("\n"), `[profile] "work" 1`);
});

Deno.test("CLI compile profile reports compiler phase timings", async () => {
  const harness = mockIo({ "main.fig": "pub fn main() -> i32 { 42 }" });

  assertEquals(await runCli(["check", "main.fig", "--compile-profile"], harness.io), 0);
  assertEquals(harness.stdout, ["ok"]);
  assertStringIncludes(harness.stderr.join("\n"), "[compile-profile] phase ms");
  assertStringIncludes(harness.stderr.join("\n"), "parse.syntax");
  assertStringIncludes(harness.stderr.join("\n"), "check.checkFn loop");

  const wat = mockIo({ "main.fig": "pub fn main() -> i32 { 42 }" });
  assertEquals(await runCli(["wat", "main.fig", "--compile-profile"], wat.io), 0);
  assertStringIncludes(wat.stderr.join("\n"), "backend.layout.fixed_array_plans");
});

Deno.test("CLI rejects unsupported ABI mode flag", async () => {
  const harness = mockIo({ "main.fig": "pub fn main() -> i32 { 42 }" });
  assertEquals(await runCli(["wat", "main.fig", "--abi", "legacy"], harness.io), 2);
  assertStringIncludes(harness.stderr.join("\n"), "usage: fig");
});

Deno.test("CLI rejects unsupported memory mode", async () => {
  const harness = mockIo({ "main.fig": "pub fn main() -> i32 { 42 }" });
  assertEquals(await runCli(["wat", "main.fig", "--memory", "legacy"], harness.io), 2);
  assertStringIncludes(harness.stderr.join("\n"), "usage: fig");
});

Deno.test("CLI build writes explicit output path", async () => {
  const harness = mockIo({ "main.fig": "pub fn main() -> i32 { 42 }" });
  assertEquals(await runCli(["build", "main.fig", "--out", "out/main.wasm"], harness.io), 0);
  assert(harness.writes.get("out/main.wasm") instanceof Uint8Array);
  assertEquals(harness.stdout, ["out/main.wasm"]);
});

Deno.test("CLI watch rebuilds when an imported module changes", async () => {
  const libPath = cwdPath("lib.fig");
  const files = {
    "main.fig": `
      const lib = @import("./lib.fig");
      pub fn main() -> i32 { lib.value() }
    `,
    [libPath]: "fn value() -> i32 { 1 }",
  };
  const harness = mockIo(files, "", [
    {
      paths: [libPath],
      before: () => {
        files[libPath] = "fn value() -> i32 { 2 }";
      },
    },
  ]);

  assertEquals(await runCli(["watch", "main.fig", "--out", "out/main.wasm"], harness.io), 0);
  assert(harness.writes.get("out/main.wasm") instanceof Uint8Array);
  assertEquals(harness.stdout, ["out/main.wasm", "out/main.wasm"]);
  assert(harness.watchCalls.some((paths) => paths.includes(cwdPath("main.fig"))));
  assert(harness.watchCalls.some((paths) => paths.includes(libPath)));
});

Deno.test("CLI watch keeps last-good wasm stale on rebuild failure", async () => {
  const libPath = cwdPath("lib.fig");
  const files = {
    "main.fig": `
      const lib = @import("./lib.fig");
      pub fn main() -> i32 { lib.value() }
    `,
    [libPath]: "fn value() -> i32 { 1 }",
  };
  const harness = mockIo(files, "", [
    {
      paths: [libPath],
      before: () => {
        files[libPath] = "fn value( { 2 }";
      },
    },
  ]);

  assertEquals(await runCli(["watch", "main.fig", "--out", "out/main.wasm"], harness.io), 0);
  assert(harness.writes.get("out/main.wasm") instanceof Uint8Array);
  assertEquals(harness.stdout, ["out/main.wasm"]);
  assertStringIncludes(harness.stderr.join("\n"), "keeping out/main.wasm stale");
});
