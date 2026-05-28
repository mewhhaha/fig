import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  checkSource,
  compileArtifactsFromSource as compileArtifactsFromSourceRaw,
  type CompileArtifactsOptions,
  COMPILER_PLUGIN_API_VERSION,
  type CompileSourceOptions,
  type CompileTraceEvent,
  compileWasmFromSource as compileWasmFromSourceRaw,
  createCompileCache,
  createCompilerPluginRegistry,
  createCompilerSession,
  moduleInterfaceKey,
  parse,
  tokenize,
  wasmFromSource as wasmFromSourceRaw,
  watFromSource as watFromSourceRaw,
} from "../src/mod.ts";
import {
  explainOptimization,
  OPTIMIZE_PROFILES,
  optimizeProgram,
  summarizeAbstractValues,
  summarizeOptimizationPlan,
  summarizeProgram,
  summarizeRecurrences,
} from "../src/unstable.ts";
import { CompileError } from "../src/diagnostics.ts";
import type { ConstDecl, Expr, FnDecl, Program, TypeDecl } from "../src/core_ast.ts";
import { type CompilerPlugin, compilerSpecialForm, isCompilerSpecialForm } from "../src/plugins.ts";
import {
  canonicalDomainKey,
  cardinality,
  domainContains,
  domainIsEmpty,
  intersectDomain,
  parseRefinedI32Type,
  refinedI32Assignable,
  refinedI32DomainDifference,
  refinedI32DomainIntersection,
  refinedI32DomainUnion,
  renderRefinedI32Domain,
  subtractDomain,
  unionDomain,
} from "../src/refined_scalar.ts";

const resolveProjectModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

const watFromSource = (source: string, options: CompileSourceOptions = {}) =>
  watFromSourceRaw(source, options);
const wasmFromSource = (source: string, options: CompileSourceOptions = {}) =>
  wasmFromSourceRaw(source, options);
const compileWasmFromSource = (source: string, options: CompileSourceOptions = {}) =>
  compileWasmFromSourceRaw(source, options);
const compileArtifactsFromSource =
  ((source: string, options: CompileArtifactsOptions = {}) =>
    (compileArtifactsFromSourceRaw as (
      source: string,
      options: CompileArtifactsOptions,
    ) => unknown)(source, options)) as typeof compileArtifactsFromSourceRaw;

async function assertFirstDiagnosticSpanIncludes(
  source: string,
  code: string,
  expectedSource: string,
) {
  try {
    await checkSource(source);
  } catch (error) {
    assert(error instanceof CompileError);
    assertEquals(error.diagnostics[0]?.code, code);
    const span = error.diagnostics[0]?.span;
    assert(span, JSON.stringify(error.diagnostics));
    assertStringIncludes(source.slice(span.start, span.end), expectedSource);
    return;
  }
  throw new Error(`expected ${code}`);
}

Deno.test("grammar metadata uses fig identity", async () => {
  const metadata = JSON.parse(await Deno.readTextFile("baba.json"));
  assertEquals(metadata.language.scope, "source.fig");
  assertEquals(metadata.language.fileTypes, ["fig"]);

  const packageJson = JSON.parse(await Deno.readTextFile("generated/baba-workbench/package.json"));
  assertEquals(packageJson.name, "tree-sitter-fig");
  assertEquals(packageJson["tree-sitter"][0].scope, "source.fig");
  assertEquals(packageJson["tree-sitter"][0]["file-types"], ["fig"]);
});

Deno.test("AST span metadata is hidden and semantic-neutral", async () => {
  const source = `
    fn add_one(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 { add_one(41) }
  `;
  const program = await parse(source);
  const main = program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "main"
  );
  assert(main);
  assert(main.span);
  assert(!Object.keys(main).includes("span"));
  assert(!JSON.stringify(main).includes('"span"'));
  assertEquals(main, {
    kind: "fn",
    public: true,
    name: "main",
    params: [],
    returnType: "i32",
    effects: [],
    body: main.body,
  });

  const wat = await watFromSource(source);
  assert(!wat.includes("span"));

  const imported = await checkSource(
    `
      const lib = @import("./lib.fig");
      pub fn main() -> i32 { lib.add_one(41) }
    `,
    {
      sourceId: "/tmp/app.fig",
      resolveModule(moduleName) {
        if (moduleName !== "./lib.fig") return undefined;
        return {
          sourceId: "/tmp/lib.fig",
          text: "fn add_one(x: i32) -> i32 { x + 1 }",
        };
      },
      pruneImports: true,
    },
  );
  const importedFn = imported.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "lib.add_one"
  );
  assert(importedFn);
  assert(importedFn.span);
  assert(!Object.keys(importedFn).includes("span"));
});

Deno.test("branch hints parse on match arms and function clauses", async () => {
  const parsed = await parse(`
    @unlikely fn score(false: bool) -> i32 { 0 }
    pub @likely fn score(true: bool) -> i32 { 1 }
    pub fn main(x: i32) -> i32 {
      match x {
        @likely 0 => score(true),
        @unlikely _ => score(false),
      }
    }
  `);
  const scoreClauses = findFns(parsed, "score");
  assertEquals(scoreClauses.map((fn) => fn.branchHint), ["unlikely", "likely"]);
  const main = findFn(parsed, "main");
  assert(main?.body.expr?.kind === "match");
  assertEquals(main.body.expr.arms.map((arm) => arm.branchHint), ["likely", "unlikely"]);

  const checked = await checkSource(`
    @likely fn score(true: bool) -> i32 { 1 }
    fn score(false: bool) -> i32 { 0 }
    pub fn main() -> i32 { score(true) }
  `);
  const dispatcher = findFn(checked.program, "score");
  assert(dispatcher?.body.expr?.kind === "match");
  assertEquals(dispatcher.body.expr.arms[0]?.branchHint, "likely");
});

Deno.test("branch hints reject unmapped source locations", async () => {
  await assertThrowsCompile(
    `@likely fn main() -> i32 { 1 }`,
    "branch_hint.unused",
  );
  await assertThrowsCompile(
    `pub fn main(x: i32) -> i32 { match x { @likely _ => 1 } }`,
    "branch_hint.unmapped",
  );
  await assertThrowsCompile(
    `pub fn main(x: i32) -> i32 { match x { @likely 0 => 1, @unlikely _ => 2 } }`,
    "branch_hint.unmapped",
  );
});

Deno.test("debug trace statements are text-only debug metadata", async () => {
  const artifact = await compileArtifactsFromSource(`
    pub fn main() -> i32 {
      @trace("entered main");
      7
    }
  `);

  assertEquals(artifact.debugTraces, [{ id: 0, message: "entered main" }]);
  assertStringIncludes(artifact.wat, `(import "env" "fig_trace"`);

  await checkSource(`
    pub fn traced() -> io(i32) {
      do @io(_) {
        @trace("inside do");
        return(1)
      }
    }
  `);
});

Deno.test("debug trace statements reject non-text forms", async () => {
  await assertThrowsCompile(
    `pub fn main() -> i32 { @trace(); 1 }`,
    "debug.trace_arity",
  );
  await assertThrowsCompile(
    `pub fn main() -> i32 { @trace(1); 1 }`,
    "debug.trace_message",
  );
  await assertThrowsCompile(
    `pub fn main() -> i32 { @trace("a", "b"); 1 }`,
    "debug.trace_arity",
  );
  await assertThrowsCompile(
    `pub fn main() -> i32 { let x = @trace("not an expression"); 1 }`,
    "debug.trace_context",
  );
});

Deno.test("runtime profile expressions preserve values and metadata when enabled", async () => {
  const artifact = await compileArtifactsFromSource(
    `pub fn main() -> i32 { @profile("work") { 40 + 2 } }`,
    { runtimeProfile: true },
  );

  assertEquals(artifact.profileSites, [{ id: 0, label: "work" }]);
  assertStringIncludes(artifact.wat, `(import "env" "fig_profile_enter"`);
  assertStringIncludes(artifact.wat, `(import "env" "fig_profile_exit"`);
  assertStringIncludes(artifact.wat, "call $__fig_profile_enter");
  assertStringIncludes(artifact.wat, "call $__fig_profile_exit");
});

Deno.test("runtime profile expressions erase when runtime profiling is disabled", async () => {
  const artifact = await compileArtifactsFromSource(
    `pub fn main() -> i32 { @profile("work") { 40 + 2 } }`,
  );

  assertEquals(artifact.profileSites, []);
  assert(!artifact.wat.includes("fig_profile_enter"));
  assert(!artifact.wat.includes("fig.profile"));
});

Deno.test("runtime profile expressions reject unsupported forms", async () => {
  await assertThrowsCompile(
    `pub fn main() -> i32 { @profile() { 1 } }`,
    "profile.arity",
  );
  await assertThrowsCompile(
    `pub fn main() -> i32 { @profile(1) { 1 } }`,
    "profile.label",
  );
  await assertThrowsCompile(
    `let x: i32 = @profile("top") { 1 };`,
    "profile.context",
  );
  await assertThrowsCompile(
    `pub fn main() -> i32 { let x = @profile("not a scoped expression"); 1 }`,
    "profile.context",
  );
  await assertThrowsCompile(
    `contract fn bad() -> rewrite { @profile("contract") { @assume(\\x -> x, \\x -> x) } }`,
    "profile.context",
  );
});

Deno.test("compiler plugin registry rejects duplicate ids and names", () => {
  const first: CompilerPlugin = {
    apiVersion: COMPILER_PLUGIN_API_VERSION,
    id: "test-plugin",
    staticBuiltins: [{ name: "test_builtin" }],
  };
  const second: CompilerPlugin = {
    apiVersion: COMPILER_PLUGIN_API_VERSION,
    id: "test-plugin",
    staticBuiltins: [{ name: "test_builtin" }],
  };
  const registry = createCompilerPluginRegistry([first, second]);
  assertEquals(registry.diagnostics.map((diagnostic) => diagnostic.code), [
    "plugin.duplicate",
    "plugin.duplicate_builtin",
  ]);
});

Deno.test("compiler plugins can add static builtins", async () => {
  const plugin: CompilerPlugin = {
    apiVersion: COMPILER_PLUGIN_API_VERSION,
    id: "test-static",
    staticBuiltins: [{
      name: "always_true",
      evaluateConst: () => ({ kind: "bool", value: true }),
      evaluateType: () => ({ kind: "bool", value: true }),
    }],
  };

  const checked = await checkSource(
    `
      const truth: bool = @always_true();
      type fn NeedsTrue() -> type {
        @require(@always_true(), "plugin static builtin failed");
        i32
      }
      pub fn main() -> NeedsTrue { match truth { true => 1, false => 0 } }
    `,
    { plugins: [plugin] },
  );

  assertEquals(checked.program.declarations.some((decl) => decl.kind === "const"), true);
});

Deno.test("compiler plugin diagnostics flow through compile options", async () => {
  const plugin: CompilerPlugin = {
    apiVersion: COMPILER_PLUGIN_API_VERSION,
    id: "core-static",
  };
  try {
    await checkSource("pub fn main() -> i32 { 1 }", { plugins: [plugin] });
  } catch (error) {
    assert(error instanceof CompileError);
    assertEquals(error.diagnostics[0]?.code, "plugin.duplicate");
    return;
  }
  throw new Error("expected plugin duplicate diagnostic");
});

Deno.test("compiler plugins can add branch-hint annotations", async () => {
  const plugin: CompilerPlugin = {
    apiVersion: COMPILER_PLUGIN_API_VERSION,
    id: "test-annotations",
    annotationBuiltins: [{ name: "hot", branchHint: "likely" }],
  };

  const checked = await checkSource(
    `
      @hot fn score(true: bool) -> i32 { 1 }
      fn score(false: bool) -> i32 { 0 }
      pub fn main() -> i32 { score(true) }
    `,
    { plugins: [plugin] },
  );
  const dispatcher = findFn(checked.program, "score");
  assert(dispatcher?.body.expr?.kind === "match");
  assertEquals(dispatcher.body.expr.arms[0]?.branchHint, "likely");
});

Deno.test("unknown plugin annotations are diagnostics after parsing", async () => {
  await assertThrowsCompile(
    `
      @hot fn score(true: bool) -> i32 { 1 }
      fn score(false: bool) -> i32 { 0 }
      pub fn main() -> i32 { score(true) }
    `,
    "plugin.unknown_annotation",
  );
});

Deno.test("compiler special form classifier covers source and internal contexts", () => {
  assertEquals(compilerSpecialForm("@import")?.kind, "declaration");
  assertEquals(compilerSpecialForm("@applicative")?.kind, "do_strategy");
  assertEquals(compilerSpecialForm("@assume")?.kind, "rewrite");
  assertEquals(compilerSpecialForm("@type_slots")?.kind, "static");
  assertEquals(compilerSpecialForm("@branch_handle")?.kind, "internal");
  assertEquals(compilerSpecialForm("$"), undefined);
  assertEquals(compilerSpecialForm("@branch_handle")?.sourceFacing, false);
  assert(isCompilerSpecialForm("@external", "declaration"));
});

Deno.test("unsupported host import annotation is rejected", async () => {
  await assertThrowsCompile(
    `
      const clock = @host_import("clock");
      pub fn main() -> i32 { clock() }
    `,
    "const.runtime_call",
  );
});

Deno.test("if expression desugars to boolean match", async () => {
  const source = `
    pub fn main(x: i32) -> i32 {
      if x < 3 {
        let y = x + 1;
        y
      } else {
        x - 1
      }
    }
  `;
  const parsed = await parse(source);
  const main = findFn(parsed, "main");
  assert(main?.body.expr?.kind === "match");
  assertEquals(
    main.body.expr.arms.map((arm) => {
      assert(arm.pattern.kind === "literal");
      return arm.pattern.value;
    }),
    ["true", "false"],
  );

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(2), 3);
  assertEquals((instance.exports.main as CallableFunction)(4), 3);
});

Deno.test("index cursor itself is not an inline-array index proof", async () => {
  await assertThrowsCompile(
    `
      const core = @import("prelude.core");
      type fn InlineArray(n: count, a: type) -> type {
        let InlineArray = {n*a};
        struct(InlineArray)
      }
      fn Bad(xs: InlineArray(3, i32), cursor: core.IndexCursor(3)) -> i32 {
        xs[cursor]
      }
    `,
    "index.requires_proof",
  );
});

Deno.test("static literal expansion and const-label field access lower", async () => {
  const wat = await watFromSource(`
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Pair() -> type {
      let Pair = {left: i32, right: i32};
      struct(Pair)
    }
    fn build() -> InlineArray(3, i32) {
      [0, 1, 2]
    }
    pub fn main() -> i32 {
      let xs: InlineArray(3, i32) = build();
      let p: Pair = Pair {left: 10, right: 32};
      xs[2] + @field(p, #right)
    }
  `);
  assertStringIncludes(wat, "local.get $xs$2");
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Pair() -> type {
      let Pair = {left: i32, right: i32};
      struct(Pair)
    }
    fn build() -> InlineArray(3, i32) {
      [0, 1, 2]
    }
    pub fn main() -> i32 {
      let xs: InlineArray(3, i32) = build();
      let p: Pair = Pair {left: 10, right: 32};
      xs[2] + @field(p, #right)
    }
  `),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 34);
});

Deno.test("heap arrays grow and preserve scalar items", async () => {
  const source = `
    const layout = @import("prelude.layout");

    pub fn main(seed: i32) -> i32 {
      let xs0 = layout.HeapArray::new(i32, 2);
      let xs1 = layout.HeapArray::push(i32, xs0, seed);
      let xs2 = layout.HeapArray::push(i32, xs1, seed + 1);
      let xs3 = layout.HeapArray::push(i32, xs2, seed + 2);
      layout.HeapArray::get(i32, xs3, 0) +
        layout.HeapArray::get(i32, xs3, 1) +
        layout.HeapArray::get(i32, xs3, 2) +
        layout.HeapArray::capacity(i32, xs3)
    }
  `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule: resolveProjectModule })),
  );
  assertEquals((instance.exports.main as (seed: number) => number)(10), 37);
});

Deno.test("heap arrays store flattened product items", async () => {
  const source = `
    const layout = @import("prelude.layout");

    type fn Pair() -> type {
      let Pair = {left: i32, right: i32};
      struct(Pair)
    }

    pub fn main(seed: i32) -> i32 {
      let xs0 = layout.HeapArray::new(Pair, 1);
      let xs1 = layout.HeapArray::push(
        Pair,
        xs0,
        Pair {left: seed, right: seed + 1}
      );
      let xs2 = layout.HeapArray::push(
        Pair,
        xs1,
        Pair {left: seed + 2, right: seed + 3}
      );
      let xs3 = layout.HeapArray::set(
        Pair,
        xs2,
        0,
        Pair {left: seed + 4, right: seed + 5}
      );
      let a = layout.HeapArray::get(Pair, xs3, 0);
      let b = layout.HeapArray::get(Pair, xs3, 1);
      a.left + a.right + b.left + b.right + layout.HeapArray::capacity(Pair, xs3)
    }
  `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule: resolveProjectModule })),
  );
  assertEquals((instance.exports.main as (seed: number) => number)(10), 56);
});

Deno.test("specialized const-label field access lowers from expected type", async () => {
  const source = `
    type fn Left() -> type {
      let Left = {x: i32};
      struct(Left)
    }
    type fn Right() -> type {
      let Right = {x: i32};
      struct(Right)
    }
    type fn Pair() -> type {
      let Pair = {left: Left, right: Right};
      struct(Pair)
    }
    fn pick_right(const field: const, pair: Pair) -> Right {
      @field(pair, field)
    }
    pub fn main() -> i32 {
      let pair = Pair {
        left: Left {x: 10},
        right: Right {x: 32}
      };
      let picked: Right = pick_right(#right, pair);
      picked.x
    }
  `;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(), 32);
});

Deno.test("array comprehension syntax is rejected", async () => {
  await assertThrowsCompile(
    `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    pub fn main() -> InlineArray(3, i32) {
      [i | i <- 0 .. 3]
    }
  `,
    "parse.syntax",
  );
});

Deno.test("static for literal syntax is rejected", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn add_index(xs: InlineArray(3, i32), offset: i32) -> InlineArray(3, i32) {
      [for i in 0 .. 3: xs[i] + offset]
    }
  `;
  await assertThrowsCompile(source, "parse.syntax");
});

Deno.test("record static for literal syntax is rejected", async () => {
  await assertThrowsCompile(
    `
      const fields = {x: true, y: true};
      pub fn main() -> i32 {
        let value = {for Key, Spec in (fields): 1};
        value.x + value.y
      }
    `,
    "parse.syntax",
  );
});

Deno.test("product constructor static for literal syntax is rejected", async () => {
  await assertThrowsCompile(
    `
      type fn Pair() -> type {
        let Pair = {x: i32, y: i32};
        struct(Pair)
      }
      const fields = {x: true, y: true};
      pub fn main() -> Pair {
        Pair {for Key, Spec in (fields): 1}
      }
    `,
    "parse.syntax",
  );
});

Deno.test("inline array list spread literals lower as flattened slots", async () => {
  const wat = await watFromSource(
    `
      const layout = @import("prelude.layout");

      fn tail() -> layout.InlineArrayList(2, i32) {
        #[2, 3]
      }

      fn build_list() -> layout.InlineArrayList(4, i32) {
        let rest = tail();
        #[0, 1, ...rest]
      }

      pub fn main() -> layout.InlineArray(4, i32) {
        layout.InlineArray::from_list(4, i32, build_list())
      }
    `,
    { resolveModule: resolveProjectModule },
  );

  assertStringIncludes(wat, `(result i32) (result i32) (result i32) (result i32)`);
  assert(!wat.includes("collect_start"));
  assert(!wat.includes("collect_push"));
  assert(!wat.includes("collect_finish"));
});

Deno.test("indexed spread update tuple literals check fixed inline arrays", async () => {
  const checked = await checkSource(`
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    pub fn main() -> InlineArray(4, i32) {
      let xs: InlineArray(4, i32) = #[1, 2, 3, 4];
      let ys: InlineArray(4, i32) = [...xs, [1]: 32];
      ys
    }
  `);
  assertEquals(findFns(checked.program, "main").length, 1);

  await checkSource(`
    pub fn main() -> [i32; 3] {
      let xs: [i32; 3] = [1, 2, 3];
      [...xs, [1]: 32]
    }
  `);
});

Deno.test("indexed spread update rejects invalid fixed tuple overrides", async () => {
  await assertThrowsCompile(
    `
      type fn InlineArray(n: count, a: type) -> type {
        let InlineArray = {n*a};
        struct(InlineArray)
      }
      pub fn Bad() -> InlineArray(4, i32) {
        let xs: InlineArray(4, i32) = #[1, 2, 3, 4];
        [...xs, [4]: 32]
      }
    `,
    "collection.fixed_update_index_bounds",
  );
  await assertThrowsCompile(
    `
      type fn InlineArray(n: count, a: type) -> type {
        let InlineArray = {n*a};
        struct(InlineArray)
      }
      pub fn Bad() -> InlineArray(4, i32) {
        let xs: InlineArray(4, i32) = #[1, 2, 3, 4];
        [...xs, [1]: true]
      }
    `,
    "collection.fixed_update_value_type",
  );
  await assertThrowsCompile(
    `
      type fn InlineArray(n: count, a: type) -> type {
        let InlineArray = {n*a};
        struct(InlineArray)
      }
      pub fn Bad() -> InlineArray(4, i32) {
        let xs: InlineArray(4, i32) = #[1, 2, 3, 4];
        #[...xs, [1]: 32]
      }
    `,
    "collection.fixed_update_square_syntax",
  );
});

Deno.test("spread entries stay out of product and require inline array list tails", async () => {
  await assertThrowsCompile(
    `
      const layout = @import("prelude.layout");
      type fn Pair() { let Pair = {first: i32, second: i32}; struct(Pair) }
      fn tail() -> layout.InlineArrayList(1, i32) { #[2] }
      pub fn Bad() -> Pair { Pair [first: 1, ...tail()] }
    `,
    "parse.syntax",
    { resolveModule: resolveProjectModule },
  );

  await assertThrowsCompile(
    `
      const layout = @import("prelude.layout");
      pub fn Bad(xs: layout.InlineArray(1, i32)) -> layout.InlineArrayList(2, i32) {
        #[1, ...xs]
      }
    `,
    "collection.spread_tail_type",
    { resolveModule: resolveProjectModule },
  );
});

Deno.test("product spread updates named and structural product values", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
    type fn Sprite2d() -> type {
      let Sprite2d = {
        atlas: i32,
        sx: i32,
        sy: i32,
        flip_x: i32,
        visible: i32
      };
      struct(Sprite2d)
    }
    fn base_sprite() -> Sprite2d {
      Sprite2d {atlas: 7, sx: 2, sy: 3, flip_x: 0, visible: 1}
    }
    fn update_row(row: struct({x: i32, y: i32})) -> struct({x: i32, y: i32}) {
      {...row, x: 10}
    }
    pub fn main() -> i32 {
      let sprite = base_sprite();
      let updated = Sprite2d {...sprite, sx: 32, flip_x: 1};
      let row = update_row({x: 1, y: 5});
      updated.atlas + updated.sx + updated.sy + updated.flip_x + updated.visible + row.x + row.y
    }
  `),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 59);
});

Deno.test("product spread updates use later fields and spreads", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
    type fn Pair() -> type {
      let Pair = {x: i32, y: i32};
      struct(Pair)
    }
    pub fn main() -> i32 {
      let left = Pair {x: 1, y: 2};
      let right = Pair {x: 3, y: 4};
      let updated = Pair {...left, x: 5, ...right, y: 7};
      updated.x * 10 + updated.y
    }
  `),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 37);
});

Deno.test("product spread diagnostics cover source target and fields", async () => {
  await assertThrowsCompile(
    `
      type fn Pair() -> type { let Pair = {x: i32, y: i32}; struct(Pair) }
      pub fn bad() -> Pair { Pair {...1, x: 2, y: 3} }
    `,
    "product.spread_source",
  );
  await assertThrowsCompile(
    `
      type fn Pair() -> type { let Pair = {x: i32, y: i32}; struct(Pair) }
      type fn OnlyX() -> type { let OnlyX = {x: i32}; struct(OnlyX) }
      pub fn bad() -> Pair {
        let only = OnlyX {x: 1};
        Pair {...only}
      }
    `,
    "product.spread_missing_field",
  );
  await assertThrowsCompile(
    `
      type fn Pair() -> type { let Pair = {x: i32, y: i32}; struct(Pair) }
      pub fn bad() -> Pair {
        let pair = Pair {x: 1, y: 2};
        Pair {...pair, z: 3}
      }
    `,
    "product.spread_unknown_field",
  );
});

Deno.test("target-typed collection literals lower through collector members", async () => {
  const checked = await checkSource(`
    type fn Bag(a: type) {
      let Bag = {sum: i32};
      struct(Bag)
    }
    fn Bag::collect_start(const a: type) -> Bag(a) { Bag {sum: 0} }
    fn Bag::collect_push(const a: type, builder: Bag(a), item: a) -> Bag(a) { builder }
    fn Bag::collect_finish(const a: type, builder: Bag(a)) -> Bag(a) { builder }
    fn take(xs: Bag(i32)) -> Bag(i32) { xs }
    pub fn main() -> i32 {
      let xs: Bag(i32) = #[1, 2, 3];
      let ys = take(#[4, 5]);
      xs.sum + ys.sum
    }
  `);
  const main = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "main"
  );
  const first = main?.body.statements[0];
  assertEquals(
    first?.kind === "let" && first.value.kind === "call" ? first.value.callee : undefined,
    { kind: "var", name: "Bag::collect_finish" },
  );
  const second = main?.body.statements[1];
  assertEquals(
    second?.kind === "let" && second.value.kind === "call" &&
      second.value.args[0]?.kind === "call"
      ? second.value.args[0].callee
      : undefined,
    { kind: "var", name: "Bag::collect_finish" },
  );
});

Deno.test("collection literals require target collector context", async () => {
  await assertThrowsCompile(
    "pub fn Bad() -> i32 { <1, 2> }",
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
      pub fn Bad() -> i32 {
        let xs = #[1, 2, 3];
        0
      }
    `,
    "collection.expected_type",
  );
  await assertThrowsCompile(
    `
      type fn Scalar() { i32 }
      pub fn Bad() -> Scalar { #[1, 2] }
    `,
    "collection.collector_missing",
  );
});

Deno.test("record value punning lowers in records and product constructors", async () => {
  const checked = await checkSource(`
    type fn Pair() -> type {
      let Pair = {left: i32, right: i32};
      struct(Pair)
    }
    fn take(pair: Pair) -> Pair { pair }
    pub fn main() -> i32 {
      let left = 10;
      let right = 32;
      let record = {left, right};
      let product = take(Pair {left, right});
      record.left + product.right
    }
  `);
  const main = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "main"
  );
  assertEquals(main?.kind, "fn");
});

Deno.test("tuple values types repeats and destructuring check", async () => {
  await checkSource(`
    type fn Pair() -> type {
      let Pair = [i32, [i32; 3]];
      struct(Pair)
    }
    type fn Lane3() -> type {
      let Lane = [i32; 3];
      struct(Lane)
    }
    fn make_pair() -> Pair { [1, [0; 3]] }
    pub fn main() -> i32 {
      let [head, values] = make_pair();
      head + values[0] + values[1] + values[2]
    }
  `);
});

Deno.test("tuple match patterns consume all tuple values", async () => {
  const source = `
    fn clamp(value: i32, low: i32, high: i32) -> i32 {
      match value < low, value > high {
        true, _ => low,
        false, true => high,
        false, false => value
      }
    }
    pub fn main(value: i32) -> i32 { clamp(value, 0, 10) }
  `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "debug" })),
  );
  const main = instance.exports.main as (value: number) => number;
  assertEquals(main(-2), 0);
  assertEquals(main(5), 5);
  assertEquals(main(12), 10);
});

Deno.test("comma match arm patterns bind tuple values", async () => {
  const source = `
    fn pick(a: i32, b: i32) -> i32 {
      match a, b {
        1, _ => 10,
        x, y => x + y
      }
    }
    fn pick_paren(a: i32, b: i32) -> i32 {
      match (a, b) {
        1, _ => 10,
        x, y => x + y
      }
    }
    pub fn main(a: i32, b: i32) -> i32 { pick(a, b) + pick_paren(a, b) }
  `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "debug" })),
  );
  const main = instance.exports.main as (a: number, b: number) => number;
  assertEquals(main(2, 3), 10);
  assertEquals(main(1, 9), 20);
});

Deno.test("field projection after dynamic inline-array index lowers product items", async () => {
  const source = `
    const layout = @import("prelude.layout");
    const core = @import("prelude.core");

    type fn Transform() -> type {
      let Transform = {x: i32, y: i32};
      struct(Transform)
    }

    type fn Batch() -> type {
      let Batch = {4*Transform};
      struct(Batch)
    }

    fn index(raw: i32) -> core.Index(4) {
      match core.Index::try(4, raw) {
        Some(i) => i,
        None => 0,
      }
    }

    pub fn main(raw: i32) -> i32 {
      let batch = layout.InlineArray::fill(4, Transform, Transform {x: 3, y: 9});
      let i = index(raw);
      batch[i].y
    }
  `;
  const resolveModule = async (moduleName: string) => {
    try {
      return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
    } catch {
      return undefined;
    }
  };
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "debug" })),
  );
  assertEquals((instance.exports.main as (raw: number) => number)(2), 9);
});

Deno.test("static for range bounds syntax is rejected", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn double(x: i32) -> i32 { x * 2 }
    fn tight(const n: count) -> InlineArray(n, i32) {
      [for i in 0 .. n: double(i)]
    }
  `;
  await assertThrowsCompile(source, "parse.syntax");
});

Deno.test("field labels remain valid with tight and spaced colons", async () => {
  const source = `
    type fn Pair() -> type {
      let Pair = {left: i32, right : i32};
      struct(Pair)
    }
    type fn Box(t: type) -> type {
      let Box = {value: t};
      struct(Box)
    }
    fn add(x: i32, y : i32) -> i32 { x + y }
    pub fn main() -> i32 {
      let p: Pair = Pair {left: 10, right : 30};
      let b: Box(i32) = Box {value : add(@field(p, #left), @field(p, #right))};
      @field(b, #value)
    }
  `;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(), 40);
});

Deno.test("inline array tabulation functions compose through layout prelude", async () => {
  const source = `
    const layout = @import("prelude.layout");
    const core = @import("prelude.core");
    fn make(i: core.Index(4)) -> i32 { i + 1 }
    fn make_with(i: core.Index(4), offset: i32) -> i32 { i + offset }
    fn inc(x: i32) -> i32 { x + 1 }
    fn add_index(i: core.Index(4), x: i32) -> i32 { x + i }
    fn add_state(i: core.Index(4), x: i32, offset: i32) -> i32 { x + i + offset }
    pub fn main() -> i32 {
      let built = layout.InlineArray::tabulate(4, i32, make);
      let with_state = layout.InlineArray::tabulate_with(4, i32, i32, 10, make_with);
      let indexed = layout.InlineArray::imap(4, i32, i32, with_state, add_index);
      let state_mapped = layout.InlineArray::imap_with_state(4, i32, i32, i32, indexed, 20, add_state);
      let mapped = layout.InlineArray::map(4, i32, i32, built, inc);
      let set = layout.InlineArray::set(4, i32, mapped, 2, 99);
      let updated = layout.InlineArray::update(4, i32, set, 0, inc);
      updated[0] + updated[1] + updated[2] + updated[3] + state_mapped[0] + state_mapped[3]
    }
  `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule: resolveProjectModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 179);
});

Deno.test("static for statement blocks are rejected", async () => {
  await assertThrowsCompile(
    `
      fn main() -> i32 {
        let acc = 0;
        static for I in 0 .. 3 {
          let acc = acc + I;
        }
        acc
      }
    `,
    "parse.syntax",
  );
});

Deno.test("parses language surface declarations and literals", async () => {
  const program = await parse(`
    const clock = @external("clock", fn(io: io) -> io(i64));
    type fn Id() { i32 }
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Maybe(a: type) { let Nothing = {}; let Some = {value: a}; union(Nothing, Some) }
    type fn Buffer(n: count) { let Buffer = {n*i32}; struct(Buffer) }
    type fn Weird() { let Weird = {fst: i32, 4*i32, 1*i32}; struct(Weird) }
    type fn Eq(t: type) { let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool}; struct(Eq) }
    fn eql_point(a: Point, b: Point) -> bool { a.x == b.x }
    fn neq_point(a: Point, b: Point) -> bool { a.x != b.x }
    const point_eq: Eq(Point) = {eql: eql_point, neq: neq_point}
    pub fn main() -> i32 {
      let xs: {3*i32} = [1, 2, 3];
      let point: Point = Point {x: 1, y: 2};
      let label = \`\`\`hello
world\`\`\`;
      match 1 { _ => 2, }
    }
  `);
  assertEquals(program.moduleName, undefined);
  assertEquals(program.imports[0].effects, []);
  assert(program.declarations.length >= 5);
});

Deno.test("type declaration sugar lowers to ordinary type functions", async () => {
  const checked = await checkSource(`
    type Point = struct {x: i32, y: i32}
    type Maybe(a) = union {None, Some(value: a)}
    type Count = i32

    pub fn main() -> i32 {
      let point = Point {x: 1, y: 2};
      let count: Count = 3;
      point.x + point.y + count
    }
  `);
  const point = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "Point"
  );
  const maybe = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "Maybe"
  );
  const count = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "Count"
  );
  assertEquals(point?.normalized?.kind, "product");
  assertEquals(maybe?.normalized?.kind, "sum");
  assertEquals(count?.normalized?.kind, "alias");

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
      type Point = struct {x: i32, y: i32}
      type Count = i32

      pub fn main() -> i32 {
        let point = Point {x: 1, y: 2};
        let count: Count = 3;
        point.x + point.y + count
      }
    `),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 6);
});

Deno.test("attaches slash doc comments to Fig bindings", async () => {
  const checked = await checkSource(`
    /// builds a documented point
    type fn Point(
      /// coordinate type
      a: type
    ) -> struct {
      /// product shape
      let Point = {
        /// x coordinate
        x: a,
        /// y coordinate
        y: a,
      };
      struct(Point)
    }

    /// top constant
    const origin = {x: 0, y: 0};

    /// top let
    let top_value = 1;

    /// adds values
    fn add(
      /// left input
      a: i32,
      /// right input
      b: i32
    ) -> i32 {
      /// local temp
      let tmp = a + b;
      /// local proof
      const proof = i32;
      tmp
    }
  `);
  const point = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "Point"
  );
  assertEquals(point?.doc, "builds a documented point");
  assertEquals(point?.params[0]?.doc, "coordinate type");
  assertEquals(point?.body.statements[0]?.doc, "product shape");
  assertEquals(point?.normalized?.kind === "product" ? point.normalized.shape.slots : undefined, [
    { doc: "x coordinate", label: "x", type: "a" },
    { doc: "y coordinate", label: "y", type: "a" },
  ]);
  const origin = checked.program.declarations.find((decl) => decl.kind === "const");
  assertEquals(origin?.doc, "top constant");
  const topValue = checked.program.declarations.find((decl) => decl.kind === "let");
  assertEquals(topValue?.doc, "top let");
  const add = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "add"
  );
  assertEquals(add?.doc, "adds values");
  assertEquals(add?.params.map((param) => param.doc), ["left input", "right input"]);
  assertEquals(
    add?.body.statements[0]?.kind === "let" ? add.body.statements[0].doc : undefined,
    "local temp",
  );
  assertEquals(
    add?.body.statements[1]?.kind === "proof_const" ? add.body.statements[1].doc : undefined,
    "local proof",
  );
});

Deno.test("doc comments attach only to the immediately following binding", async () => {
  const program = await parse(`
    /// first line
    /// second line
    fn documented() -> i32 { 1 }

    /// separated

    fn blank_breaks() -> i32 { 2 }
    /// blocked
    // ordinary comment
    fn comment_breaks() -> i32 { 3 }
    // ordinary only
    fn ordinary_comment() -> i32 { 4 }
    /// before import is tolerated
    const std = @import("prelude.std");
  `);
  const byName = new Map(program.declarations.map((decl) => [decl.name, decl]));
  assertEquals(byName.get("documented")?.doc, "first line\nsecond line");
  assertEquals(byName.get("blank_breaks")?.doc, undefined);
  assertEquals(byName.get("comment_breaks")?.doc, undefined);
  assertEquals(byName.get("ordinary_comment")?.doc, undefined);
  assertEquals(program.sourceImports?.[0], {
    kind: "source_import",
    module: "prelude.std",
    alias: "std",
  });
});

Deno.test("preserves docs through source import qualification", async () => {
  const checked = await checkSource(
    `
      const lib = @import("lib");
      fn use(v: lib.Box(i32)) -> i32 { v.value }
    `,
    {
      resolveModule: async (module) =>
        module === "lib"
          ? `
            /// imported box
            type fn Box(
              /// payload type
              a: type
            ) -> struct {
              let Box = {
                /// payload field
                value: a,
              };
              struct(Box)
            }
          `
          : undefined,
    },
  );
  const box = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "lib.Box"
  );
  assertEquals(box?.doc, "imported box");
  assertEquals(box?.params[0]?.doc, "payload type");
  assertEquals(
    box?.normalized?.kind === "product" ? box.normalized.shape.slots[0]?.doc : undefined,
    "payload field",
  );
});

Deno.test("accepts const declarations without trailing semicolons", async () => {
  const checked = await checkSource(`
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Eq(t: type) { let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool}; struct(Eq) }
    fn eql_point(a: Point, b: Point) -> bool { a.x == b.x }
    fn neq_point(a: Point, b: Point) -> bool { a.x != b.x }
    const point_eq: Eq(Point) = {eql: eql_point, neq: neq_point}
    const point_eq_again: Eq(Point) = {eql: eql_point, neq: neq_point}
  `);
  assertEquals(
    checked.program.declarations.filter((decl) => decl.kind === "const").length,
    2,
  );
});

Deno.test("normalizes type function declarations", async () => {
  const checked = await checkSource(`
    type fn Id() { i32 }
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Maybe(a: type) { let Nothing = {}; let Some = {value: a}; union(Nothing, Some) }
    type fn Weird() { let Weird = {fst: i32, 4*i32, 1*i32}; struct(Weird) }
    type fn Why(a: count) { let Why = {fst: i32, a*i32}; struct(Why) }
  `);
  const program = checked.program;
  assertEquals(program.declarations[0], {
    kind: "type",
    name: "Id",
    params: [],
    resultKind: "type",
    body: {
      kind: "type_block",
      statements: [],
      expr: { kind: "type_ref", name: "i32" },
    },
    normalized: { kind: "alias", type: "i32" },
    paramKinds: {},
  });
  assertEquals(
    program.declarations[1].kind === "type" ? program.declarations[1].normalized : undefined,
    {
      kind: "product",
      name: "Point",
      constructor: "Point",
      shape: { slots: [{ label: "x", type: "i32" }, { label: "y", type: "i32" }] },
    },
  );
  assertEquals(
    program.declarations[2].kind === "type" ? program.declarations[2].normalized : undefined,
    {
      kind: "sum",
      variants: [
        { name: "Nothing", shape: undefined },
        { name: "Some", shape: { slots: [{ label: "value", type: "a" }] } },
      ],
    },
  );
  assertEquals(
    program.declarations[3].kind === "type" ? program.declarations[3].normalized : undefined,
    {
      kind: "product",
      name: "Weird",
      constructor: "Weird",
      shape: {
        slots: [
          { label: "fst", type: "i32" },
          { label: undefined, repeat: "4", type: "i32" },
          { label: undefined, repeat: "1", type: "i32" },
        ],
      },
    },
  );
  assertEquals(
    program.declarations[4].kind === "type" ? program.declarations[4].paramKinds : undefined,
    {
      a: "count",
    },
  );
});

Deno.test("type functions accept const shapes for generated product fields", async () => {
  const checked = await checkSource(`
    type fn Transform2d() -> type { let Transform2d = {x: i32}; struct(Transform2d) }
    type fn Velocity2d() -> type { let Velocity2d = {x: i32}; struct(Velocity2d) }
    type fn Sprite2d() -> type { i32 }
    type fn Entity2d() -> type { i32 }
    type fn Store(n: count, component: type) -> type {
      let Store = {n*component};
      struct(Store)
    }
    type fn StoreFor(component: const) -> type {
      Store(component.count, component.component)
    }
    type fn World2d(entity_count: count, components: const, entity: type) -> type {
      let Base = {entities: Store(entity_count, entity)};
      let Stores = @shape_map(components, StoreFor);
      let World2d = @shape_concat(Base, Stores);
      struct(World2d)
    }
    const game_components = {
      transforms: {count: 3, component: Transform2d},
      velocities: {count: 1, component: Velocity2d},
      sprites: {count: 3, component: Sprite2d},
    };
    pub fn use_world(world: World2d(3, game_components, Entity2d)) -> i32 { 0 }
  `);
  const type = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "World2d"
  );
  assertEquals(type?.paramKinds?.components, "const");
  const useWorld = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "use_world"
  );
  assertStringIncludes(useWorld?.params[0]?.type ?? "", "game_components");
});

Deno.test("type functions accept inline const shape arguments", async () => {
  const checked = await checkSource(`
    type fn Transform2d() -> type { i32 }
    type fn Entity2d() -> type { i32 }
    type fn Store(n: count, component: type) -> type {
      let Store = {n*component};
      struct(Store)
    }
    type fn StoreFor(component: const) -> type {
      Store(component.count, component.component)
    }
    type fn World2d(entity_count: count, components: const, entity: type) -> type {
      let Base = {entities: Store(entity_count, entity)};
      let Stores = @shape_map(components, StoreFor);
      let World2d = @shape_concat(Base, Stores);
      struct(World2d)
    }
    pub fn use_world(world: World2d(3, {transforms: {count: 3, component: Transform2d}}, Entity2d)) -> i32 { 0 }
  `);
  const useWorld = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "use_world"
  );
  assertStringIncludes(useWorld?.params[0]?.type ?? "", "World2d");
});

Deno.test("shape concat reports duplicate generated fields", async () => {
  await assertThrowsCompile(
    `
      type fn Item() -> type { i32 }
      type fn Store(n: count, component: type) -> type {
        let Store = {n*component};
        struct(Store)
      }
      type fn StoreFor(component: const) -> type {
        Store(component.count, component.component)
      }
      type fn BadWorld(components: const) -> type {
        let Base = {transforms: Store(1, Item)};
        let Stores = @shape_map(components, StoreFor);
        let World = @shape_concat(Base, Stores);
        struct(World)
      }
      pub fn use_world(world: BadWorld({transforms: {count: 1, component: Item}})) -> i32 { 0 }
    `,
    "type.shape_concat_duplicate",
  );
});

Deno.test("static shape inspection and transforms build products", async () => {
  const checked = await checkSource(`
    type fn KeepXy(key: const, value: const) -> type {
      match key {
        #x => true,
        #flag => true,
        _ => false,
      }
    }
    type fn RenameValue(key: const, value: const) -> type {
      match key {
        #y => bool,
        _ => value,
      }
    }
    type fn ShapeTools(a: type) -> type {
      let Base = {x: i32, y: i64, z: bool};
      let Picked = @shape_pick(Base, {x: true, z: i32});
      let Omitted = @shape_omit(Base, {z: true});
      let Intersected = @shape_intersect(Picked, Omitted);
      let Difference = @shape_difference(Base, Intersected);
      let Renamed = @shape_rename(Difference, {y: #flag, z: "done"});
      let Mapped = @shape_map_with_key(Renamed, RenameValue);
      let Filtered = @shape_filter(Mapped, KeepXy);
      let Count = @shape_count(Filtered);
      let TrueOut = @shape_concat(Filtered, {extra: @shape_slot(Filtered, #flag)});
      let FalseOut = {missing: i32};
      match @shape_has_slot(Filtered, #flag) {
        true => struct(TrueOut),
        false => struct(FalseOut),
      }
    }
    pub fn use_shape_tools(value: ShapeTools(i32)) -> i32 { 0 }
  `);
  const useShapeTools = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "use_shape_tools"
  );
  assertStringIncludes(useShapeTools?.params[0]?.type ?? "", "ShapeTools");
});

Deno.test("static type reflection feeds shape helpers", async () => {
  const checked = await checkSource(`
    type fn Point() -> type { let Point = {x: i32, y: i32, z: bool}; struct(Point) }
    type fn Option(a: type) -> type { let None = {}; let Some = {value: a}; union(None, Some) }
    type fn ReflectedPoint(a: type) -> type {
      let Slots = @type_slots(Point);
      let Picked = @shape_pick(Slots, {x: true, y: true});
      let Count = @shape_count(Picked);
      let Reflected = {Count*@shape_slot(Picked, #x)};
      struct(Reflected)
    }
    type fn ReflectedSome(a: type) -> type {
      let Variants = @type_variants(Option(i32));
      let SomeSlots = @type_variant_slots(Option(i32), #Some);
      let Missing = {missing: i32};
      match @shape_count(SomeSlots) == @shape_count(@shape_slot(Variants, #Some)) {
        true => struct(SomeSlots),
        false => struct(Missing),
      }
    }
    pub fn use_reflected(point: ReflectedPoint(i32), some: ReflectedSome(i32)) -> i32 { 0 }
  `);
  const useReflected = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "use_reflected"
  );
  assertStringIncludes(useReflected?.params[1]?.type ?? "", "ReflectedSome");
});

Deno.test("static type reflection exposes members functions scalars layouts and variants", async () => {
  await checkSource(`
    type fn Point() -> type { let Point = {x: i32, y: i32}; struct(Point) }
    fn Point::eql(a: Point, b: Point) -> bool { a.x == b.x }
    type fn Option(a: type) -> type { let None = {}; let Some = {value: a}; union(None, Some) }
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Reflected() -> type {
      let Expected = fn(a: Point, b: Point) -> bool;
      let Members = @type_members(Point);
      let Eql = @shape_slot(Members, #eql);
      let Params = @type_fn_params(Expected);
      let Layout = @type_layout(InlineArray(4, u3));
      @require(@shape_slot(Eql, #type) == Expected, "member metadata includes type");
      @require(@shape_slot(Eql, #target) == "Point::eql", "member metadata includes target");
      @require(@type_member_target(Point, #eql) == "Point::eql", "member target reflects function");
      @require(@type_is_fn(Expected), "function type reflected");
      @require(@type_fn_param_count(Expected) == 2, "function arity reflected");
      @require(@shape_slot(Params, #a) == Point, "function params reflected");
      @require(@type_fn_return(Expected) == bool, "function return reflected");
      @require(@type_is_scalar(u3), "u3 is scalar");
      @require(@type_scalar_carrier(u3) == #u3, "u3 carrier reflected");
      @require(@type_scalar_bit_width(u3) == 3, "u3 width reflected");
      @require(@type_scalar_min(u3) == 0, "u3 min reflected");
      @require(@type_scalar_max(u3) == 7, "u3 max reflected");
      @require(@type_scalar_signed(u3) == false, "u3 signedness reflected");
      @require(@type_is_refined_scalar(i32(0..4)), "refined scalar reflected");
      @require(@type_is_inline_array(InlineArray(4, u3)), "inline array reflected");
      @require(@type_inline_array_len(InlineArray(4, u3)) == 4, "inline array len reflected");
      @require(@type_inline_array_item(InlineArray(4, u3)) == u3, "inline array item reflected");
      @require(@type_storage_kind(InlineArray(4, u3)) == #packed, "storage kind reflected");
      @require(@type_size_bits(InlineArray(4, u3)) == 12, "size bits reflected");
      @require(@type_flat_slot_count(Point) == 2, "flat slot count reflected");
      @require(@shape_slot(@type_flat_slots(Point), #slot0) == i32, "flat slots reflected");
      @require(@shape_slot(Layout, #total_bits) == 12, "layout total bits reflected");
      @require(@type_variant_count(Option(i32)) == 2, "variant count reflected");
      @require(@type_variant_tag_type(Option(i32)) == u1, "variant tag type reflected");
      @require(@type_variant_payload_type(Option(i32), #Some) == i32, "payload reflected");
      @require(@type_has_niche(Option(i32)) == false, "niche default reflected");
      Point
    }
    pub fn main(value: Reflected) -> i32 { value.x }
  `);
});

Deno.test("static type-list builtins support membership and type-list operations", async () => {
  await checkSource(`
    type fn Reader() -> type { i32 }
    type fn State() -> type { i32 }

    type fn TypeListProof(a: type) -> type {
      let Fn = fn(x: i32) -> i32;
      let Appended = @type_list_append([#reader,], [#state,]);
      @require(@type_list_contains([#reader, #state], #reader), "literal member");
      @require(@type_list_index([#reader, #state], #state) == 1, "literal index");
      @require(
        @type_list_contains(Appended, #state),
        "append member"
      );
      @require(
        @type_list_contains(@type_list_remove([#reader, #state], #reader), #reader) == false,
        "remove member"
      );
      @require(
        @type_list_is_unique(@type_list_unique([#reader, #reader, #state])),
        "unique member"
      );
      @require(@type_list_contains([Reader, State], Reader), "type member");
      @require(
        @type_list_contains([Fn,], Fn),
        "function type member"
      );
      a
    }

    fn use(const _proof: TypeListProof(i32)) -> i32 { 0 }
    pub fn main() -> i32 { use(TypeListProof(i32)) }
  `);
});

Deno.test("unsupported function effect reflection builtin is absent", async () => {
  const registry = createCompilerPluginRegistry();
  assert(!registry.staticBuiltins.has("type_fn_effects"));
});

Deno.test("static type-list builtins report missing and malformed type lists", async () => {
  await assertThrowsCompile(
    `
      type fn Bad(a: type) -> type {
        @type_list_index([#reader,], #state);
        a
      }
      fn use(const _proof: Bad(i32)) -> i32 { 0 }
      pub fn main() -> i32 { use(Bad(i32)) }
    `,
    "type.list_member",
  );
  await assertThrowsCompile(
    `
      type fn Bad(a: type) -> type {
        @type_list_contains({reader: #reader}, #reader);
        a
      }
      fn use(const _proof: Bad(i32)) -> i32 { 0 }
      pub fn main() -> i32 { use(Bad(i32)) }
    `,
    "type.list_builtin_arg",
  );
});

Deno.test("const evaluation supports extended static type reflection", async () => {
  const checked = await checkSource(`
    type fn Point() -> type { let Point = {x: i32, y: i32}; struct(Point) }
    fn Point::eql(a: Point, b: Point) -> bool { a.x == b.x }
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    const members = @type_members(Point);
    const reflected = {
      target: @type_member_target(Point, #eql),
      width: @type_scalar_bit_width(u3),
    };
    const layout = @type_layout(InlineArray(4, u3));
    pub fn main() -> i32 { 0 }
  `);
  const reflected = checked.program.declarations.find((decl): decl is ConstDecl =>
    decl.kind === "const" && decl.name === "reflected"
  );
  assertEquals(
    reflected?.value.kind === "shape"
      ? reflected.value.slots.find((slot) => slot.label === "target")?.value
      : undefined,
    { kind: "var", name: "Point::eql" },
  );
  assertEquals(
    reflected?.value.kind === "shape"
      ? reflected.value.slots.find((slot) => slot.label === "width")?.value
      : undefined,
    { kind: "literal", literalKind: "number", value: "3" },
  );
  const layout = checked.program.declarations.find((decl): decl is ConstDecl =>
    decl.kind === "const" && decl.name === "layout"
  );
  assertEquals(
    layout?.value.kind === "shape"
      ? layout.value.slots.find((slot) => slot.label === "total_bits")?.value
      : undefined,
    { kind: "literal", literalKind: "number", value: "12" },
  );
  const members = checked.program.declarations.find((decl): decl is ConstDecl =>
    decl.kind === "const" && decl.name === "members"
  );
  assert(
    members?.value.kind === "shape" &&
      members.value.slots.some((slot) => slot.label === "eql"),
  );
});

Deno.test("generic empty derives primitive and product zero values", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
      const core = @import("prelude.core");
      type fn Point() -> type {
        let Point = {x: i32, visible: bool};
        struct(Point)
      }
      pub fn main() -> i32 {
        let p = core.empty(Point);
        let visible_value = match p.visible { true => 100, false => p.x };
        core.empty(i32) + visible_value
      }
    `,
        { resolveModule: resolveProjectModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 0);
});

Deno.test("literal unions work as runtime value types", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
      fn Choose(x: 1 | 2 | 3) -> i32 { x }
      pub fn main() -> i32 { Choose(2) }
    `),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 2);
});

Deno.test("literal unions reject values outside the closed set", async () => {
  await assertThrowsCompile(
    `
      fn Choose(x: 1 | 2 | 3) -> i32 { x }
      pub fn main() -> i32 { Choose(4) }
    `,
    "type.literal_mismatch",
  );
  await assertThrowsCompile(
    `
      fn tag(x: #why | #this | #tag) -> i32 { 1 }
      pub fn main() -> i32 { tag(#other) }
    `,
    "type.literal_mismatch",
  );
});

Deno.test("literal unions work in product and tuple fields", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
      type fn Tagged() -> type {
        let Tagged = {tag: #why | #this | #tag, word: "hello" | "world", mark: 'a' | 'b'};
        struct(Tagged)
      }
      type fn Pair() -> type {
        let Pair = [1 | 2, "hello" | "world"];
        struct(Pair)
      }
      fn score(value: Tagged) -> i32 {
        match value.tag {
          #this => 10,
          _ => 0
        }
      }
      pub fn main() -> i32 {
        let item: Tagged = Tagged {tag: #this, word: "world", mark: 'b'};
        let pair: Pair = [2, "hello"];
        score(item) + pair[0]
      }
    `),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 12);
});

Deno.test("explicit empty member overrides derived product empty", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
      const core = @import("prelude.core");
      type fn Point() -> type {
        let Point = {x: i32};
        struct(Point)
      }
      fn Point::empty() -> Point { Point {x: 7} }
      pub fn main() -> i32 {
        let p = core.empty(Point);
        p.x
      }
    `,
        { resolveModule: resolveProjectModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 7);
});

Deno.test("generic empty rejects unsupported sum values", async () => {
  await assertThrowsCompile(
    `
      const core = @import("prelude.core");
      type fn MaybeI32() -> type {
        let None = {};
        let Some = {value: i32};
        union(None, Some)
      }
      pub fn main() -> MaybeI32 { core.empty(MaybeI32) }
    `,
    "type.unknown_type_member",
    { resolveModule: resolveProjectModule },
  );
});

Deno.test.ignore("ecs dense world derives storage from component spec", async () => {
  const source = `
      const ecs = @import("engine.ecs");
      type fn Transform2d() -> type { i32 }
      type fn Velocity2d() -> type { i32 }
      type fn Sprite2d() -> type { i32 }
      const components = ecs.components({
        transform: Transform2d,
        velocity: Velocity2d,
        sprite: Sprite2d
      });
      type fn GameWorld() -> type {
        let GameWorld = @type_slots(ecs.World(7, components));
        struct(GameWorld)
      }
      pub fn main() -> i32 {
        let world: GameWorld = {
          entities: ecs.batch_fill(7, 0),
          len: 0,
          transform: ecs.batch_fill(7, 0),
          velocity: ecs.batch_fill(7, 0),
          sprite: ecs.batch_fill(7, 0)
        };
        world.len
      }
    `;
  const checked = await checkSource(source, { resolveModule: resolveProjectModule });
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule: resolveProjectModule }),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 0);
  const world = checked.program.declarations.find((decl) =>
    decl.kind === "type" && decl.name === "GameWorld"
  );
  assert(world);
});

Deno.test("ecs query map derives system input from query context", async () => {
  await checkSource(
    `
      const ecs = @import("engine.ecs");
      type fn Position() -> type {
        let Position = {x: i32};
        struct(Position)
      }
      type fn GameWorld() -> type {
        let GameWorld = {positions: ecs.Batch(Position)};
        struct(GameWorld)
      }
      type fn FrameInput() -> type {
        let FrameInput = {dt_ms: i32};
        struct(FrameInput)
      }
      type fn PositionRow() -> type {
        let PositionRow = {positions: Position, input: FrameInput};
        struct(PositionRow)
      }
      fn positions_q() -> ecs.Query(GameWorld, FrameInput, PositionRow) {
        let positions: ecs.Query(GameWorld, FrameInput, Position) = ecs.write(#positions);
        let input: ecs.Query(GameWorld, FrameInput, FrameInput) = ecs.res();
        ecs.query(PositionRow)
      }

      fn step(row: PositionRow) -> struct({positions: Position}) {
        {positions: Position {x: row.positions.x + row.input.dt_ms}}
      }
      fn movement() -> ecs.System(GameWorld, FrameInput) {
        do @monad(ecs.System(GameWorld, FrameInput)) {
          ecs.map(positions_q(), step);
        }
      }
      pub fn main(world: GameWorld, input: FrameInput) -> GameWorld {
        ecs.run(world, input, movement)
      }
    `,
    { resolveModule: resolveProjectModule },
  );
});

Deno.test("ecs fused fill iterator maps and folds without materialized batch", async () => {
  const source = `
      const ecs = @import("engine.ecs");

      type fn Position() -> type {
        let Position = {x: i32, y: i32};
        struct(Position)
      }

      type fn Velocity() -> type {
        let Velocity = {dx: i32, dy: i32};
        struct(Velocity)
      }

      fn move_position(
        index: i32,
        item: Position,
        velocity: Velocity
      ) -> Position {
        Position {
          x: item.x + velocity.dx + index,
          y: item.y + velocity.dy
        }
      }

      fn score_position(acc: i32, item: Position) -> i32 {
        acc + item.x + item.y
      }

      pub fn main(seed: i32) -> i32 {
        ecs.batch_iter_map_with_state_fold(
          ecs.batch_fill_iter(128, Position {x: seed, y: seed + 1}),
          Velocity {dx: 2, dy: 3},
          0,
          move_position,
          score_position
        )
      }
    `;
  const artifact = await compileArtifactsFromSource(source, {
    resolveModule: resolveProjectModule,
    memoryModel: "branch",
    optMode: "release",
    pruneImports: true,
  });
  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
  assertEquals((instance.exports.main as (seed: number) => number)(0), 8_896);
  assert(artifact.wasm.byteLength <= 1024, artifact.wat);
  assert([...artifact.wat.matchAll(/\bloop\b/g)].length >= 1, artifact.wat);
  assert([...artifact.wat.matchAll(/\bif\b/g)].length <= 4, artifact.wat);
});

Deno.test("ecs batch fill initializes heap batch values", async () => {
  const source = `
      const ecs = @import("engine.ecs");

      type fn Velocity() -> type {
        let Velocity = {dx: i32, dy: i32};
        struct(Velocity)
      }

      pub fn main() -> i32 {
        let batch = ecs.batch_fill(4, Velocity {dx: 2, dy: 3});
        let first = ecs.batch_get(batch, 0);
        first.dx + first.dy
      }
    `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, {
        resolveModule: resolveProjectModule,
        optMode: "release",
      }),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 5);
});

Deno.test("ecs query applicative map lowers to fused read input update", async () => {
  const source = `
      const ecs = @import("engine.ecs");

      type fn Position() -> type {
        let Position = {x: i32, y: i32};
        struct(Position)
      }

      type fn Velocity() -> type {
        let Velocity = {dx: i32, dy: i32};
        struct(Velocity)
      }

      type fn FrameInput() -> type {
        let FrameInput = {dt: i32};
        struct(FrameInput)
      }

      type fn MovementRow() -> type {
        let MovementRow = {positions: Position, velocities: Velocity, input: FrameInput};
        struct(MovementRow)
      }

      const components = ecs.components({
        positions: Position,
        velocities: Velocity
      });

      type fn World() -> type {
        let Expected = @type_slots(ecs.World(components));
        let World = {
          entities: ecs.Batch(i32),
          len: i32,
          positions: ecs.Batch(Position),
          velocities: ecs.Batch(Velocity)
        };
        let Matches = @require(World == Expected, "test World must match ecs.World");
        struct(World)
      }

      fn movement_q() -> ecs.Query(World, FrameInput, MovementRow) {
        let positions: ecs.Query(World, FrameInput, Position) = ecs.write(#positions);
        let velocities: ecs.Query(World, FrameInput, Velocity) = ecs.read(#velocities);
        let input: ecs.Query(World, FrameInput, FrameInput) = ecs.res();
        ecs.query(MovementRow)
      }

      fn seed_world(seed: i32) -> World {
        {
          entities: ecs.batch_fill(4, 0),
          len: 4,
          positions: ecs.batch_fill(4, Position {x: seed, y: seed + 1}),
          velocities: ecs.batch_fill(4, Velocity {dx: 2, dy: 3})
        }
      }

      fn movement_step(row: MovementRow) -> struct({positions: Position}) {
        {
          positions: Position {
            x: row.positions.x + row.velocities.dx + row.input.dt,
            y: row.positions.y + row.velocities.dy
          }
        }
      }

      fn movement_system() -> ecs.System(World, FrameInput) {
        do @monad(ecs.System(World, FrameInput)) {
          ecs.map(movement_q(), movement_step);
        }
      }

      pub fn main(seed: i32) -> i32 {
        let world = ecs.run(seed_world(seed), FrameInput {dt: 1}, movement_system);
        let first = ecs.batch_get(world.positions, 0);
        first.x + first.y
      }
    `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, {
        resolveModule: resolveProjectModule,
        optMode: "release",
      }),
    ),
  );
  assertEquals((instance.exports.main as (seed: number) => number)(0), 7);
});

Deno.test("ecs system monad sequences query map systems", async () => {
  const source = `
      const ecs = @import("engine.ecs");

      type fn Position() -> type {
        let Position = {x: i32, y: i32};
        struct(Position)
      }

      type fn FrameInput() -> type {
        let FrameInput = {dt: i32};
        struct(FrameInput)
      }

      type fn PositionRow() -> type {
        let PositionRow = {positions: Position, input: FrameInput};
        struct(PositionRow)
      }

      const components = ecs.components({positions: Position});

      type fn World() -> type {
        let Expected = @type_slots(ecs.World(components));
        let Shape = {
          entities: ecs.Batch(i32),
          len: i32,
          positions: ecs.Batch(Position)
        };
        let Matches = @require(Shape == Expected, "test World must match ecs.World");
        struct(Shape)
      }

      fn positions_q() -> ecs.Query(World, FrameInput, PositionRow) {
        let positions: ecs.Query(World, FrameInput, Position) = ecs.write(#positions);
        let input: ecs.Query(World, FrameInput, FrameInput) = ecs.res();
        ecs.query(PositionRow)
      }

      fn seed_world(seed: i32) -> World {
        {
          entities: ecs.batch_fill(4, 0),
          len: 4,
          positions: ecs.batch_fill(4, Position {x: seed, y: seed + 1})
        }
      }

      fn movement_step(row: PositionRow) -> struct({positions: Position}) {
        {positions: Position {x: row.positions.x + row.input.dt, y: row.positions.y}}
      }

      fn twice_system() -> ecs.System(World, FrameInput) {
        do @monad(ecs.System(World, FrameInput)) {
          ecs.map(positions_q(), movement_step);
          ecs.map(positions_q(), movement_step);
        }
      }

      pub fn main(seed: i32) -> i32 {
        let world = ecs.run(seed_world(seed), FrameInput {dt: 2}, twice_system);
        ecs.batch_get(world.positions, 0).x
      }
    `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, {
        resolveModule: resolveProjectModule,
        optMode: "release",
      }),
    ),
  );
  assertEquals((instance.exports.main as (seed: number) => number)(1), 5);
});

Deno.test("ecs spawn lowers generic component rows", async () => {
  const source = `
      const ecs = @import("engine.ecs");

      type fn Position() -> type {
        let Position = {x: i32};
        struct(Position)
      }

      type fn Velocity() -> type {
        let Velocity = {dx: i32};
        struct(Velocity)
      }

      type fn SpawnRow() -> type {
        let SpawnRow = {positions: Position, velocities: Velocity};
        struct(SpawnRow)
      }

      const components = ecs.components({
        positions: Position,
        velocities: Velocity
      });

      type fn World() -> type {
        let Expected = @type_slots(ecs.World(components));
        let World = {
          entities: ecs.Batch(i32),
          len: i32,
          positions: ecs.Batch(Position),
          velocities: ecs.Batch(Velocity)
        };
        let Matches = @require(World == Expected, "test World must match ecs.World");
        struct(World)
      }

      fn seed_world() -> World {
        {
          entities: ecs.batch_with_capacity(i32, 4),
          len: 0,
          positions: ecs.batch_with_capacity(Position, 4),
          velocities: ecs.batch_with_capacity(Velocity, 4)
        }
      }

      pub fn main(seed: i32) -> i32 {
        let world: World = seed_world();
        let spawn_command: ecs.Command(World) = do @monad(ecs.Command(World)) {
          ecs.spawn(SpawnRow {
            positions: Position {x: seed},
            velocities: Velocity {dx: 2}
          });
        };
        let spawned: World = ecs.Command::eval(spawn_command, world);
        spawned.len +
          ecs.batch_get(spawned.positions, 0).x +
          ecs.batch_get(spawned.velocities, 0).dx
      }
    `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, {
        resolveModule: resolveProjectModule,
        optMode: "debug",
      }),
    ),
  );
  assertEquals((instance.exports.main as (seed: number) => number)(7), 10);
});

Deno.test.ignore("ecs spawn rejects missing world fields", async () => {
  await assertThrowsCompile(
    `
      const ecs = @import("engine.ecs");

      type fn Position() -> type {
        let Position = {x: i32};
        struct(Position)
      }

      type fn SpawnRow() -> type {
        let SpawnRow = {missing: Position};
        struct(SpawnRow)
      }

      const components = ecs.components({positions: Position});

      type fn World() -> type {
        let Shape = {
          entities: ecs.Batch(4, ecs.BatchIndex(4)),
          len: i32,
          positions: ecs.Batch(4, Position)
        };
        struct(Shape)
      }

      fn seed_world() -> World {
        ecs.World::empty(4, components)
      }

      pub fn main() -> World {
        let world: World = seed_world();
        let command: ecs.Command(World) = do @monad(ecs.Command(World)) {
          ecs.spawn(SpawnRow {missing: Position {x: 1}});
        }
        ecs.Command::eval(command, world)
      }
    `,
    "ecs.spawn_unknown_field",
    { resolveModule: resolveProjectModule },
  );
});

Deno.test.ignore("ecs query set rejects missing world fields", async () => {
  await assertThrowsCompile(
    `
      const ecs = @import("engine.ecs");

      type fn Position() -> type {
        let Position = {x: i32};
        struct(Position)
      }

      type fn FrameInput() -> type { i32 }

      const components = ecs.components({positions: Position});

      type fn World() -> type {
        let Shape = {
          entities: ecs.Batch(4, ecs.BatchIndex(4)),
          len: i32,
          positions: ecs.Batch(4, Position)
        };
        struct(Shape)
      }

      type fn BadRow() -> type {
        let BadRow = {missing: Position, input: FrameInput};
        struct(BadRow)
      }

      fn bad_q() -> ecs.Query(World, FrameInput, BadRow) {
        let missing: ecs.Query(World, FrameInput, Position) = ecs.write(#missing);
        let input: ecs.Query(World, FrameInput, FrameInput) = ecs.res();
        ecs.query(BadRow)
      }

      fn bad_system() -> ecs.System(World, FrameInput) {
        do @monad(ecs.System(World, FrameInput)) {
          ecs.map(bad_q(), \\row -> {missing: row.missing});
        }
      }

      pub fn main(world: World) -> World {
        ecs.run(world, 0, bad_system)
      }
    `,
    "ecs.query_unknown_field",
    { resolveModule: resolveProjectModule },
  );
});

Deno.test("qualified generic batch calls stay calls after lowering", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
      const geometry = @import("prelude.geometry2d");
      pub fn main() -> i32 {
        let batch = Geometry.empty_geometry2d_batch(3);
        batch.len
      }
    `,
        { resolveModule: resolveProjectModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 0);
});

Deno.test("const declarations cannot be annotated as type", async () => {
  await assertThrowsCompile(
    `
      type fn Transform2d() -> type { let Transform2d = {x: i32}; struct(Transform2d) }
      const components: type = {transform: Transform2d};
      pub fn main() -> i32 { 0 }
    `,
    "type.const_dictionary_type",
  );
});

Deno.test("shape and type reflection diagnostics are focused", async () => {
  await assertThrowsCompile(
    "type fn Bad(a: type) -> type { let Shape = {x: a}; let X = @shape_slot(Shape, #y); let Out = {value: X}; struct(Out) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.unknown_shape_slot",
  );
  await assertThrowsCompile(
    "type fn Option(a: type) -> type { let None = {}; union(None) } type fn Bad(a: type) -> type { @type_variant_slots(Option(a), #Some) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.unknown_type_variant",
  );
  await assertThrowsCompile(
    "type fn Bad(a: type) -> type { let Shape = {x: a, y: a}; let Renamed = @shape_rename(Shape, {x: #z, y: #z}); struct(Renamed) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.shape_rename_duplicate",
  );
  await assertThrowsCompile(
    "type fn Bad(a: type) -> type { let Count = @shape_count(a); let Out = {Count*i32}; struct(Out) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.shape_builtin_arg",
  );
  await assertThrowsCompile(
    "type fn NotBool(key: const, value: const) -> type { value } type fn Bad(a: type) -> type { let Shape = {x: a}; let Filtered = @shape_filter(Shape, NotBool); struct(Filtered) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.shape_filter",
  );
});

Deno.test("compile-time builtin diagnostics prefer offending argument spans", async () => {
  await assertFirstDiagnosticSpanIncludes(
    "type fn Bad(a: type) -> type { let Count = @shape_count(a); let Out = {Count*i32}; struct(Out) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.shape_builtin_arg",
    "a",
  );
  await assertFirstDiagnosticSpanIncludes(
    "type fn Bad(a: type) -> type { let Shape = {x: a}; let X = @shape_slot(Shape, #missing); let Out = {value: X}; struct(Out) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.unknown_shape_slot",
    "#missing",
  );
  await assertFirstDiagnosticSpanIncludes(
    "type fn Point() -> type { let Point = {x: i32}; struct(Point) } type fn Bad(t: type) -> type { @type_slot_type(t, #missing) } pub fn f(x: Bad(Point)) -> i32 { 0 }",
    "type.unknown_type_slot",
    "#missing",
  );
  await assertFirstDiagnosticSpanIncludes(
    "const bad = shape_slot({x: i32}, #missing); pub fn main() -> i32 { 0 }",
    "type.unknown_shape_slot",
    "#missing",
  );
});

Deno.test("checks type function result kinds", async () => {
  await checkSource(`
    type fn Point() -> struct { let Point = {x: i32}; struct(Point) }
    type fn Option(a: type) -> union { let None = {}; let Some = {value: a}; union(None, Some) }
    type fn Id() -> type { i32 }
  `);
  await assertThrowsCompile(
    "type fn Bad() -> struct { i32 }",
    "type.result_kind",
  );
  await assertThrowsCompile(
    "type fn Bad() -> struct { let None = {}; union(None) }",
    "type.result_kind",
  );
  await assertThrowsCompile(
    "type fn Bad() -> union { let Point = {x: i32}; struct(Point) }",
    "type.result_kind",
  );
  await assertThrowsCompile(
    `
      type fn Choose(i32: type) -> struct { let Box = {value: i32}; struct(Box) }
      type fn Choose(bool: type) -> union { let None = {}; union(None) }
    `,
    "type.clause_result_kind",
  );
  await assertThrowsCompile(
    "fn main() -> struct { 1 }",
    "parse.lower",
  );
});

Deno.test("operator declarations lower custom infix calls", async () => {
  const checked = await checkSource(`
    type fn Box() -> struct {
      let Box = {value: i32};
      struct(Box)
    }
    fn box_add(a: Box, b: Box) -> Box { Box {value: a.value + b.value} }
    const (+) = @operator(#infixl, 60, box_add);
    pub fn main(a: Box, b: Box) -> Box { a + b }
  `);
  const main = checked.program.declarations.find((decl) =>
    decl.kind === "fn" && decl.name === "main"
  );
  if (!main || main.kind !== "fn") throw new Error("missing main");
  assertEquals(main.body.expr?.kind, "call");
  if (main.body.expr?.kind === "call" && main.body.expr.callee.kind === "var") {
    assertEquals(main.body.expr.callee.name, "box_add");
  }
});

Deno.test("operator declarations lower custom comparison and append calls", async () => {
  const checked = await checkSource(`
    type fn Box() -> struct {
      let Box = {value: i32};
      struct(Box)
    }
    fn box_eql(a: Box, b: Box) -> bool { a.value == b.value }
    fn box_lt(a: Box, b: Box) -> bool { a.value < b.value }
    fn box_append(a: Box, b: Box) -> Box { Box {value: a.value + b.value} }
    const (==) = @operator(#infix, 40, box_eql);
    const (<) = @operator(#infix, 50, box_lt);
    const (<>) = @operator(#infixr, 55, box_append);
    pub fn Eq(a: Box, b: Box) -> bool { a == b }
    pub fn lt(a: Box, b: Box) -> bool { a < b }
    pub fn append(a: Box, b: Box) -> Box { a <> b }
  `);
  const callees = checked.program.declarations
    .filter((decl) => decl.kind === "fn" && decl.public)
    .map((decl) =>
      decl.kind === "fn" && decl.body.expr?.kind === "call" &&
        decl.body.expr.callee.kind === "var"
        ? decl.body.expr.callee.name
        : ""
    );
  assertEquals(callees, ["box_eql", "box_lt", "box_append"]);
});

Deno.test("operator parser honors precedence for extended symbols", async () => {
  const checked = await checkSource(`
    pub fn main() -> i32 { 1 + 2 * 3 % 4 }
  `);
  const main = checked.program.declarations.find((decl) =>
    decl.kind === "fn" && decl.name === "main"
  );
  if (!main || main.kind !== "fn") throw new Error("missing main");
  assertEquals(main.body.expr?.kind, "binary");
  if (main.body.expr?.kind === "binary") assertEquals(main.body.expr.op, "+");
});

Deno.test("ranges lower as syntax instead of operator chains", async () => {
  const program = await parse(`
    pub fn main() -> RangeI32 { 1 + 1 .. 4 }
  `);
  const main = findFn(program, "main");
  assertEquals(main?.body.expr?.kind, "range");
  if (main?.body.expr?.kind === "range") {
    assertEquals(main.body.expr.start.kind, "operator_chain");
    assertEquals(main.body.expr.end.kind, "literal");
  }
});

Deno.test("range syntax is not an overloadable operator", async () => {
  await assertThrowsCompile(
    `
      fn range(a: i32, b: i32) -> RangeI32 { a .. b }
      const (..) = @operator(#infixr, 20, range);
    `,
    "parse.syntax",
  );
});

Deno.test("zip is no longer an infix operator", async () => {
  await assertThrowsCompile("pub fn main() -> i32 { 1 zip 2 }", "parse.syntax");
});

Deno.test("chained ranges require explicit structure", async () => {
  await assertThrowsCompile("pub fn main() -> RangeI32 { 1 .. 2 .. 3 }", "parse.syntax");
});

Deno.test("parses type function examples", async () => {
  const program = await parse(`
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Maybe(a: type) { let Nothing = {}; let Some = {value: a}; union(Nothing, Some) }
    type fn Why(a: count) { let Why = {fst: i32, a*i32}; struct(Why) }
  `);
  assertEquals(program.declarations.map((decl) => decl.kind === "type" ? decl.name : ""), [
    "Point",
    "Maybe",
    "Why",
  ]);
});

Deno.test("checks product constructor expressions", async () => {
  await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    fn make(x: i32) -> Box { Box {value: x} }
    pub fn main() -> i32 { make(1).value }
  `);
  await assertThrowsCompile(
    `
    type fn Box() { let Box = {value: i32}; struct(Box) }
    fn make(x: i32) -> Box { Box {} }
  `,
    "type.constructor_missing_slot",
  );
  await assertThrowsCompile(
    `
    type fn Box() { let Box = {value: i32}; struct(Box) }
    fn make(x: i32) -> Box { Box {value: x, other: x} }
  `,
    "type.constructor_unknown_slot",
  );
  await assertThrowsCompile(
    `
    fn make(x: i32) -> i32 { Missing {value: x} }
  `,
    "type.unknown_constructor",
  );
});

Deno.test("reports type function diagnostics", async () => {
  await assertThrowsCompile(
    "type fn Bad(a: count) { let Bad = {x: a, a*i32}; struct(Bad) }",
    "type.param_kind_conflict",
  );
  await assertThrowsCompile("type fn Loop() { Loop() }", "type.recursive_type_fn");
  await assertThrowsCompile(
    "type fn Bad(t: type) { match t { i32 => i32 } } fn f(x: Bad(bool)) -> i32 { 1 }",
    "type.non_exhaustive_match",
  );
  await assertThrowsCompile(
    "type fn Bad(t: type) { type_is_product(t) } fn f(x: Bad(i32)) -> i32 { 1 }",
    "type.static_builtin_prefix",
  );
  await assertThrowsCompile(
    `
    const host_call = @external("host", fn(host: io) -> io(bool));
    type fn Bad(t: type) { match host_call(t) { true => i32, false => bool } }
    fn f(x: Bad(i32)) -> i32 { 1 }
  `,
    "type.runtime_effect_call",
  );
  await assertThrowsCompile(
    `
    fn unsupported(t) -> bool { 1 + 2 }
    type fn Bad(t: type) { match unsupported(t) { true => i32, false => bool } }
    fn f(x: Bad(i32)) -> i32 { 1 }
  `,
    "type.unsupported_expr",
  );
  await assertThrowsCompile(
    "type fn bad(a: type) { let Bad = {value: a}; struct(Bad) }",
    "parse.syntax",
  );
  await assertThrowsCompile(
    "type fn Bad(A: type) { let Bad = {value: A}; struct(Bad) }",
    "type.type_param_casing",
  );
  await assertThrowsCompile(
    "type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) } fn f(x: option(i32)) -> i32 { 1 }",
    "type.lowercase_type_constructor",
  );
  await checkSource(
    "type fn Pair(a: type) { let Pair = {fst: a, snd: a}; struct(Pair) } fn f(x: Pair(i32)) -> i32 { 1 }",
  );
  await checkSource(
    "type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) } fn unwrap_or(value: Option(a), fallback: a) -> a { match value { Some(x) => x, None => fallback } }",
  );
});

Deno.test("dispatches ordered type function clauses", async () => {
  const checked = await checkSource(`
    type fn Choose(t: type) -> type { t }
    type fn Choose(i32: type) -> type { bool }
    type fn CountCase(_: count) -> type { i32 }
    type fn CountCase(0: count) -> type { bool }
    type fn CountShadow() -> type { CountCase(0) }
    fn first(x: Choose(i32)) -> bool { x }
  `);
  const first = findFn(checked.program, "first");
  const countShadow = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "CountShadow"
  );
  assertEquals(first?.params[0].type, "Choose(i32)");
  assertEquals(countShadow?.normalized, { kind: "alias", type: "CountCase(0)" });
});

Deno.test("accepts ordered value function literal clauses", async () => {
  const checked = await checkSource(`
    fn something_n(1: i32) -> i32 { 10 }
    fn something_n(a: i32) -> i32 { a }
    pub fn main() -> i32 { something_n(1) }
  `);
  assertEquals(findFns(checked.program, "something_n__clause_0").length, 1);
  assertEquals(findFns(checked.program, "something_n__clause_1").length, 1);
});

Deno.test("wildcard value patterns check without binding underscore", async () => {
  await checkSource(`
    type fn IterStep(state: type, item: type) -> type {
      let Done = {};
      let Yield = {item: item, next: state};
      union(Done, Yield)
    }
    fn literal_clause(_: i32, 1: i32) -> i32 { 1 }
    fn add(a: i32, b: i32) -> i32 { a + b }
    fn match_tuple(pair: [i32, i32]) -> i32 {
      match pair { _, right => right }
    }
    fn match_yield(step: IterStep(i32, i32)) -> i32 {
      match step { Yield(_, next) => next, Done => 0 }
    }
    pub fn main() -> i32 { literal_clause(4, 1) + add(2, 3) }
  `);
});

Deno.test("rejects incompatible value function clauses", async () => {
  await assertThrowsCompile(
    `
    fn Bad(1: i32) -> i32 { 1 }
    fn Bad(a: i32, b: i32) -> i32 { a }
  `,
    "fn.clause_arity",
  );
  await assertThrowsCompile(
    `
    fn Bad(1: i32) -> i32 { 1 }
    fn Bad(a: i32) -> bool { true }
  `,
    "fn.clause_return",
  );
});

Deno.test("accepts refined i32 domain value function clauses", async () => {
  const checked = await checkSource(`
    fn step(i: i32(4)) -> i32 { i }
    fn step(i: i32(0..4)) -> i32 { i + 1 }
    pub fn main() -> i32 { step(0) + step(4) }
  `);
  const dispatcher = findFns(checked.program, "step")[0];
  assertEquals(dispatcher?.params[0].type, "i32");
  assertEquals(findFns(checked.program, "step__clause_0")[0]?.params[0].type, "i32(4)");
  assertEquals(findFns(checked.program, "step__clause_1")[0]?.params[0].type, "i32(0..4)");
});

Deno.test("accepts union refined i32 domain value function clauses", async () => {
  await checkSource(`
    fn pick(i: i32(1 | 3..5 | 8)) -> i32 { i }
    fn pick(i: i32) -> i32 { 0 }
    pub fn main() -> i32 { pick(3) + pick(2) }
  `);
});

Deno.test("release folds literal calls through refined i32 domain dispatch", async () => {
  const source = `
    fn f(x: i32(0)) -> i32 { 10 }
    fn f(x: i32(1..4)) -> i32 { 20 }
    pub fn main() -> i32 { f(0) + f(2) }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.const 30");
  assert(!wat.includes("call $f"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 30);
});

Deno.test("rejects unreachable single-parameter value function clauses", async () => {
  await assertThrowsCompile(
    `
      fn dead(i: i32(0..4)) -> i32 { i }
      fn dead(i: i32(2..3)) -> i32 { i + 10 }
      pub fn main() -> i32 { dead(2) }
    `,
    "fn.unreachable_clause",
  );
  await assertThrowsCompile(
    `
      fn shadow(i: i32) -> i32 { i }
      fn shadow(1: i32) -> i32 { 10 }
      pub fn main() -> i32 { shadow(1) }
    `,
    "fn.unreachable_clause",
  );
});

Deno.test("rejects partially overlapping refined i32 function clauses", async () => {
  await assertThrowsCompile(
    `
      fn partial(i: i32(0..4)) -> i32 { 1 }
      fn partial(i: i32(2..6)) -> i32 { 2 }
      pub fn main(i: i32) -> i32 { partial(i) }
    `,
    "fn.overlapping_clause",
  );
  await checkSource(`
    fn literal_split(0: i32(0..4)) -> i32 { 10 }
    fn literal_split(1: i32(0..6)) -> i32 { 20 }
    pub fn main() -> i32 { literal_split(0) + literal_split(1) }
  `);
});

Deno.test("rejects calls with refined i32 domains not covered by clauses", async () => {
  await assertThrowsCompile(
    `
      fn partial(i: i32(0..4)) -> i32 { 1 }
      fn partial(i: i32(5..8)) -> i32 { 2 }
      pub fn main(i: i32(0..8)) -> i32 { partial(i) }
    `,
    "fn.clause_domain_uncovered",
  );
  await checkSource(`
    fn covered(i: i32(0..4)) -> i32 { 1 }
    fn covered(i: i32(4)) -> i32 { 2 }
    pub fn main(i: i32(0..5)) -> i32 { covered(i) }
  `);
});

Deno.test("reports tree-sitter syntax errors", async () => {
  await assertThrowsCompile("pub fn main( { 1 }", "parse.syntax");
});

Deno.test("parser front end is Baba generated", async () => {
  const parserSource = await Deno.readTextFile(new URL("../src/parser.ts", import.meta.url));
  assert(parserSource.includes("../generated/baba-workbench/parser.ts"));
  assert(!parserSource.includes("tokenize("));
  assert(!parserSource.includes("class Parser"));
});

Deno.test("tokenizes through Baba generated lexer", () => {
  const tokens = tokenize(`
    // comment
    pub fn main() -> i32 {
      let text = \`\`\`hello
world\`\`\`;
      #Tag 42 "ok" 'x' true zip ..
    }
  `);
  assertEquals(
    tokens.map((token) => [token.kind, token.text]),
    [
      ["pub", "pub"],
      ["fn", "fn"],
      ["identifier", "main"],
      ["symbol", "("],
      ["symbol", ")"],
      ["symbol", "->"],
      ["i32", "i32"],
      ["symbol", "{"],
      ["let", "let"],
      ["identifier", "text"],
      ["symbol", "="],
      ["multiline", "```hello\nworld```"],
      ["symbol", ";"],
      ["literalType", "#Tag"],
      ["number", "42"],
      ["string", '"ok"'],
      ["char", "'x'"],
      ["bool", "true"],
      ["identifier", "zip"],
      ["symbol", ".."],
      ["symbol", "}"],
    ],
  );
});

Deno.test("rejects public functions without return signatures", async () => {
  await assertThrowsCompile(
    `
    pub fn main() { 1 }
  `,
    "type.public_signature",
  );
});

Deno.test("compiler intrinsic wrappers typecheck and stay out of runtime output", async () => {
  const checked = await checkSource(`
    fn branch.handle(ptr: i32) -> i64 { @branch_handle(ptr) }
    fn use_it(x: i32) -> i64 { branch.handle(x) }
  `);
  const wrapper = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "branch.handle"
  );
  assertEquals(wrapper?.primitiveId, undefined);

  const wat = await watFromSource(`
    fn branch.handle(ptr: i32) -> i64 { @branch_handle(ptr) }
    pub fn main() -> i32 { 1 }
  `);
  assert(!wat.includes("(func $branch.handle"));

  await assertThrowsCompile(
    "fn nope(x: i32) -> i32 { @ptr_not_a_primitive(x) }",
    "primitive.unknown",
  );
  await checkSource(`
    fn a(x: i32) -> i64 { @branch_handle(x) }
    fn b(x: i32) -> i64 { @branch_handle(x) }
  `);
});

Deno.test("namespace source imports qualify values and types", async () => {
  const modules = new Map([
    [
      "prelude.std",
      `
        type fn Lane4I32() { {4*i32} }
        type fn Pair(a: type, b: type) { {fst: a, snd: b} }
        fn inc_local(x: i32) -> i32 { x + 1 }
        pub fn inc(x: i32) -> i32 { inc_local(x) }
        pub fn map4_i32(f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
          [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
        }
      `,
    ],
    [
      "./local_module.fig",
      `
        fn helper(x: i32) -> i32 { x + 2 }
        pub fn use_helper(x: i32) -> i32 { helper(x) }
      `,
    ],
  ]);
  const seen: string[] = [];
  const resolveModule = (specifier: string) => {
    seen.push(specifier);
    return modules.get(specifier);
  };

  const checked = await checkSource(
    `
      const std = @import("prelude.std");
      const local = @import("./local_module.fig");
      pub fn main() -> std.Lane4I32 { std.map4_i32(std.inc, [1, 2, 3, 4]) }
      fn pair_value() -> std.Pair(i32, i32) { {fst: 1, snd: 2} }
      fn local_value() -> i32 { local.use_helper(1) }
    `,
    { resolveModule },
  );

  assertEquals(seen, ["prelude.std", "./local_module.fig"]);
  assert(checked.program.declarations.some((decl) => decl.name === "std.map4_i32"));
  assert(checked.program.declarations.some((decl) => decl.name === "std.inc_local"));
  assert(!checked.program.declarations.some((decl) => decl.name === "std"));

  assert(!checked.program.declarations.some((decl) => decl.name === "map4_i32"));
  await assertThrowsCompile(
    `
      const std = @import("prelude.std");
      const std = @import("./local_module.fig");
      pub fn main() -> i32 { 1 }
    `,
    "module.duplicate_alias",
    { resolveModule },
  );
});

Deno.test("namespace source imports do not qualify type annotation field labels", async () => {
  const modules = new Map([
    [
      "labels.lib",
      `
        fn value(seed: i32) -> i32 { seed + 1 }
        pub fn read(row: struct({value: i32})) -> i32 {
          row.value + value(2)
        }
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  const source = `
    const labels = @import("labels.lib");
    pub fn main() -> i32 { labels.read({value: 4}) }
  `;
  const checked = await checkSource(source, { resolveModule });
  const readDecl = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "labels.read"
  );
  assertEquals(readDecl?.params[0]?.type, "struct({value: i32})");

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 7);
});

Deno.test("namespace source imports preserve transitive declarations shadowed by parameter names", async () => {
  const modules = new Map([
    [
      "asset.lib",
      `
        type fn Handle(kind: const) -> type {
          let Handle = {id: i32};
          struct(Handle)
        }
        fn handle(const kind: const, id: i32) -> Handle(kind) {
          Handle {id: id}
        }
        fn id(value: Handle(kind)) -> i32 { value.id }
      `,
    ],
    [
      "canvas.lib",
      `
        const asset = @import("asset.lib");
        fn texture(id: i32) -> asset.Handle(#texture) {
          asset.handle(#texture, id)
        }
        fn draw(canvas: i32, sprite: struct({atlas: asset.Handle(#texture)})) -> i32 {
          canvas + asset.id(sprite.atlas)
        }
      `,
    ],
    [
      "game.lib",
      `
        const canvas = @import("canvas.lib");
        pub fn use(canvas: i32) -> i32 {
          canvas.draw(canvas, {atlas: canvas.texture(4)})
        }
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);
  const source = `
    const game = @import("game.lib");
    pub fn main() -> i32 { game.use(3) }
  `;

  const checked = await checkSource(source, { resolveModule });
  const textureDecl = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "canvas.texture"
  );
  assertEquals(textureDecl?.returnType, "asset.Handle(#texture)");

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 7);
});

Deno.test("destructured source imports select exact declarations", async () => {
  const modules = new Map([
    [
      "prelude.array",
      `
        type fn Lane4I32() -> type { {4*i32} }
        fn inc_local(x: i32) -> i32 { x + 1 }
        pub fn lane4_add_i32(xs: Lane4I32, ys: Lane4I32) -> Lane4I32 {
          [xs[0] + ys[0], xs[1] + ys[1], xs[2] + ys[2], xs[3] + ys[3]]
        }
        pub fn map4_i32(f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
          [f(inc_local(xs[0])), f(xs[1]), f(xs[2]), f(xs[3])]
        }
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  const parsed = await parse('const { map4_i32, Lane4I32, } = @import("prelude.array");');
  assertEquals(parsed.sourceImports?.[0].bindings?.map((binding) => binding.name), [
    "map4_i32",
    "Lane4I32",
  ]);

  const checked = await checkSource(
    `
      const { map4_i32, lane4_add_i32 } = @import("prelude.array");
      fn inc(x: i32) -> i32 { x + 1 }
      pub fn main() -> i32 {
        let xs = map4_i32(inc, [1, 2, 3, 4]);
        lane4_add_i32(xs, xs)[0]
      }
    `,
    { resolveModule },
  );

  const names = checked.program.declarations.map((decl) => decl.name);
  assert(names.includes("map4_i32"));
  assert(names.includes("lane4_add_i32"));
  assert(names.some((name) => name.endsWith(".inc_local")));
  assert(!names.includes("inc_local"));
});

Deno.test("destructured source imports diagnose invalid bindings and conflicts", async () => {
  const modules = new Map([
    ["prelude.array", "pub fn map4_i32(x: i32) -> i32 { x }"],
    ["prelude.layout", "pub fn width() -> i32 { 4 }"],
    ["prelude.std", 'const layout = @import("prelude.layout"); pub fn value() -> i32 { 1 }'],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  await assertThrowsCompile(
    'const { missing } = @import("prelude.array"); pub fn main() -> i32 { 1 }',
    "module.missing_binding",
    { resolveModule },
  );
  await assertThrowsCompile(
    'const { map4_i32, map4_i32 } = @import("prelude.array"); pub fn main() -> i32 { 1 }',
    "module.duplicate_binding",
    { resolveModule },
  );
  await assertThrowsCompile(
    'const { map4_i32 } = @import("prelude.array"); fn map4_i32() -> i32 { 1 }',
    "module.duplicate_import",
    { resolveModule },
  );
  await assertThrowsCompile(
    "const { map4_i32 } = 1; pub fn main() -> i32 { 1 }",
    "parse.lower",
  );
  await assertThrowsCompile(
    'const { width } = @import("prelude.std"); pub fn main() -> i32 { width() }',
    "module.missing_binding",
    { resolveModule },
  );
});

Deno.test("namespace source imports hide transitive namespaces from root source", async () => {
  const modules = new Map([
    [
      "prelude.layout",
      `
        type fn Lane4I32() -> type { {4*i32} }
      `,
    ],
    [
      "prelude.array",
      `
        const layout = @import("prelude.layout");
        pub fn map4_i32(f: fn(x: i32) -> i32, xs: layout.Lane4I32) -> layout.Lane4I32 {
          [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
        }
      `,
    ],
    [
      "prelude.std",
      `
        const array = @import("prelude.array");
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  await assertThrowsCompile(
    `
      const std = @import("prelude.std");
      fn inc(x: i32) -> i32 { x + 1 }
      pub fn main() -> layout.Lane4I32 {
        array.map4_i32(inc, [1, 2, 3, 4])
      }
    `,
    "module.transitive_import",
    { resolveModule },
  );

  await checkSource(
    `
      const layout = @import("prelude.layout");
      const array = @import("prelude.array");
      fn inc(x: i32) -> i32 { x + 1 }
      pub fn main() -> layout.Lane4I32 {
        array.map4_i32(inc, [1, 2, 3, 4])
      }
    `,
    { resolveModule },
  );

  await assertThrowsCompile(
    `
      const std = @import("prelude.std");
      fn inc(x: i32) -> i32 { x + 1 }
      pub fn main() -> std.array.layout.Lane4I32 {
        std.array.map4_i32(inc, [1, 2, 3, 4])
      }
    `,
    "type.unknown_type",
    { resolveModule },
  );
});

Deno.test("namespace source imports preserve same-name recursive function clauses", async () => {
  const modules = new Map([
    [
      "math.loop",
      `
        fn sum4_go(i: i32(4), acc: i32) -> i32 { acc }
        fn sum4_go(i: i32(0..4), acc: i32) -> i32 { sum4_go(i + 1, acc + i) }
        pub fn sum4() -> i32 { sum4_go(0, 0) }
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
          const math = @import("math.loop");
          pub fn main() -> i32 { math.sum4() }
        `,
        { resolveModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 6);
});

Deno.test("namespace source imports qualify do strategy effects", async () => {
  const modules = new Map([
    [
      "module.effect",
      `
        type fn Id(a: type) -> type { a }
        fn Id::pure(value: a) -> Id(a) { value }
        fn Id::bind(value: Id(a), const step: fn(value: a) -> Id(b)) -> Id(b) {
          step(value)
        }
        pub fn value() -> Id(i32) {
          do @monad(Id(_)) { pure(3) }
        }
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  await checkSource(
    `
      const effect = @import("module.effect");
      pub fn main() -> i32 { 1 }
    `,
    { resolveModule },
  );
});

Deno.test("pruneImports keeps reachable imported declarations and drops unused imported work", async () => {
  const modules = new Map([
    [
      "prelude.small",
      `
        type fn Box() -> type {
          let Box = {value: i32};
          struct(Box)
        }
        fn helper(x: i32) -> i32 { x + 1 }
        pub fn used(x: i32) -> Box { Box {value: helper(x)} }
        fn unused_bad(x: i32) -> i32 { missing_helper(x) }
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  const unpruned = await checkSource(
    `
      const lib = @import("prelude.small");
      pub fn main() -> i32 {
        let out = lib.used(1);
        out.value
      }
    `,
    { resolveModule },
  );
  assert(unpruned.program.declarations.some((decl) => decl.name === "lib.unused_bad"));

  const checked = await checkSource(
    `
      const lib = @import("prelude.small");
      pub fn main() -> i32 {
        let out = lib.used(1);
        out.value
      }
    `,
    { resolveModule, pruneImports: true },
  );
  const names = checked.program.declarations.map((decl) => decl.name);
  assert(names.includes("lib.Box"));
  assert(names.includes("lib.helper"));
  assert(names.includes("lib.used"));
  assert(!names.includes("lib.unused_bad"));
});

Deno.test("pruneImports keeps array_static range fold dependencies", async () => {
  const source = `
    const array = @import("prelude.array_static");
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    pub fn main(seed: i32) -> i32 {
      array.RangeIter::fold(array.RangeI32::Iter(seed - seed .. 1000), 0, add)
    }
  `;
  const checked = await checkSource(source, { resolveModule: resolveProjectModule });
  const pruned = await checkSource(source, {
    resolveModule: resolveProjectModule,
    pruneImports: true,
  });

  assert(
    pruned.program.declarations.length < checked.program.declarations.length,
    `${pruned.program.declarations.length} !< ${checked.program.declarations.length}`,
  );
  const names = pruned.program.declarations.map((decl) => decl.name);
  assert(names.includes("array.RangeI32"));
  assert(names.includes("array.RangeIter"));
  assert(names.includes("array.RangeI32::Iter"));
  assert(names.includes("array.RangeIter::fold"));
  assert(names.includes("array.RangeIter::fold_loop"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, {
        resolveModule: resolveProjectModule,
        pruneImports: true,
        optMode: "release",
      }),
    ),
  );
  assertEquals((instance.exports.main as (seed: number) => number)(0), 499500);
});

Deno.test("merge source import alias is ordinary namespace alias", async () => {
  const modules = new Map([
    [
      "prelude.array",
      `
        type fn Lane4I32() -> type { {4*i32} }
        pub fn map4_i32(x: i32) -> i32 { x + 1 }
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  const checked = await checkSource(
    `
      const merge = @import("prelude.array");
      pub fn main() -> i32 { merge.map4_i32(1) }
    `,
    { resolveModule },
  );
  assert(checked.program.declarations.some((decl) => decl.name === "merge.map4_i32"));
  assert(!checked.program.declarations.some((decl) => decl.name === "map4_i32"));
  await assertThrowsCompile(
    `
      const merge = @import("prelude.array");
      const merge = @import("prelude.array");
      pub fn main() -> i32 { 1 }
    `,
    "module.duplicate_alias",
    { resolveModule },
  );
});

Deno.test("source import diagnostics use import span and module source ids", async () => {
  try {
    await checkSource('const lib = @import("missing.lib"); pub fn main() -> i32 { 1 }', {
      sourceId: "root.fig",
      resolveModule: () => undefined,
    });
    throw new Error("expected missing module diagnostic");
  } catch (error) {
    assert(error instanceof CompileError);
    const diagnostic = error.diagnostics.find((item) => item.code === "module.not_found");
    assert(diagnostic, JSON.stringify(error.diagnostics));
    assertEquals(diagnostic.span?.sourceId, "root.fig");
    assertEquals(diagnostic.span?.line, 1);
    assertEquals(diagnostic.span?.column, 1);
  }

  try {
    await checkSource('const lib = @import("string.lib"); pub fn main() -> i32 { 1 }', {
      resolveModule: () => "pub fn Bad( { 1 }",
    });
    throw new Error("expected imported module diagnostic");
  } catch (error) {
    assert(error instanceof CompileError);
    const diagnostic = error.diagnostics.find((item) => item.code === "parse.syntax");
    assert(diagnostic, JSON.stringify(error.diagnostics));
    assertEquals(diagnostic.span?.sourceId, "string.lib");
  }

  try {
    await checkSource('const lib = @import("named.lib"); pub fn main() -> i32 { 1 }', {
      resolveModule: () => ({
        text: "pub fn Bad( { 1 }",
        sourceId: "virtual/named.fig",
      }),
    });
    throw new Error("expected imported module diagnostic");
  } catch (error) {
    assert(error instanceof CompileError);
    const diagnostic = error.diagnostics.find((item) => item.code === "parse.syntax");
    assert(diagnostic, JSON.stringify(error.diagnostics));
    assertEquals(diagnostic.span?.sourceId, "virtual/named.fig");
  }
});

Deno.test("namespace source imports qualify fields and type-block names", async () => {
  const modules = new Map([
    [
      "layout.lib",
      `
        type fn Pair() -> type {
          let Pair = {left: i32, right: i32};
          struct(Pair)
        }
        type fn Triple() -> type { {3*i32} }
        const default_pair = {left: 7, right: 11}
        pub fn build() -> Triple {
          [11, 12, 13]
        }
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  const checked = await checkSource(
    `
      const layout = @import("layout.lib");
      pub fn main() -> i32 {
        let xs: layout.Triple = layout.build();
        xs[0] + @field(layout.default_pair, #left)
      }
    `,
    { resolveModule },
  );

  const names = checked.program.declarations.map((decl) => decl.name);
  const pairDecl = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "layout.Pair"
  );
  assert(names.includes("layout.default_pair"));
  assert(pairDecl?.body.statements.some((stmt) => stmt.name === "layout.Pair"));
  assert(!names.includes("default_pair"));
  assert(!pairDecl?.body.statements.some((stmt) => stmt.name === "Pair"));
});

Deno.test("rejects host IO imports without explicit IO parameter", async () => {
  await assertThrowsCompile(
    `
    const clock = @external("clock", fn() -> io(i64));
    pub fn main() -> i32 { clock() }
  `,
    "external.io_param",
  );
});

Deno.test("rejects external imports without IO action return", async () => {
  await assertThrowsCompile(
    `
    const clock = @external("clock", fn(host: io) -> i64);
    pub fn main(host: io) -> i64 { clock(host) }
  `,
    "external.io_return",
  );
});

Deno.test("rejects declaration-only compiler builtins in expressions", async () => {
  await assertThrowsCompile(
    'pub fn main() -> i32 { @import("prelude.core") }',
    "syntax.declaration_builtin",
  );
  await assertThrowsCompile(
    "pub fn main() -> i32 { const bad = @import; 1 }",
    "syntax.declaration_builtin",
  );
});

Deno.test("do @io unwraps IO actions and requires final IO action", async () => {
  await checkSource(`
    const clock = @external("clock", fn(host: io) -> io(i32));
    pub fn main(host: io) -> io(i32) {
      do @io(_) {
        now <- clock(host);
        return(now + 1)
      }
    }
  `);

  await checkSource(`
    fn done(value: i32) -> io(i32) { return(value) }
    const clock = @external("clock", fn(host: io) -> io(i32));
    pub fn main(host: io) -> io(i32) {
      do @io(_) {
        now <- clock(host);
        done(now + 1)
      }
    }
  `);

  await assertThrowsCompile(
    `
      const clock = @external("clock", fn(host: io) -> io(i32));
      pub fn main(host: io) -> io(i32) {
        do @io(_) {
          now <- clock(host);
          now
        }
      }
    `,
    "do.io_return",
  );

  await checkSource(`
    const clock = @external("clock", fn(host: io) -> io(i32));
    pub fn main(host: io) -> io(i32) {
      do @io(i32) {
        now <- clock(host);
        return(now + 1)
      }
    }
  `);

  await assertThrowsCompile(
    `
      const clock = @external("clock", fn(host: io) -> io(i32));
      pub fn main(host: io) -> io(i32) {
        do @io {
          now <- clock(host);
          return(now)
        }
      }
    `,
    "do.io_strategy_arity",
  );

  await assertThrowsCompile(
    `
      const clock = @external("clock", fn(host: io) -> io(i32));
      pub fn main(host: io) -> io(i32) {
        do @io(io(i32)) {
          now <- clock(host);
          return(now)
        }
      }
    `,
    "do.io_strategy_type",
  );

  await assertThrowsCompile(
    `
      const clock = @external("clock", fn(host: io) -> io(i32));
      pub fn main(host: io) -> io(i32) {
        do @io(bool) {
          now <- clock(host);
          return(now)
        }
      }
    `,
    "do.io_return_type",
  );
});

Deno.test("return is a reserved IO compiler builtin", async () => {
  await checkSource(`
    fn done(value: i32) -> io(i32) { return(value) }
    pub fn main(host: io) -> io(i32) { done(1) }
  `);
  await assertThrowsCompile(
    "fn bad() -> io(i32) { return() }",
    "io.return_arity",
  );
  await assertThrowsCompile(
    "fn bad() -> i32 { return(1) }",
    "type.literal_mismatch",
  );
  await assertThrowsCompile(
    "fn return(x: i32) -> i32 { x }",
    "name.reserved",
  );
  await assertThrowsCompile(
    "fn bad() -> i32 { let return = 1; return }",
    "name.reserved",
  );
});

Deno.test("source function-effect syntax remains rejected", async () => {
  await assertThrowsCompile(
    `fn pure() -> i32 !{} { 1 }`,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `fn tick() -> i32 !{time} { 1 }`,
    "parse.syntax",
  );
});

Deno.test("top-level const evaluates pure product helpers", async () => {
  const source = `
    type fn Point() -> type {
      let Point = {x: i32, y: i32};
      struct(Point)
    }
    fn point(x: i32) -> Point {
      Point {x, y: x + 1}
    }
    const origin = point(1);
    pub fn main() -> i32 {
      origin.x + origin.y
    }
  `;

  const checked = await checkSource(source);
  const origin = checked.program.declarations.find((decl): decl is ConstDecl =>
    decl.kind === "const" && decl.name === "origin"
  );
  assertEquals(origin?.value.kind, "shape");
  if (origin?.value.kind === "shape") {
    assertEquals(origin.value.inferredType, "Point");
  }

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as () => number)(), 3);
});

Deno.test("top-level const evaluates pure scalar helpers", async () => {
  const source = `
    fn add(a: i32, b: i32) -> i32 {
      a + b
    }
    const x = add(1, 2);
    pub fn main() -> i32 {
      x
    }
  `;
  const checked = await checkSource(source);
  const x = checked.program.declarations.find((decl): decl is ConstDecl =>
    decl.kind === "const" && decl.name === "x"
  );
  assertEquals(x?.value, {
    kind: "literal",
    literalKind: "number",
    value: "3",
    inferredType: "i32",
  });
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as () => number)(), 3);
});

Deno.test("top-level const evaluates higher-order const functions", async () => {
  const source = `
    fn apply(const f: fn(v: i32) -> i32, value: i32) -> i32 {
      f(value)
    }
    const y = apply(\\v -> v + 1, 2);
    pub fn main() -> i32 {
      y
    }
  `;
  const checked = await checkSource(source);
  const y = checked.program.declarations.find((decl): decl is ConstDecl =>
    decl.kind === "const" && decl.name === "y"
  );
  assertEquals(y?.value, {
    kind: "literal",
    literalKind: "number",
    value: "3",
    inferredType: "i32",
  });
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as () => number)(), 3);
});

Deno.test("top-level const preserves phantom scalar return types", async () => {
  const checked = await checkSource(`
    type fn Descriptor(value: type) -> type {
      i32
    }
    fn descriptor() -> Descriptor(i32) {
      0
    }
    const d = descriptor();
    pub fn main() -> i32 {
      d
    }
  `);
  const d = checked.program.declarations.find((decl): decl is ConstDecl =>
    decl.kind === "const" && decl.name === "d"
  );
  assertEquals(d?.value, {
    kind: "literal",
    literalKind: "number",
    value: "0",
    inferredType: "Descriptor(i32)",
  });
});

Deno.test("top-level const rejects impure unknown and runtime-dependent initializers", async () => {
  await assertThrowsCompile(
    `
      const clock = @external("clock", fn(host: io) -> io(i32));
      const host = 0;
      const x = clock(host);
      pub fn main(host: io) -> i32 { clock(host) }
    `,
    "const.runtime_call",
  );
  await assertThrowsCompile(
    `
      const x = missing();
      pub fn main() -> i32 { 0 }
    `,
    "const.runtime_call",
  );
  await assertThrowsCompile(
    `
      fn id(x: i32) -> i32 { x }
      const x = id(seed);
      pub fn main(seed: i32) -> i32 { seed }
    `,
    "const.unknown_name",
  );
});

Deno.test("top-level const evaluates imported pure product helpers", async () => {
  const modules = new Map([
    [
      "pure.assets",
      `
        type fn Handle(kind: const) -> type {
          let Handle = {id: i32};
          struct(Handle)
        }
        fn handle(const kind: const, id: i32) -> Handle(kind) {
          Handle {id}
        }
        fn texture(id: i32) -> Handle(#texture) {
          handle(#texture, id)
        }
        fn id(value: Handle(kind)) -> i32 {
          value.id
        }
      `,
    ],
  ]);
  const source = `
    const assets = @import("pure.assets");
    const atlas = assets.texture(7);
    pub fn main() -> i32 {
      assets.id(atlas)
    }
  `;

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule: (name) => modules.get(name) }),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 7);
});

Deno.test("requires explicit IO values for host IO imports", async () => {
  await checkSource(`
    const clock = @external("clock", fn(host: io) -> io(i32));
    pub fn main(host: io) -> i32 { clock(host) }
  `);
  await assertThrowsCompile(
    `
      const clock = @external("clock", fn(host: io) -> io(i32));
      pub fn main() -> i32 { clock(io) }
    `,
    "const.unknown_name",
  );
});

Deno.test("ordinary values allow reuse after calls", async () => {
  await checkSource(
    `
    fn sink(x: i32) -> i32 { x }
    pub fn main() -> i32 {
      let x = 1;
      let moved = sink(x);
      x + moved
    }
  `,
  );
});

Deno.test("rejects unsupported ownership and explicit memory forms", async () => {
  await assertThrowsCompile("pub fn main() -> i32 { fork(1) }", "function.unknown");
  await assertThrowsCompile("fn bad(x: &(i32)) -> i32 { 0 }", "parse.syntax");
  await assertThrowsCompile("pub fn main() -> i32 { let x = 1; &x }", "parse.syntax");
  await assertThrowsCompile("fn bad(x: #(i32)) -> i32 { 0 }", "parse.syntax");
  await assertThrowsCompile("pub fn main(mem: memory) -> i32 { 0 }", "type.unknown_type");
  await assertThrowsCompile(
    "fn bad(x: i32) -> i32 { @memory_load_i32(x, x) }",
    "primitive.unknown",
  );
  await assertThrowsCompile("fn bad(x: i32) -> i32 { @ptr_add(x, 1) }", "primitive.unknown");
  await assertThrowsCompile("fn bad(x: i32) -> i32 { @freeze(x) }", "primitive.unknown");
});

Deno.test("rejects local shadowing and requires source-ordered locals", async () => {
  await checkSource(`
    fn sink(x: i32) -> i32 { x }
    pub fn main() -> i32 {
      let x = 1;
      let moved = sink(x);
      x + moved
    }
  `);
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let b = a + 1;
      let a = 1;
      b
    }
  `,
    "type.local_order",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let x = 1;
      let x = 2;
      x
    }
  `,
    "type.duplicate_local",
  );
  await assertThrowsCompile(
    `
    fn pair() -> [i32, i32] { [1, 2] }
    pub fn main() -> i32 {
      let x = 1;
      let x, y = pair();
      x + y
    }
  `,
    "type.duplicate_local",
  );
  await assertThrowsCompile(
    `
    fn pair() -> [i32, i32] { [1, 2] }
    pub fn main() -> i32 {
      let x, x = pair();
      x
    }
  `,
    "type.duplicate_local",
  );
  await assertThrowsCompile(
    `
    type fn Proof(t: type) -> type { t }
    pub fn main() -> i32 {
      const proof = Proof(i32);
      const proof = Proof(i32);
      1
    }
  `,
    "type.duplicate_local",
  );
  await assertThrowsCompile(
    `
    type fn Id(a: type) -> type { a }
    fn Id::pure(value: a) -> Id(a) { value }
    fn Id::bind(value: Id(a), const f: fn(x: a) -> Id(b)) -> Id(b) { f(value) }
    pub fn main() -> Id(i32) {
      do @monad(Id(_)) {
        let x = 1;
        let x = 2;
        pure(x)
      }
    }
  `,
    "type.duplicate_local",
  );
  await assertThrowsCompile(
    `
    type fn Id(a: type) -> type { a }
    fn Id::pure(value: a) -> Id(a) { value }
    fn Id::bind(value: Id(a), const f: fn(x: a) -> Id(b)) -> Id(b) { f(value) }
    pub fn main() -> Id(i32) {
      do @monad(Id(_)) {
        x <- Id::pure(1);
        x <- Id::pure(2);
        pure(x)
      }
    }
  `,
    "type.duplicate_local",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let a = b;
      let b = a;
      a
    }
  `,
    "type.local_order",
  );
  await assertThrowsCompile(
    `
    type fn Id(a: type) -> type { a }
    fn Id::pure(value: a) -> Id(a) { value }
    fn Id::bind(value: Id(a), const f: fn(x: a) -> Id(b)) -> Id(b) { f(value) }
    pub fn main() -> Id(i32) {
      do @monad(Id(_)) {
        let y = x + 1;
        x <- Id::pure(1);
        pure(y)
      }
    }
  `,
    "type.local_order",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      x = 1;
      x
    }
  `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let
      x = 1
      x
    }
  `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let x = 1
      let y = 2;
      x
    }
  `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let y = 2
      y
    }
  `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let x = 1;
      let y, z = other(x);
      x
    }
  `,
    "type.destructure_non_multi",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let x = 1;
      let y, z = x + 1;
      x
    }
  `,
    "type.destructure_non_multi",
  );
});

Deno.test("pipe bind syntax lowers through scoped bind bodies", async () => {
  const wat = await watFromSource(
    `
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(a: i32, b: i32) -> i32 { a + b }
    fn mul(a: i32, b: i32) -> i32 { a * b }
    pub fn main() -> i32 {
      1 \\x -> inc(x) \\y -> add(1, y) \\z -> mul(z, 2)
    }
  `,
    { optMode: "release" },
  );
  assert(!wat.includes("call $inc"));
  assert(!wat.includes("call $add"));
  assert(!wat.includes("call $mul"));
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(a: i32, b: i32) -> i32 { a + b }
    fn mul(a: i32, b: i32) -> i32 { a * b }
    pub fn main() -> i32 {
      1 \\x -> inc(x) \\y -> add(1, y) \\z -> mul(z, 2)
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 6);
  await assertThrowsCompile(
    `
    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 { 1 \\$ -> inc($) }
  `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    "pub fn main() -> i32 { \\x -> x + 1 }",
    "const.const_fn_context",
  );
  await assertThrowsCompile(
    `
    fn add(a: i32, b: i32) -> i32 { a + b }
    pub fn main() -> i32 { 1 |> add(1) }
  `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
    fn add(a: i32, b: i32) -> i32 { a + b }
    pub fn main() -> i32 { 1 |> add($, $) }
  `,
    "parse.syntax",
  );
});

Deno.test("pipe bind evaluates left once and binds flattened products", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
    type fn Pair() { let Pair = {left: i32, right: i32}; struct(Pair) }
    fn make_pair(x: i32) -> Pair { Pair {left: x, right: x + 1} }
    pub fn main() -> i32 {
      make_pair(4) \\p -> p.left + p.right
    }
  `),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 9);
});

Deno.test("const function literals specialize const fn parameters", async () => {
  const wat = await watFromSource(
    `
    type fn Lane4I32() { let Lane4I32 = {4*i32}; struct(Lane4I32) }
    fn map4_i32(const f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
      [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
    }
    pub fn main() -> Lane4I32 { map4_i32(\\x -> x + 1, [1, 2, 3, 4]) }
  `,
    { optMode: "release" },
  );
  assert(!wat.includes("(func $__const_fn"));
  assert(!wat.includes("call $__const_fn"));
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Lane4I32() { let Lane4I32 = {4*i32}; struct(Lane4I32) }
    fn map4_i32(const f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
      [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
    }
    fn fold4_i32(const f: fn(acc: i32, x: i32) -> i32, init: i32, xs: Lane4I32) -> i32 {
      f(f(f(f(init, xs[0]), xs[1]), xs[2]), xs[3])
    }
    pub fn main() -> i32 {
      let mapped = map4_i32(\\x -> { let y = x + 1; y }, [1, 2, 3, 4]);
      fold4_i32(\\(acc, x) -> acc + x, 0, mapped)
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 14);
  await assertThrowsCompile(
    "pub fn main() -> i32 { \\x -> x + 1 }",
    "const.const_fn_context",
  );
  await assertThrowsCompile(
    `
    type fn Lane4I32() { let Lane4I32 = {4*i32}; struct(Lane4I32) }
    fn map4_i32(const f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
      [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
    }
    pub fn main() -> Lane4I32 {
      let bump = 1;
      map4_i32(\\x -> x + bump, [1, 2, 3, 4])
    }
  `,
    "const.const_fn_capture",
  );
  await assertFirstDiagnosticSpanIncludes(
    `
    type fn Lane4I32() { let Lane4I32 = {4*i32}; struct(Lane4I32) }
    fn map4_i32(const f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
      [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
    }
    pub fn main() -> Lane4I32 {
      let x = 1;
      map4_i32(\\y -> x + y, [1, 2, 3, 4])
    }
  `,
    "const.const_fn_capture",
    "x + y",
  );
  await assertFirstDiagnosticSpanIncludes(
    `
    fn needs_type(const value: type) -> i32 { 0 }
    pub fn main() -> i32 { needs_type(\\x -> x + 1) }
  `,
    "const.const_fn_expected_fn",
    "x + 1",
  );
  await assertFirstDiagnosticSpanIncludes(
    `
    type fn Lane4I32() { let Lane4I32 = {4*i32}; struct(Lane4I32) }
    fn map4_i32(const f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
      [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
    }
    pub fn main() -> Lane4I32 { map4_i32(\\(x, y) -> x + y, [1, 2, 3, 4]) }
  `,
    "const.const_fn_arity",
    "x + y",
  );
  await assertThrowsCompile(
    `
    type fn Lane4I32() { let Lane4I32 = {4*i32}; struct(Lane4I32) }
    fn map4_i32(const f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
      [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
    }
    pub fn main() -> Lane4I32 { map4_i32($ + 1, [1, 2, 3, 4]) }
  `,
    "parse.syntax",
  );
});

Deno.test("runtime function values call top-level functions and closures", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Pair() { let Pair = {left: i32, right: i32}; struct(Pair) }

    fn inc(x: i32) -> i32 { x + 1 }
    fn apply(f: fn(x: i32) -> i32, x: i32) -> i32 { f(x) }

    pub fn main() -> i32 {
      let direct: fn(x: i32) -> i32 = inc;
      let offset = 5;
      let pair = Pair {left: 2, right: 3};
      direct(4) + apply(inc, 4) + apply(\\x -> x + offset, 4) +
        apply(\\x -> x + pair.left + pair.right, 4)
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 28);
});

Deno.test("runtime function values are rejected at wasm boundaries", async () => {
  await assertThrowsCompile(
    "pub fn main(f: fn(x: i32) -> i32) -> i32 { f(1) }",
    "function.closure_boundary",
  );
  await assertThrowsCompile(
    `
    const host = @external("host", fn(io: io, cb: fn(x: i32) -> i32) -> io(i32));
    pub fn main(io: io) -> io(i32) { host(io, \\x -> x + 1) }
  `,
    "function.closure_boundary",
  );
});

Deno.test("generic const fn callbacks preserve product runtime parameters", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
    fn over(
      root: root,
      const getter: fn(root: root) -> value,
      const setter: fn(root: root, value: value) -> root,
      const step: fn(value: value) -> value
    ) -> root {
      setter(root, step(getter(root)))
    }

    type fn Point() -> type { let Point = {x: i32, y: i32}; struct(Point) }
    fn point_x(root: Point) -> i32 { root.x }
    fn set_point_x(root: Point, value: i32) -> Point { Point {... root, x: value} }
    fn inc(value: i32) -> i32 { value + 1 }

    pub fn main() -> i32 {
      over(Point {x: 1, y: 2}, point_x, set_point_x, inc).x
    }
  `),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 2);
});

Deno.test("generic fold map with product accumulator and const callbacks lowers", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Pair() -> type { let Pair = {x: i32, y: i32}; struct(Pair) }

    fn fold_map(
      index: i32,
      limit: i32,
      acc: acc_t,
      const map_step: fn(index: i32) -> mapped_t,
      const reduce_step: fn(acc: acc_t, item: mapped_t) -> acc_t
    ) -> acc_t {
      match index < limit {
        true => fold_map(
          index + 1,
          limit,
          reduce_step(acc, map_step(index)),
          map_step,
          reduce_step
        ),
        false => acc,
      }
    }

    fn make_pair(index: i32) -> Pair { Pair {x: index + 1, y: 10} }
    fn append_pair(acc: Pair, item: Pair) -> Pair {
      Pair {x: acc.x + item.x, y: acc.y + item.y}
    }

    pub fn main() -> i32 {
      fold_map(0, 3, Pair {x: 0, y: 0}, make_pair, append_pair).x
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 6);
});

Deno.test("static product function slots lower to direct calls", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
    type fn Runner(a: type) -> type {
      let Runner = {run: fn(x: i32) -> a};
      struct(Runner)
    }
    fn add_one(x: i32) -> i32 { x + 1 }
    const runner: Runner(i32) = {run: add_one}
    pub fn main() -> i32 { runner.run(4) }
  `),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 5);
});

Deno.test("do monad lowers through generated capturing const functions", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Id(a: type) -> type { a }
    fn Id::pure(value: a) -> Id(a) { value }
    fn Id::bind(value: Id(a), const f: fn(x: a) -> Id(b)) -> Id(b) { f(value) }
    fn a() -> Id(i32) { 1 }
    fn b(x: i32) -> Id(i32) { x + 2 }
    pub fn main() -> Id(i32) {
      do @monad(Id(_)) {
        x <- a();
        let k = x + 1;
        y <- b(k);
        pure(x + y)
      }
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 5);
  await assertThrowsCompile(
    `
    type fn Id(a: type) -> type { a }
    fn Id::pure(value: a) -> Id(a) { value }
    pub fn main() -> Id(i32) {
      do @parser(Id) { 1 }
    }
  `,
    "do.unknown_strategy",
  );
  await assertThrowsCompile(
    `
    type fn Id(a: type) -> type { a }
    pub fn main() -> Id(i32) {
      do @monad(Id(_)) {
        x <- 1;
      }
    }
  `,
    "do.missing_final_expr",
  );
});

Deno.test("do monad expression statements lower like bind-right", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Id(a: type) -> type { a }
    fn Id::pure(value: a) -> Id(a) { value }
    fn Id::bind(value: Id(a), const f: fn(x: a) -> Id(b)) -> Id(b) { f(value) }
    fn action(seed: i32) -> Id(i32) { seed + 1 }
    pub fn main() -> Id(i32) {
      do @monad(Id(_)) {
        action(1);
        y <- action(2);
        pure(y)
      }
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 3);
});

Deno.test("do monad parameterized effect dispatches through outer type function", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn State(state: type, value: type) -> type { value }
    fn State::pure(value: a) -> State(state, a) { value }
    fn State::bind(
      value: State(state, a),
      const step: fn(value: a) -> State(state, b)
    ) -> State(state, b) {
      step(value)
    }
    fn action(seed: i32) -> State(i32, i32) { seed + 1 }
    pub fn main() -> State(i32, i32) {
      do @monad(State(i32, _)) {
        action(1);
        y <- action(2);
        pure(y)
      }
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 3);
});

Deno.test("do monad parameterized state threads in-scope state implicitly", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    const monad = @import("prelude.monad");
    fn add_two(x: i32) -> i32 { x + 2 }
    fn add_three(x: i32) -> i32 { x + 3 }
    fn run_state() -> monad.State(i32, i32) {
      do @monad(monad.State(i32, _)) {
        monad.State::modify(add_two);
        monad.State::modify(add_three);
        monad.State::get()
      }
    }
    pub fn main() -> i32 { monad.State::eval(run_state(), 10) }
  `,
        { optMode: "release", resolveModule: resolveProjectModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 15);
});

Deno.test("do monad parameterized effect threads matching effect state", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    const monad = @import("prelude.monad");
    type fn Context(world: type, input: type) -> type {
      let Context = {world: world, input: input};
      struct(Context)
    }
    fn add_two(systems: Context(i32, i32)) -> Context(i32, i32) {
      Context {world: systems.world + systems.input + 2, input: systems.input}
    }
    fn add_three(systems: Context(i32, i32)) -> Context(i32, i32) {
      Context {world: systems.world + systems.input + 3, input: systems.input}
    }
    fn run() -> monad.State(Context(i32, i32), Context(i32, i32)) {
      do @monad(monad.State(Context(i32, i32), _)) {
        monad.State::modify(add_two);
        monad.State::modify(add_three);
        monad.State::get()
      }
    }
    pub fn main() -> i32 {
      let systems = Context {world: 10, input: 4};
      let result: Context(i32, i32) = monad.State::eval(run(), systems);
      result.world
    }
  `,
        { optMode: "release", resolveModule: resolveProjectModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 23);
});

Deno.test("do monad specializes multiline parameterized effect continuations", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    const monad = @import("prelude.monad");
    type fn Context(world: type, input: type) -> type {
      let Context = {
        world: world,
        input: input
      };
      struct(Context)
    }
    type fn GameSystems() -> type { Context(i32, i32) }
    fn add(systems: GameSystems, amount: i32) -> GameSystems {
      Context {world: systems.world + systems.input + amount, input: systems.input}
    }
    fn add_two(systems: GameSystems) -> GameSystems { add(systems, 2) }
    fn add_three(systems: GameSystems) -> GameSystems { add(systems, 3) }
    fn run() -> monad.State(GameSystems, GameSystems) {
      do @monad(monad.State(GameSystems, _)) {
        monad.State::modify(add_two);
        monad.State::modify(add_three);
        monad.State::get()
      }
    }
    pub fn main() -> i32 {
      let systems = Context {world: 10, input: 4};
      let result: GameSystems = monad.State::eval(run(), systems);
      result.world
    }
  `,
        { optMode: "release", resolveModule: resolveProjectModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 23);
});

Deno.test("@carrier is rejected as an unknown static builtin", async () => {
  await assertThrowsCompile(
    `
    type fn State(state: type, value: type) -> type {
      @carrier({state: state});
      value
    }
    pub fn main() -> State(i32, i32) { 0 }
  `,
    "type.unknown_static_builtin",
  );
});

Deno.test("do monad requires strategy evidence members", async () => {
  await assertThrowsCompile(
    `
    type fn Broken(a: type) -> type { a }
    fn Broken::bind(value: Broken(a), const f: fn(x: a) -> Broken(b)) -> Broken(b) { f(value) }
    fn action() -> Broken(i32) { 1 }
    pub fn main() -> Broken(i32) {
      do @monad(Broken(_)) {
        x <- action();
        action()
      }
    }
  `,
    "do.missing_strategy_proof",
  );
});

Deno.test("do monad strategy requires explicit constructor arity", async () => {
  await assertThrowsCompile(
    `
    type fn State(state: type, value: type) -> type { value }
    fn State::pure(value: a) -> State(state, a) { value }
    fn State::bind(value: State(state, a), const f: fn(x: a) -> State(state, b)) -> State(state, b) { f(value) }
    type fn World() -> type { i32 }
    pub fn main() -> State(World, i32) {
      do @monad(State(World)) {
        pure(1)
      }
    }
  `,
    "do.strategy_arity",
  );
  await assertThrowsCompile(
    `
    type fn Option(a: type) -> type { a }
    fn Option::pure(value: a) -> Option(a) { value }
    fn Option::bind(value: Option(a), const f: fn(x: a) -> Option(b)) -> Option(b) { f(value) }
    pub fn main() -> Option(i32) {
      do @monad(Option) { pure(1) }
    }
  `,
    "do.strategy_type",
  );
  await assertThrowsCompile(
    `
    type fn Box(a: type) -> type { a }
    fn Box::pure(value: a) -> Box(a) { value }
    fn Box::bind(value: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) { f(value) }
    pub fn main() -> Box(i32) {
      do @monad(Box) { pure(1) }
    }
  `,
    "do.strategy_type",
  );
  await assertThrowsCompile(
    `
    type fn Box(a: type) -> type { a }
    fn Box::pure(value: a) -> Box(a) { value }
    fn Box::bind(value: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) { f(value) }
    pub fn main() -> Box(i32) {
      do @monad(_) { pure(1) }
    }
  `,
    "do.strategy_type",
  );
  await assertThrowsCompile(
    `
    type fn State(state: type, value: type) -> type { value }
    fn State::pure(value: a) -> State(state, a) { value }
    fn State::bind(value: State(state, a), const f: fn(x: a) -> State(state, b)) -> State(state, b) { f(value) }
    fn bump(state: i32) -> State(i32, i32) { state + 1 }
    fn main(state: i32) -> State(i32, i32) {
      do @monad(State(_, _)) {
        bump();
      }
    }
  `,
    "do.state_type_hole",
  );
});

Deno.test("type holes are rejected outside do strategy arguments", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
      pub fn main() -> i32 {
        let x: _ = 1;
        let y: _ = x + 2;
        y
      }
    `),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 3);

  await assertThrowsCompile(
    `
    fn main(x: _) -> i32 { 1 }
  `,
    "type.hole_context",
  );
  await assertThrowsCompile(
    `
    type fn Bad() -> type { _ }
    fn main() -> i32 { 1 }
  `,
    "type.hole_context",
  );
});

Deno.test("inferred type holes resolve in expression-backed annotations", async () => {
  const checked = await checkSource(`
    type fn Box(a: type) -> struct { let Box = {value: a}; struct(Box) }
    pub fn main() -> _ { 1 }
    fn boxed() -> Box(_) { Box {value: 1} }
    let top: _ = 1;
    let nested: Box(_) = Box {value: 2};
  `);
  assertEquals(findFn(checked.program, "main")?.returnType, "i32");
  assertEquals(findFn(checked.program, "boxed")?.returnType, "Box(i32)");
  const top = checked.program.declarations.find((decl) =>
    decl.kind === "let" && decl.name === "top"
  );
  const nested = checked.program.declarations.find((decl) =>
    decl.kind === "let" && decl.name === "nested"
  );
  assertEquals(top?.kind === "let" ? top.type : undefined, "i32");
  assertEquals(nested?.kind === "let" ? nested.type : undefined, "Box(i32)");
});

Deno.test("inferred type holes reject unsupported and ambiguous annotations", async () => {
  await assertThrowsCompile("fn f(x: _) -> i32 { x }", "type.hole_context");
  await assertThrowsCompile(
    `
    fn choose() -> a { @empty(a) }
    pub fn main() -> _ { choose() }
  `,
    "type.inferred_type_ambiguous",
  );
  await assertThrowsCompile(
    `
    type fn Box(a: type) -> struct { let Box = {value: a}; struct(Box) }
    type fn Other(a: type) -> struct { let Other = {value: a}; struct(Other) }
    pub fn main() -> Box(_) { Other {value: 1} }
  `,
    "type.literal_mismatch",
  );
});

Deno.test("do monad uses satisfies for inherited applicative proof", async () => {
  const valid = `
    const merge = @import("prelude.std");

    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }

    fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) { Box {value: f(v.value)} }
    fn Box::pure(value: a) -> Box(a) { Box {value} }
    fn Box::apply(v: Box(fn(x: a) -> b), x: Box(a)) -> Box(b) { Box {value: v.value(x.value)} }
    fn Box::bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) { f(v.value) }

    pub fn main() -> Box(i32) {
      do @monad(Box(_)) {
        x <- Box::pure(1);
        pure(2)
      }
    }
  `;
  await checkSource(valid, { resolveModule: resolveProjectModule });

  await assertThrowsCompile(
    valid.replace(
      "    fn Box::apply(v: Box(fn(x: a) -> b), x: Box(a)) -> Box(b) { Box {value: v.value(x.value)} }\n",
      "",
    ),
    "type.require",
    { resolveModule: resolveProjectModule },
  );
});

Deno.test("do applicative supports query-style bind then final expression", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Query(a: type) -> type { a }
    fn Query::pure(value: a) -> Query(a) { value }
    fn Query::map(const f: fn(x: a) -> b, value: Query(a)) -> Query(b) { f(value) }
    fn Query::apply(value: Query(fn(x: a) -> b), arg: Query(a)) -> Query(b) { value(arg) }
    fn each(query: i32) -> Query(i32) { query }
    pub fn main() -> i32 {
      do @applicative(Query(_)) {
        row <- each(4);
        pure(row + 1)
      }
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 5);
});

Deno.test("do applicative supports multiple independent binds with apply", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Query(a: type) -> type { a }
    fn Query::pure(value: a) -> Query(a) { value }
    fn Query::map(const f: fn(x: a) -> b, value: Query(a)) -> Query(b) { f(value) }
    fn Query::apply(value: Query(fn(x: a) -> b), arg: Query(a)) -> Query(b) { value(arg) }
    fn each(query: i32) -> Query(i32) { query }
    pub fn main() -> i32 {
      do @applicative(Query(_)) {
        let scale = 2;
        x <- each(4);
        y <- each(6);
        pure(x + y + scale)
      }
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 12);
});

Deno.test("do applicative rejects dependent action binds", async () => {
  const source = `
    type fn Query(a: type) -> type { a }
    fn Query::pure(value: a) -> Query(a) { value }
    fn Query::map(const f: fn(x: a) -> b, value: Query(a)) -> Query(b) { f(value) }
    fn Query::apply(value: Query(fn(x: a) -> b), arg: Query(a)) -> Query(b) { value(arg) }
    fn each(query: i32) -> Query(i32) { query }
    pub fn main() -> i32 {
      do @applicative(Query(_)) {
        x <- each(4);
        y <- each(x);
        pure(x + y)
      }
    }
  `;
  await assertThrowsCompile(source, "do.applicative_dependency");
});

Deno.test("do applicative rejects transitive dependent action binds", async () => {
  const source = `
    type fn Query(a: type) -> type { a }
    fn Query::pure(value: a) -> Query(a) { value }
    fn Query::map(const f: fn(x: a) -> b, value: Query(a)) -> Query(b) { f(value) }
    fn Query::apply(value: Query(fn(x: a) -> b), arg: Query(a)) -> Query(b) { value(arg) }
    fn each(query: i32) -> Query(i32) { query }
    pub fn main() -> i32 {
      do @applicative(Query(_)) {
        x <- each(4);
        let k = x + 1;
        y <- each(k);
        pure(x + y)
      }
    }
  `;
  await assertThrowsCompile(source, "do.applicative_dependency");
});

Deno.test("do applicative requires pure for dependent final values", async () => {
  const source = `
    type fn Query(a: type) -> type { a }
    fn Query::pure(value: a) -> Query(a) { value }
    fn Query::map(const f: fn(x: a) -> b, value: Query(a)) -> Query(b) { f(value) }
    fn Query::apply(value: Query(fn(x: a) -> b), arg: Query(a)) -> Query(b) { value(arg) }
    fn each(query: i32) -> Query(i32) { query }
    pub fn main() -> i32 {
      do @applicative(Query(_)) {
        x <- each(4);
        x + 1
      }
    }
  `;
  await assertThrowsCompile(source, "do.applicative_return");
});

Deno.test("do applicative requires apply evidence", async () => {
  const source = `
    type fn Query(a: type) -> type { a }
    fn Query::pure(value: a) -> Query(a) { value }
    fn Query::map(const f: fn(x: a) -> b, value: Query(a)) -> Query(b) { f(value) }
    fn each(query: i32) -> Query(i32) { query }
    pub fn main() -> i32 {
      do @applicative(Query(_)) {
        x <- each(4);
        pure(x)
      }
    }
  `;
  await assertThrowsCompile(source, "do.missing_strategy_proof");
});

Deno.test("anonymous record values infer structural product types", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Query(a: type) -> type { a }
    fn Query::pure(value: a) -> Query(a) { value }
    fn Query::map(const f: fn(x: a) -> b, value: Query(a)) -> Query(b) { f(value) }
    fn Query::apply(value: Query(fn(x: a) -> b), arg: Query(a)) -> Query(b) { value(arg) }
    fn each(value: i32) -> Query(i32) { value }
    type fn SlotsOk(row: type) -> type {
      let Slots = @type_slots(row);
      let HasX = @require(@shape_slot(Slots, #x) == i32, "anonymous row x slot");
      row
    }
    type fn Row() -> type {
      let Row = {x: i32};
      struct(Row)
    }
    fn take(row: SlotsOk(Row)) -> i32 {
      let empty = @empty(Row);
      row.x + empty.x
    }
    pub fn main() -> i32 {
      let q = do @applicative(Query(_)) {
        x <- each(7);
        pure({x})
      };
      take(q)
    }
  `,
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 7);
});

Deno.test("anonymous struct annotations support fields literals and returns", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    fn sum(row: struct({x: i32, y: i32})) -> i32 {
      row.x + row.y
    }
    fn make(x: i32) -> struct({x: i32, y: i32}) {
      {x, y: 5}
    }
    fn bump(row: struct({x: i32, y: i32})) -> struct({x: i32, y: i32}) {
      @replace_field(row, #x, row.x + 1)
    }
    pub fn main() -> i32 {
      let single: struct({x: i32}) = {x: 1};
      let row = bump(make(6));
      sum(row) + single.x
    }
  `,
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 13);
});

Deno.test("const label replace_field preserves untouched product fields in release", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Pair() -> type {
      let Pair = {x: i32, y: i32};
      struct(Pair)
    }
    fn set_field(const field: const, pair: Pair, value: i32) -> Pair {
      @replace_field(pair, field, value)
    }
    pub fn main() -> i32 {
      let pair = set_field(#x, Pair {x: 1, y: 2}, 5);
      pair.x + pair.y
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 7);
});

Deno.test("anonymous struct annotations work with type reflection and empty", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Check(row: type) -> type {
      let Slots = @type_slots(row);
      let HasX = @require(@shape_slot(Slots, #x) == i32, "x slot");
      let HasY = @require(@shape_slot(Slots, #y) == bool, "y slot");
      row
    }
    fn take(row: Check(struct({x: i32, y: bool}))) -> i32 {
      let empty: struct({x: i32, y: bool}) = @empty(struct({x: i32, y: bool}));
      match row.y, empty.y {
        true, false => row.x + empty.x,
        _, _ => 0,
      }
    }
    pub fn main() -> i32 {
      take({x: 9, y: true})
    }
  `,
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 9);
});

Deno.test("product result destructuring binds local result slots", async () => {
  const wat = await watFromSource(
    `
    type fn Pair() { let Pair = {first: i32, second: i32}; struct(Pair) }
    fn make_pair() -> Pair { [2, 3] }
    fn sink(x: i32) -> i32 { x }
    pub fn main() -> i32 {
      let x = 1;
      let used = sink(x);
      let first, second = make_pair();
      x + used + first + second
    }
  `,
    { optMode: "release" },
  );
  assert(!wat.includes("(func $make_pair (result i32) (result i32)"));
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Pair() { let Pair = {first: i32, second: i32}; struct(Pair) }
    fn make_pair() -> Pair { [2, 3] }
    fn sink(x: i32) -> i32 { x }
    pub fn main() -> i32 {
      let x = 1;
      let used = sink(x);
      let first, second = make_pair();
      x + used + first + second
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 7);
  await assertThrowsCompile(
    `
    pub fn make_one() -> i32 { 1 }
    pub fn main() -> i32 {
      let a, b = make_one();
      a
    }
  `,
    "type.destructure_non_multi",
  );
  await assertThrowsCompile(
    `
    type fn Pair() { let Pair = {first: i32, second: i32}; struct(Pair) }
    fn make_pair() -> Pair { [2, 3] }
    pub fn main() -> i32 {
      let a, b, c = make_pair();
      a
    }
  `,
    "type.destructure_arity",
  );
});

Deno.test("models type contracts with explicit const dictionaries", async () => {
  const parsed = await checkSource(`
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) }
    fn requires_product(t) -> bool { @type_is_product(t) }
    type fn Eq(t: type) {
      let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool};
      match requires_product(t) {
        true => struct(Eq),
        false => @compile_error("Eq requires a product type"),
      }
    }
    type fn Functor(f: type) {
      let Functor = {map: fn(x: f) -> f};
      match @type_has_slot(f, #value) {
        true => struct(Functor),
        false => @compile_error("Functor requires value slot"),
      }
    }
    type fn Applicative(f: type) {
      let Applicative = {pure: fn(x: i32) -> f, apply: fn(f: f, x: f) -> f};
      match @type_slot_type(f, #value) {
        i32 => struct(Applicative),
        _ => @compile_error("Applicative requires i32 value"),
      }
    }
    type fn Monad(f: type) {
      let Monad = {bind: fn(x: f) -> f};
      match @type_is_product(f) {
        true => struct(Monad),
        false => @compile_error("Monad requires product"),
      }
    }
    fn eql_point(a: Point, b: Point) -> bool { a.x == b.x }
    fn neq_point(a: Point, b: Point) -> bool { a.x != b.x }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    fn pure_box(x: i32) -> Box { {value: x} }
    fn apply_box(f: Box, x: Box) -> Box { {value: f.value + x.value} }
    fn bind_box(x: Box) -> Box { {value: x.value + 10} }
    const point_eq: Eq(Point) = {eql: eql_point, neq: neq_point};
    const box_functor: Functor(Box) = {map: map_box};
    const box_applicative: Applicative(Box) = {pure: pure_box, apply: apply_box};
    const box_monad: Monad(Box) = {bind: bind_box};
    fn same(dict: Eq(Point), a: Point, b: Point) -> i32 {
      match dict.eql(a, b) { true => 1, false => 0 }
    }
    fn mapped(dict: Functor(Box), x: Box) -> i32 { dict.map(x).value }
    fn applied(dict: Applicative(Box), x: i32) -> i32 { dict.apply(dict.pure(x), {value: 2}).value }
    fn bound(dict: Monad(Box), x: Box) -> i32 { dict.bind(x).value }
    pub fn main() -> i32 {
      same(point_eq, Point {x: 1, y: 2}, Point {x: 1, y: 2})
        + mapped(box_functor, {value: 1})
        + applied(box_applicative, 2)
        + bound(box_monad, {value: 3})
    }
  `);
  const eq = parsed.program.declarations.find((decl) => decl.kind === "type" && decl.name === "Eq");
  assertEquals(
    eq?.kind === "type" ? eq.normalized : undefined,
    {
      kind: "alias",
      type:
        'match requires_product(t) { true => struct(Eq), false => @compile_error("Eq requires a product type") }',
    },
  );
  await checkSource(`
    type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) }
    type fn HasSome(t: type) {
      let HasSome = {ok: i32};
      match @type_has_variant(t, #Some) == @type_variant_has_slot(t, #Some, #value) {
        true => struct(HasSome),
        false => @compile_error("expected Some value"),
      }
    }
    fn ok() -> i32 { 1 }
    const dict: HasSome(Option(i32)) = {ok: ok};
  `);
  await checkSource(`
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Eq(t: type) { let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool}; struct(Eq) }
    fn eql_point(a: Point, b: Point) -> bool { a.x == b.x }
    fn neq_point(a: Point, b: Point) -> bool { a.x != b.x }
    const point_eq: Eq(Point) = {eql: eql_point, neq: neq_point};
    pub fn main() -> i32 { same(1) }
  `);
  await assertThrowsCompile(
    "fn map_array(x: i32) -> i32 { x } const bad = {map: map_array};",
    "type.const_annotation",
  );
  await assertThrowsCompile(
    "fn map_array(x: i32) -> i32 { x } const bad: i32 = map_array;",
    "type.const_shape",
  );
  await assertThrowsCompile(
    `
    type fn Eq(t: type) { let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool}; struct(Eq) }
    const bad: Eq(Point) = {};
  `,
    "type.const_missing_slot",
  );
  await assertThrowsCompile(
    `
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Eq(t: type) { let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool}; struct(Eq) }
    fn eql_point(a: Point, b: Point) -> bool { a.x == b.x }
    fn neq_point(a: Point, b: Point) -> bool { a.x != b.x }
    const bad: Eq(Point) = {eql: eql_point, neq: neq_point, other: eql_point};
  `,
    "type.const_unknown_slot",
  );
  await assertThrowsCompile(
    `
    type fn Id() { i32 }
    fn map_array(x: i32) -> i32 { x }
    const bad: Id = {map: map_array};
  `,
    "type.const_dictionary_type",
  );
  await assertThrowsCompile(
    `
    fn map_array(x: i32) -> i32 { x }
    const bad: i32 = {map: map_array(1)};
  `,
    "type.const_slot_function",
  );
  await assertThrowsCompile(
    `
    const bad: i32 = {map: missing};
  `,
    "type.unknown_const_function",
  );
  await assertThrowsCompile(
    `
    fn map_array(x: i32) -> i32 { x }
    const bad: i32 = {map: map_array, map: map_array};
  `,
    "type.duplicate_const_slot",
  );
  await assertThrowsCompile(
    `
    type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) }
    type fn Eq(t: type) {
      let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool};
      match @type_is_product(t) {
        true => struct(Eq),
        false => @compile_error("Eq requires a product type"),
      }
    }
    fn eql_i32(a: i32, b: i32) -> bool { a == b }
    fn neq_i32(a: i32, b: i32) -> bool { a != b }
    const bad: Eq(Option(i32)) = {eql: eql_i32, neq: neq_i32};
  `,
    "type.compile_error",
  );
  await assertThrowsCompile(
    `
    type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) }
    type fn Eq(t: type) {
      let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool};
      match @type_is_product(t) {
        true => struct(Eq),
        false => @compile_error("Eq requires a product type"),
      }
    }
    fn Bad(dict: Eq(Option(i32))) -> i32 { 0 }
  `,
    "type.compile_error",
  );
  await assertThrowsCompile(
    `
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) {
      let Functor = {map: fn(x: f) -> f};
      match @type_slot_type(f, #missing) {
        i32 => struct(Functor),
        _ => struct(Functor),
      }
    }
    fn map_box(x: Box) -> Box { {value: x.value} }
    const bad: Functor(Point) = {map: map_box};
  `,
    "type.unknown_type_slot",
  );
});

Deno.test("models attached type members for static contracts", async () => {
  const checked = await checkSource(`
    fn eql_point(a: Point, b: Point) -> bool { a.x == b.x }
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    fn Point::eql(a: Point, b: Point) -> bool { eql_point(a, b) }
    type fn Eq(t: type) {
      let Expected = fn(a: t, b: t) -> bool;
      @require(@type_has_member(t, #eql), "Eq requires eql");
      @require(@type_member_type(t, #eql) == Expected, "Eq.eql has wrong type");
    }
    fn same(proof: Eq(Point), x: Point, y: Point) -> bool { Point::eql(x, y) }
  `);
  const point = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "Point"
  );
  assertEquals(point?.normalized?.kind === "product" ? point.normalized.shape.slots : undefined, [
    { label: "x", type: "i32" },
    { label: "y", type: "i32" },
  ]);
  const same = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "same"
  );
  assertEquals(same?.body.expr, {
    kind: "call",
    callee: { kind: "var", name: "Point::eql" },
    args: [{ kind: "var", name: "x" }, { kind: "var", name: "y" }],
  });
});

Deno.test("normalizes transparent contract annotations to runtime types", async () => {
  const checked = await checkSource(`
    type fn Box() -> type {
      let Box = {value: i32};
      struct(Box)
    }
    fn Box::eql(a: Box, b: Box) -> bool { a.value == b.value }
    type fn Eq(t: type) -> type {
      let Expected = fn(a: t, b: t) -> bool;
      @require(@type_has_member(t, #eql), "Eq requires eql");
      @require(@type_member_type(t, #eql) == Expected, "Eq.eql has wrong type");
      t
    }
    fn same(a: Eq(Box), b: Box) -> bool { Box::eql(a, b) }
    fn identity(value: Eq(Box)) -> Eq(Box) { value }
    pub fn main() -> i32 {
      let x: Eq(Box) = identity(Box {value: 1});
      match same(x, Box {value: 1}) { true => x.value, false => 0 }
    }
  `);
  const same = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "same"
  );
  assertEquals(same?.params[0]?.type, "Eq(Box)");

  const identity = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "identity"
  );
  assertEquals(identity?.params[0]?.type, "Eq(Box)");
  assertEquals(identity?.returnType, "Eq(Box)");

  const main = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "main"
  );
  assertEquals(main?.body.statements[0]?.kind === "let" ? main.body.statements[0].type : "", "Box");

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
        type fn Box() -> type {
          let Box = {value: i32};
          struct(Box)
        }
        fn Box::eql(a: Box, b: Box) -> bool { a.value == b.value }
        type fn Eq(t: type) -> type {
          let Expected = fn(a: t, b: t) -> bool;
          @require(@type_has_member(t, #eql), "Eq requires eql");
          @require(@type_member_type(t, #eql) == Expected, "Eq.eql has wrong type");
          t
        }
        fn same(a: Eq(Box), b: Box) -> bool { Box::eql(a, b) }
        fn identity(value: Eq(Box)) -> Eq(Box) { value }
        pub fn main() -> i32 {
          let x: Eq(Box) = identity(Box {value: 1});
          match same(x, Box {value: 1}) { true => x.value, false => 0 }
        }
      `),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 1);
});

Deno.test("transparent contract parameters infer generic member dispatch", async () => {
  const source = `
    type fn Box() -> type {
      let Box = {value: i32};
      struct(Box)
    }
    fn Box::append(a: Box, b: Box) -> Box {
      Box {value: a.value + b.value}
    }
    type fn Semigroup(t: type) -> type {
      let Expected = fn(a: t, b: t) -> t;
      @require(@type_has_member(t, #append), "Semigroup requires append");
      @require(@type_member_type(t, #append) == Expected, "Semigroup.append has wrong type");
      t
    }
    fn append(a: Semigroup(t), b: t) -> t {
      t::append(a, b)
    }
    pub fn main() -> i32 {
      let out = append(Box {value: 1}, Box {value: 2});
      out.value
    }
  `;
  const checked = await checkSource(source);
  const specialized = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("append__")
  );
  assertEquals(specialized?.params.map((param) => param.type), ["Box", "Box"]);
  assertEquals(specialized?.body.expr, {
    kind: "call",
    callee: { kind: "var", name: "Box::append" },
    args: [{ kind: "var", name: "a" }, { kind: "var", name: "b" }],
  });

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as () => number)(), 3);

  await assertThrowsCompile(
    `
      type fn Box() -> type {
        let Box = {value: i32};
        struct(Box)
      }
      fn Box::append(a: Box, b: Box) -> Box {
        Box {value: a.value + b.value}
      }
      fn bad(a: t, b: t) -> t {
        t::append(a, b)
      }
    `,
    "type.member_requires_proof",
  );
});

Deno.test("expected types specialize nullary generic constructors", async () => {
  const source = `
    type fn Option(a: type) -> type {
      let None = {};
      let Some = {value: a};
      union(None, Some)
    }
    fn Option::zero() -> Option(a) { 0 }
    fn Option::bind(value: Option(a), const f: fn(x: a) -> Option(b)) -> Option(b) {
      match value { Some(inner) => f(inner), None => Option::zero() }
    }
    fn to_option(x: i32) -> Option(i32) { x }
    pub fn main() -> i32 {
      let direct: Option(i32) = Option::zero();
      let bound = Option::bind(Option::zero(), to_option);
      match direct {
        None => match bound { None => 1, Some(value) => value },
        Some(value) => value,
      }
    }
  `;
  const checked = await checkSource(source);
  const zeroSpecializations = checked.program.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("Option__zero__")
  );
  assert(zeroSpecializations.some((decl) => decl.returnType === "Option(i32)"));

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as () => number)(), 0);

  await assertThrowsCompile(
    `
      type fn Option(a: type) -> type {
        let None = {};
        let Some = {value: a};
        union(None, Some)
      }
      fn Option::zero() -> Option(a) { 0 }
      pub fn main() -> i32 {
        let x = Option::zero();
        0
      }
    `,
    "type.inferred_type_ambiguous",
  );
});

Deno.test("reports attached type member contract failures", async () => {
  await assertThrowsCompile(
    `
      type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
      type fn Eq(t: type) {
        @require(@type_has_member(t, #eql), "Eq requires eql");
      }
      fn same(proof: Eq(Point)) -> bool { true }
    `,
    "type.require",
  );
  await assertThrowsCompile(
    `
      fn eql_point(a: Point) -> bool { true }
      type fn Point() { let Point = {x: i32}; struct(Point) }
      fn Point::eql(a: Point) -> bool { eql_point(a) }
      type fn Eq(t: type) {
        let Expected = fn(a: t, b: t) -> bool;
        @require(@type_member_type(t, #eql) == Expected, "Eq.eql has wrong type");
      }
      fn same(proof: Eq(Point)) -> bool { true }
    `,
    "type.require",
  );
});

Deno.test("reports compile-time contract failures on caller spans", async () => {
  await assertFirstDiagnosticSpanIncludes(
    `
      type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
      type fn Eq(t: type) {
        @require(@type_has_member(t, #eql), "Eq requires eql");
      }
      fn same(proof: Eq(Point)) -> bool { true }
    `,
    "type.require",
    "proof: Eq(Point)",
  );

  await assertFirstDiagnosticSpanIncludes(
    `
      type fn Empty(a: type) -> type {
        let Empty = {value: a};
        struct(Empty)
      }
      type fn Functor(t: type fn(a: type) -> type) -> type {
        @require(@type_has_member(t, #map), "Functor requires map");
        t
      }
      fn inc(x: i32) -> i32 { x + 1 }
      fn mapper(v: t(a), const f: fn(x: a) -> b) -> t(b) {
        const mapper = Functor(t);
        v
      }
      pub fn main() -> Empty(i32) { mapper(Empty {value: 1}, inc) }
    `,
    "type.require",
    "mapper(Empty {value: 1}, inc",
  );

  await assertFirstDiagnosticSpanIncludes(
    `
      type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) }
      type fn Eq(t: type) {
        match @type_is_product(t) {
          true => t,
          false => @compile_error("Eq requires product"),
        }
      }
      const bad: Eq(Option(i32)) = {};
    `,
    "type.compile_error",
    "const bad: Eq(Option(i32))",
  );
});

Deno.test("specializes functor constraints over type constructors", async () => {
  const parsed = await parse(`
    type fn Box(a: type) -> type { let Box = {value: a}; struct(Box) }
    fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }
  `);
  const parsedMap = parsed.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "Box::map"
  );
  assertEquals(parsedMap?.body.expr?.kind, "product_constructor");

  const checked = await checkSource(`
    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }
    fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }
    type fn Functor(t: type fn(a: type) -> type) -> type {
      let Expected = fn(const f: fn(x: a) -> b, v: t(a)) -> t(b);
      @require(@type_has_member(t, #map), "Functor requires map");
      @require(@type_member_type(t, #map) == Expected, "Functor.map has wrong type");
      t
    }
    fn inc(x: i32) -> i32 { x + 1 }
    fn mapper(v: t(a), const f: fn(x: a) -> b, const _proof: Functor(t)) -> t(b) {
      t::map(f, v)
    }
    pub fn main() -> Box(i32) { mapper(Box {value: 1}, inc, Functor(Box)) }
  `);
  const boxMap = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("Box__map__")
  );
  assertEquals(boxMap?.body.expr?.kind, "shape");
  const mapper = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("mapper__")
  );
  assertEquals(mapper?.params, [{ name: "v", type: "Box(i32)", const: undefined }]);
  assertEquals(mapper?.returnType, "Box(i32)");
  assertEquals(
    mapper?.body.expr?.kind === "call" ? mapper.body.expr.callee : undefined,
    { kind: "var", name: "Box__map__i32__i32__inc" },
  );

  await assertThrowsCompile(
    `
      type fn Empty(a: type) -> type { let Empty = {value: a}; struct(Empty) }
      type fn Functor(t: type fn(a: type) -> type) -> type {
        let Expected = fn(const f: fn(x: a) -> b, v: t(a)) -> t(b);
        @require(@type_has_member(t, #map), "Functor requires map");
        @require(@type_member_type(t, #map) == Expected, "Functor.map has wrong type");
        t
      }
      fn Bad(const _proof: Functor(Empty)) -> i32 { 0 }
    `,
    "type.require",
  );
  await assertThrowsCompile(
    `
      type fn BadBox(a: type) -> type {
        let BadBox = {value: a};
        struct(BadBox)
      }
      fn BadBox::map(v: BadBox(a)) -> BadBox(a) { v }
      type fn Functor(t: type fn(a: type) -> type) -> type {
        let Expected = fn(const f: fn(x: a) -> b, v: t(a)) -> t(b);
        @require(@type_has_member(t, #map), "Functor requires map");
        @require(@type_member_type(t, #map) == Expected, "Functor.map has wrong type");
        t
      }
      fn Bad(const _proof: Functor(BadBox)) -> i32 { 0 }
    `,
    "type.require",
  );
  await assertThrowsCompile(
    `
      type fn Concrete() { let Concrete = {value: i32}; struct(Concrete) }
      type fn Functor(t: type fn(a: type) -> type) -> type { t }
      fn Bad(const _proof: Functor(Concrete)) -> i32 { 0 }
    `,
    "type.param_kind",
  );
  await checkSource(`
    type fn Box(a: type) -> struct { let Box = {value: a}; struct(Box) }
    type fn Functor(t: type fn(a: type) -> struct) -> type { t }
    fn ok(const _proof: Functor(Box)) -> i32 { 0 }
  `);
  await checkSource(`
    type fn Box(a: type) -> struct { let Box = {value: a}; struct(Box) }
    type fn Broad(t: type fn(a: type) -> type) -> type { t }
    fn ok(const _proof: Broad(Box)) -> i32 { 0 }
  `);
  await assertThrowsCompile(
    `
      type fn Option(a: type) -> union { let None = {}; let Some = {value: a}; union(None, Some) }
      type fn Functor(t: type fn(a: type) -> struct) -> type { t }
      fn Bad(const _proof: Functor(Option)) -> i32 { 0 }
    `,
    "type.param_kind",
  );
});

Deno.test("attaches qualified type member functions", async () => {
  const checked = await checkSource(`
    type fn Box(a: type) -> type { let Box = {value: a}; struct(Box) }
    fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }
    type fn Functor(t: type fn(a: type) -> type) -> type {
      let Expected = fn(const f: fn(x: a) -> b, v: t(a)) -> t(b);
      @require(@type_has_member(t, #map), "Functor requires map");
      @require(@type_member_type(t, #map) == Expected, "Functor.map has wrong type");
      t
    }
    fn inc(x: i32) -> i32 { x + 1 }
    fn mapper(v: t(a), const f: fn(x: a) -> b, const _proof: Functor(t)) -> t(b) {
      t::map(f, v)
    }
    pub fn main() -> Box(i32) { mapper(Box {value: 1}, inc, Functor(Box)) }
  `);
  const box = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "Box"
  );
  assertEquals(
    box?.normalized?.kind === "product" ? box.normalized.members : undefined,
    [{ name: "map", type: "fn(const f: fn(x: a) -> b, v: Box(a)) -> Box(b)", target: "Box::map" }],
  );
  const mapper = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("mapper__")
  );
  assertEquals(
    mapper?.body.expr?.kind === "call" ? mapper.body.expr.callee : undefined,
    { kind: "var", name: "Box__map__i32__i32__inc" },
  );
  await assertThrowsCompile(
    `
      fn missing::map() -> i32 { 0 }
    `,
    "type.unknown_type",
  );
  await assertThrowsCompile(
    `
      type fn Box(a: type) -> type { let Box = {value: a}; struct(Box) }
      fn Box.map(v: Box(a)) -> Box(a) { v }
    `,
    "type.member_syntax",
  );
  await assertThrowsCompile(
    `
      type fn Box(a: type) -> type { let Box = {value: a}; struct(Box) }
      fn Box::map(v: Box(a)) -> Box(a) { v }
      fn Box::map(v: Box(a)) -> Box(a) { v }
    `,
    "type.duplicate_member",
  );
});

Deno.test("infers local proof consts at generic call sites", async () => {
  const checked = await checkSource(`
    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }
    fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }
    type fn Functor(t: type fn(a: type) -> type) -> type {
      let Expected = fn(const f: fn(x: a) -> b, v: t(a)) -> t(b);
      @require(@type_has_member(t, #map), "Functor requires map");
      @require(@type_member_type(t, #map) == Expected, "Functor.map has wrong type");
      t
    }
    fn inc(x: i32) -> i32 { x + 1 }
    fn mapper(v: t(a), const f: fn(x: a) -> b) -> t(b) {
      const mapper = Functor(t);
      mapper.map(f, v)
    }
    pub fn main() -> Box(i32) {
      mapper(Box {value: 1}, inc)
    }
  `);
  const mapper = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("mapper__")
  );
  assertEquals(mapper?.params, [{ name: "v", type: "Box(i32)", const: undefined }]);
  assertEquals(mapper?.returnType, "Box(i32)");
  assertEquals(mapper?.body.statements, []);
  assertEquals(
    mapper?.body.expr?.kind === "call" ? mapper.body.expr.callee : undefined,
    { kind: "var", name: "Box__map__i32__i32__inc" },
  );

  await assertThrowsCompile(
    `
      type fn Empty(a: type) -> type {
        let Empty = {value: a};
        struct(Empty)
      }
      type fn Functor(t: type fn(a: type) -> type) -> type {
        @require(@type_has_member(t, #map), "Functor requires map");
        t
      }
      fn inc(x: i32) -> i32 { x + 1 }
      fn mapper(v: t(a), const f: fn(x: a) -> b) -> t(b) {
        const mapper = Functor(t);
        v
      }
      pub fn main() -> Empty(i32) { mapper(Empty {value: 1}, inc) }
    `,
    "type.require",
  );

  await assertThrowsCompile(
    `
      type fn Box(a: type) -> type {
        let Box = {value: a};
        struct(Box)
      }
      fn Bad(v: t(a)) -> t(a) {
        const Mapper = t;
        v
      }
      pub fn main() -> Box(i32) { Bad(Box {value: 1}) }
    `,
    "parse.syntax",
  );
});

Deno.test("rejects duplicate type function fragments and members", async () => {
  await assertThrowsCompile(
    `
      type fn Box(a: type) -> type { let Box = {value: a}; struct(Box) }
      type fn Box(a: type) -> type { let Box = {other: a}; struct(Box) }
    `,
    "type.duplicate_runtime_fragment",
  );
  await assertThrowsCompile(
    `
      type fn Box(a: type) -> type {
        let Box = {value: a};
        struct(Box)
      }
      fn Box::map(v: Box(a)) -> Box(a) { v }
      fn Box::map(v: Box(a)) -> Box(a) { v }
    `,
    "type.duplicate_member",
  );
});

Deno.test("specializes const parameters at call sites", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box {
      let a = mapped(box_functor, {value: 1});
      mapped(box_functor, a)
    }
  `);
  const mapped = findFn(checked.program, "mapped");
  assertEquals(mapped?.kind === "fn" ? mapped.params[0].const : undefined, true);
  const specialized = checked.program.declarations.filter((decl) =>
    decl.kind === "fn" && decl.name === "mapped__box_functor"
  );
  assertEquals(specialized.length, 1);
  assertEquals(specialized[0].kind === "fn" ? specialized[0].params : undefined, [
    { name: "x", type: "Box", const: undefined },
  ]);
  assertEquals(
    specialized[0].kind === "fn" && specialized[0].body.expr?.kind === "call"
      ? specialized[0].body.expr.callee
      : undefined,
    { kind: "var", name: "map_box" },
  );
  const main = findFn(checked.program, "main");
  const expr = main?.kind === "fn" ? main.body.expr : undefined;
  assertEquals(expr?.kind, "call");
  assertEquals(expr?.kind === "call" ? expr.callee : undefined, {
    kind: "var",
    name: "mapped__box_functor",
  });

  await assertThrowsCompile(
    `
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    fn Bad(dict: Functor(Box), x: Box) -> Box { mapped(dict, x) }
  `,
    "const.static_param_arg",
  );
  await assertFirstDiagnosticSpanIncludes(
    `
    fn needs_type(const value: type, x: i32) -> i32 { x }
    fn Bad(runtime_dict: i32) -> i32 { needs_type(runtime_dict, 1) }
  `,
    "const.static_param_arg",
    "runtime_dict",
  );
});

Deno.test("infers unannotated const parameter static kinds", async () => {
  const checked = await checkSource(`
    type fn Transform2d() -> type { let Transform2d = {x: i32}; struct(Transform2d) }
    type fn ComponentValues(selected: const) -> type {
      let Values = @shape_map(selected, ComponentValue);
      struct(Values)
    }
    type fn ComponentValue(component: const) -> type { component }
    fn first_value(const selected, values: ComponentValues(selected)) -> i32 {
      values.transform.x
    }
    const movement_reads = {transform: Transform2d};
    pub fn main(values: ComponentValues(movement_reads)) -> i32 {
      first_value(movement_reads, values)
    }
  `);
  const source = findFn(checked.program, "first_value");
  assertEquals(source?.kind === "fn" ? source.params[0]?.inferStaticType : undefined, true);
  const specialized = checked.program.declarations.find((decl) =>
    decl.kind === "fn" && decl.name === "first_value__movement_reads"
  );
  assertEquals(specialized?.kind === "fn" ? specialized.params : undefined, [
    { name: "values", type: "ComponentValues(movement_reads)", const: undefined },
  ]);
});

Deno.test("infers leading static parameters from value arguments", async () => {
  const checked = await checkSource(`
    type fn Index(capacity: count) -> type {
      let Index = {value: i32};
      struct(Index)
    }
    type fn Batch(capacity: count, component: type) -> type {
      let Batch = {item: component};
      struct(Batch)
    }
    type fn World(capacity: count, entity: type) -> type {
      let World = {item: entity};
      struct(World)
    }
    type fn Actor() -> type {
      let Actor = {x: i32};
      struct(Actor)
    }
    type fn FrameInput() -> type {
      let FrameInput = {dt: i32};
      struct(FrameInput)
    }
    type fn GeometryBatch() -> type {
      let GeometryBatch = {count: i32};
      struct(GeometryBatch)
    }
    fn world_from_batch(
      const capacity: count,
      const entity: type,
      entities: Batch(capacity, entity)
    ) -> World(capacity, entity) {
      World {item: entities.item}
    }
    fn world_fold(
      const capacity: count,
      const entity: type,
      const accumulator: type,
      world: World(capacity, entity),
      initial: accumulator,
      const step: fn(acc: accumulator, item: entity) -> accumulator
    ) -> accumulator {
      step(initial, world.item)
    }
    fn world_map_with_state(
      const capacity: count,
      const entity: type,
      const result: type,
      const state: type,
      world: World(capacity, entity),
      state_value: state,
      const step: fn(
        index: Index(capacity),
        item: entity,
        state_value: state
      ) -> result
    ) -> World(capacity, result) {
      World {item: step(Index {value: 0}, world.item, state_value)}
    }
    fn seed_actors() -> Batch(3, Actor) {
      Batch {item: Actor {x: 1}}
    }
    fn seed_world() -> World(3, Actor) {
      world_from_batch(seed_actors())
    }
    fn empty_geometry() -> GeometryBatch {
      GeometryBatch {count: 0}
    }
    fn render_actor(acc: GeometryBatch, item: Actor) -> GeometryBatch {
      GeometryBatch {count: acc.count + item.x}
    }
    fn tick_actor(index: Index(3), item: Actor, input: FrameInput) -> Actor {
      Actor {x: item.x + input.dt + index.value}
    }
    pub fn main() -> GeometryBatch {
      let world = seed_world();
      let input = FrameInput {dt: 1};
      let updated = world_map_with_state(world, input, tick_actor);
      world_fold(updated, empty_geometry(), render_actor)
    }
  `);
  const fromBatch = findFn(checked.program, "world_from_batch__3__Actor");
  assertEquals(fromBatch?.kind === "fn" ? fromBatch.params : undefined, [
    { name: "entities", type: "Batch(3, Actor)", const: undefined },
  ]);
  const map = findFn(
    checked.program,
    "world_map_with_state__3__Actor__Actor__FrameInput__tick_actor",
  );
  assertEquals(map?.kind === "fn" ? map.params : undefined, [
    { name: "world", type: "World(3, Actor)", const: undefined },
    { name: "state_value", type: "FrameInput", const: undefined },
  ]);
  const fold = findFn(checked.program, "world_fold__3__Actor__GeometryBatch__render_actor");
  assertEquals(fold?.kind === "fn" ? fold.params : undefined, [
    { name: "world", type: "World(3, Actor)", const: undefined },
    { name: "initial", type: "GeometryBatch", const: undefined },
  ]);
});

Deno.test("unannotated const type proofs specialize as types", async () => {
  const checked = await checkSource(`
    fn keep(const t, value: t) -> t { value }
    pub fn main() -> i32 { keep(i32, 7) }
  `);
  const specialized = checked.program.declarations.find((decl) =>
    decl.kind === "fn" && decl.name.startsWith("keep__i32")
  );
  assertEquals(specialized?.kind === "fn" ? specialized.returnType : undefined, "i32");
  assertEquals(specialized?.kind === "fn" ? specialized.params[0]?.type : undefined, "i32");
});

Deno.test("canonicalizes refined i32 type proofs for specialization keys", async () => {
  const checked = await checkSource(`
    fn tagged(const t: type, x: i32) -> i32 { x }

    pub fn main() -> i32 {
      tagged(i32(0..4), 1) + tagged(i32(0..04), 2)
    }
  `);

  const generated = checked.program.declarations
    .filter((decl) => decl.kind === "fn" && decl.name.startsWith("tagged__"))
    .map((decl) => decl.name)
    .sort();
  assertEquals(generated, ["tagged__i32_0__4_"]);
});

Deno.test("infers type parameters through runtime arguments", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Events() { let Events = {delta: i32}; struct(Events) }
    fn bump(world: Box, events: Events) -> Box {
      {value: world.value + events.delta}
    }
    fn run(
      world: w,
      events: e,
      const system: fn(world: w, events: e) -> w
    ) -> w {
      system(world, events)
    }
    pub fn main() -> Box {
      let world = Box {value: 1};
      let events = Events {delta: 2};
      run(world, events, bump)
    }
  `);
  const specialized = checked.program.declarations.find((decl) =>
    decl.kind === "fn" && decl.name === "run__Box__Events__bump"
  );
  assertEquals(specialized?.kind === "fn" ? specialized.params : undefined, [
    { name: "world", type: "Box", const: undefined },
    { name: "events", type: "Events", const: undefined },
  ]);
});

Deno.test("memoizes distinct const parameter specializations", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    fn map_box_alt(x: Box) -> Box { {value: x.value + 2} }
    const box_functor: Functor(Box) = {map: map_box};
    const alt_functor: Functor(Box) = {map: map_box_alt};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box {
      let a = mapped(box_functor, {value: 1});
      mapped(alt_functor, a)
    }
  `);
  const generated = checked.program.declarations.filter((decl) =>
    decl.kind === "fn" && decl.name.startsWith("mapped__")
  ).map((decl) => decl.name).sort();
  assertEquals(generated, ["mapped__alt_functor", "mapped__box_functor"]);
});

Deno.test("names specializations with multiple const parameters", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    fn map_box_alt(x: Box) -> Box { {value: x.value + 2} }
    const box_functor: Functor(Box) = {map: map_box};
    const alt_functor: Functor(Box) = {map: map_box_alt};
    fn mapped_twice(const first: Functor(Box), const second: Functor(Box), x: Box) -> Box {
      second.map(first.map(x))
    }
    pub fn main() -> Box { mapped_twice(box_functor, alt_functor, {value: 1}) }
  `);
  const specialized = findFn(checked.program, "mapped_twice__box_functor__alt_functor");
  assertEquals(specialized?.kind === "fn" ? specialized.params : undefined, [
    { name: "x", type: "Box", const: undefined },
  ]);
  assert(specialized?.kind === "fn" && specialized.generated);
});

Deno.test("reuses nested const-specialized calls", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    fn mapped_outer(const dict: Functor(Box), x: Box) -> Box { mapped(dict, x) }
    pub fn main() -> Box {
      let a = mapped_outer(box_functor, {value: 1});
      mapped_outer(box_functor, a)
    }
  `);
  assertEquals(
    checked.program.declarations.filter((decl) =>
      decl.kind === "fn" && decl.name === "mapped_outer__box_functor"
    ).length,
    1,
  );
  assertEquals(
    checked.program.declarations.filter((decl) =>
      decl.kind === "fn" && decl.name === "mapped__box_functor"
    ).length,
    1,
  );
  const outer = findFn(checked.program, "mapped_outer__box_functor");
  assertEquals(
    outer?.kind === "fn" && outer.body.expr?.kind === "call" ? outer.body.expr.callee : undefined,
    { kind: "var", name: "mapped__box_functor" },
  );
});

Deno.test("optimizes const-parameter forwarding wrappers to direct calls", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box { mapped(box_functor, {value: 1}) }
  `);

  assertEquals(findFns(checked.program, "mapped__box_functor").length, 1);
  const checkedMain = findFn(checked.program, "main");
  assertEquals(
    checkedMain?.body.expr?.kind === "call" ? checkedMain.body.expr.callee : undefined,
    { kind: "var", name: "mapped__box_functor" },
  );

  const optimized = optimizeProgram(checked.program, { optMode: "release" });
  const counts = countCalls(optimized, { includeGenerated: false });
  assertEquals(counts.get("mapped__box_functor") ?? 0, 0);
  assertEquals(counts.get("map_box") ?? 0, 0);
});

Deno.test("lowers global const function slots to direct calls", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Runner() -> type {
      let Runner = {run: fn(x: i32) -> i32};
      struct(Runner)
    }
    fn add_one(x: i32) -> i32 { x + 1 }
    const runner: Runner = {run: add_one};
    pub fn main() -> i32 {
      runner.run(4)
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 5);
});

Deno.test("specialized const product aliases keep function slots callable", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
    type fn Runner() -> type {
      let Runner = {run: fn(x: i32) -> i32};
      struct(Runner)
    }
    fn add_one(x: i32) -> i32 { x + 1 }
    fn apply(const runner: Runner, x: i32) -> i32 {
      let alias = runner;
      alias.run(x)
    }
    const default_runner: Runner = {run: add_one};
    pub fn main() -> i32 {
      apply(default_runner, 4)
    }
  `,
        { optMode: "release" },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 5);
});

Deno.test("optimizer treats narrow unsigned returns as scalar", async () => {
  const checked = await checkSource(`
    fn dec(x: u3) -> u3 {
      x - 1
    }
    pub fn main(x: u3) -> u3 {
      dec(x)
    }
  `);
  const summary = summarizeProgram(checked.program, { optMode: "release" }).get("dec");
  assertEquals(summary?.returnClass, "scalar");
});

Deno.test("function summaries normalize transparent aliases without erasing products", async () => {
  const checked = await checkSource(`
    type fn Id(a: type) -> type { a }
    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }
    fn scalar_id(x: i32) -> Id(i32) {
      x
    }
    fn boxed(x: i32) -> Box(i32) {
      {value: x}
    }
    pub fn main(seed: i32) -> i32 {
      let box = boxed(seed);
      scalar_id(seed) + box.value
    }
  `);

  const summaries = summarizeProgram(checked.program, { optMode: "release" });
  assertEquals(summaries.get("scalar_id")?.returnClass, "scalar");
  assertEquals(summaries.get("scalar_id")?.slotCountEstimate, 1);
  assertEquals(summaries.get("boxed")?.returnClass, "flat_product");
  assertEquals(summaries.get("boxed")?.slotCountEstimate, 1);
});

Deno.test("optimizes repeated forwarding wrapper call sites", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box {
      let a = mapped(box_functor, {value: 1});
      let b = mapped(box_functor, a);
      mapped(box_functor, b)
    }
  `);

  assertEquals(findFns(checked.program, "mapped__box_functor").length, 1);
  const counts = countCalls(optimizeProgram(checked.program, { optMode: "release" }), {
    includeGenerated: false,
  });
  assertEquals(counts.get("mapped__box_functor") ?? 0, 0);
  assertEquals(counts.get("map_box") ?? 0, 0);
});

Deno.test("repeated const-param call specialization reuses one generated wrapper", async () => {
  const calls = 100;
  const steps = [
    "let v0: Box = {value: 0};",
    ...Array.from(
      { length: calls },
      (_, index) => `let v${index + 1} = mapped(box_functor, v${index});`,
    ),
    `v${calls}`,
  ].join("\n");
  const checked = await checkSource(
    `
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box { ${steps} }
  `,
    { trace: true },
  );

  assertEquals(findFns(checked.program, "mapped__box_functor").length, 1);
  const constPass = checked.trace?.phases.find((phase) =>
    phase.name === "specializeConstParamCalls #1"
  )?.specialization;
  assert(constPass);
  assertEquals(constPass.generatedSpecializations, 1);
  assertEquals(constPass.cacheMisses, 1);
  assert(constPass.cacheHits >= calls - 1);
  assert(constPass.visitedCalls >= calls);
});

Deno.test("long primitive addition chains are balanced after operator resolution", async () => {
  const source = `
    pub fn main() -> i32 {
      ${Array.from({ length: 32 }, () => "1").join(" +\n      ")}
    }
  `;
  const checked = await checkSource(source);
  const main = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "main"
  );
  assert(main?.body.expr);
  assert(maxBinaryDepth(main.body.expr, "+") <= 7);
});

Deno.test("long primitive boolean chains are balanced after operator resolution", async () => {
  const source = `
    pub fn main() -> bool {
      ${
    Array.from({ length: 32 }, (_, index) => index === 17 ? "false" : "true").join(" &&\n      ")
  }
    }
  `;
  const checked = await checkSource(source);
  const main = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "main"
  );
  assert(main?.body.expr);
  assert(maxBinaryDepth(main.body.expr, "&&") <= 7);
});

Deno.test("optimizes nested forwarding specializations transitively", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    fn mapped_outer(const dict: Functor(Box), x: Box) -> Box { mapped(dict, x) }
    pub fn main() -> Box { mapped_outer(box_functor, {value: 1}) }
  `);

  const counts = countCalls(optimizeProgram(checked.program, { optMode: "release" }), {
    includeGenerated: false,
  });
  assertEquals(counts.get("mapped_outer__box_functor") ?? 0, 0);
  assertEquals(counts.get("mapped__box_functor") ?? 0, 0);
  assertEquals(counts.get("map_box") ?? 0, 0);
});

Deno.test("inlines small product-return generated specializations at full-return sites", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box {
      let y = dict.map(x);
      dict.map(y)
    }
    pub fn main() -> Box { mapped(box_functor, {value: 1}) }
  `);

  const counts = countCalls(optimizeProgram(checked.program, { optMode: "release" }));
  assertEquals(counts.get("mapped__box_functor") ?? 0, 0);
});

Deno.test("optimizes specialization calls by resolved generated name", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped__box_functor(x: Box) -> Box { x }
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box { mapped(box_functor, {value: 1}) }
  `);

  assertEquals(findFns(checked.program, "mapped__box_functor").length, 1);
  assertEquals(findFns(checked.program, "mapped__box_functor__2").length, 1);
  const counts = countCalls(optimizeProgram(checked.program, { optMode: "release" }), {
    includeGenerated: false,
  });
  assertEquals(counts.get("mapped__box_functor__2") ?? 0, 0);
  assertEquals(counts.get("map_box") ?? 0, 0);
});

Deno.test("optimizes tiny private pure helpers by inlining", async () => {
  const checked = await checkSource(`
    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 { inc(41) }
  `);
  const counts = countCalls(optimizeProgram(checked.program, { optMode: "release" }), {
    includeGenerated: false,
  });
  assertEquals(counts.get("inc") ?? 0, 0);
});

Deno.test("function summaries classify purity calls returns and param effects", async () => {
  const checked = await checkSource(`
    const clock = @external("clock", fn(host: io) -> io(i32));
    fn score(x: i32) -> i32 { x + 1 }
    fn id(x: i32) -> i32 { x }
    fn cached(x: i32) -> i32 { x }
    fn update(x: i32) -> i32 { x }
    fn current() -> i32 { 1 }
    fn tick(host: io) -> i32 { clock(host) }
    pub fn main(host: io) -> i32 { score(id(1)) + tick(host) * 0 }
  `);

  const summaries = summarizeProgram(checked.program);
  assertEquals(summaries.get("score")?.returnClass, "scalar");
  assertEquals(summaries.get("score")?.callCount, 1);
  assertEquals(summaries.get("score")?.paramEffects.get("x"), "consume");
  assertEquals(summaries.get("score")?.effectClass, "pure");
  assertEquals(summaries.get("score")?.allocationBehavior, "none");
  assertEquals(summaries.get("score")?.stackBehavior, "none");
  assertEquals(summaries.get("score")?.runtimeInstructionEstimate, summaries.get("score")?.astCost);
  assertEquals(summaries.get("id")?.paramEffects.get("x"), "alias_return");
  assertEquals(summaries.get("cached")?.effectClass, "pure");
  assertEquals(summaries.get("update")?.effectClass, "pure");
  assertEquals(summaries.get("current")?.effectClass, "pure");
  assertEquals(summaries.get("tick")?.effectClass, "host");
  assertEquals(summaries.get("clock")?.effectClass, "host");
});

Deno.test("abstract value summaries track constants domains booleans and products", async () => {
  const checked = await checkSource(`
    fn domain_next(x: i32(0..4)) -> i32(1..5) {
      let y = x + 1;
      y
    }
    fn proven_bool(i: i32(0..4)) -> bool {
      i < 4
    }
    fn product_field(i: i32(0..4)) -> i32(1..5) {
      let box = {value: i + 1, flag: true};
      box.value
    }
    pub fn main(i: i32(0..4)) -> i32 {
      product_field(i)
    }
  `);

  const facts = summarizeAbstractValues(checked.program);
  assertEquals(facts.get("domain_next")?.params.get("x")?.kind, "i32_domain");
  assertEquals(
    facts.get("domain_next")?.locals.get("y"),
    facts.get("domain_next")?.returnValue,
  );
  const domainReturn = facts.get("domain_next")?.returnValue;
  assertEquals(domainReturn?.kind === "i32_domain" ? domainReturn.type : undefined, "i32(1..5)");
  assertEquals(facts.get("proven_bool")?.returnValue, {
    kind: "constant",
    literalKind: "bool",
    value: "true",
  });
  assertEquals(
    facts.get("product_field")?.locals.get("box")?.kind,
    "product",
  );
  const productReturn = facts.get("product_field")?.returnValue;
  assertEquals(productReturn?.kind === "i32_domain" ? productReturn.type : undefined, "i32(1..5)");
});

Deno.test("abstract value summaries represent unreachable matches", async () => {
  const program = await parse(`
    fn impossible() -> i32 {
      match true { false => 1 }
    }
  `);

  assertEquals(summarizeAbstractValues(program).get("impossible")?.returnValue, {
    kind: "unreachable",
  });
});

Deno.test("optimizer folds matches proven by abstract refined-domain facts", async () => {
  const checked = await checkSource(`
    fn always(i: i32(0..4)) -> i32 {
      match i < 4 { true => 10, false => 20 }
    }
    fn with_local(i: i32(0..4)) -> i32 {
      let ok = i < 4;
      match ok { true => 1, false => 2 }
    }
    pub fn main(i: i32(0..4)) -> i32 {
      always(i) + with_local(i)
    }
  `);

  const optimized = optimizeProgram(checked.program, { optMode: "release" });
  const always = findFn(optimized, "always");
  assertEquals(always?.kind === "fn" ? always.body.expr : undefined, {
    kind: "literal",
    literalKind: "number",
    value: "10",
  });
  const withLocal = findFn(optimized, "with_local");
  assertEquals(withLocal?.kind === "fn" ? withLocal.body.statements.length : undefined, 0);
  assertEquals(withLocal?.kind === "fn" ? withLocal.body.expr : undefined, {
    kind: "literal",
    literalKind: "number",
    value: "1",
  });
});

Deno.test("optimization plan records structural inline recurrence and domain decisions", async () => {
  const checked = await checkSource(`
    const clock = @external("clock", fn(host: io) -> io(i32));
    fn inc(x: i32) -> i32 { x + 1 }
    fn tick(host: io) -> i32 { clock(host) }
    fn small(i: i32(4), acc: i32) -> i32 { acc }
    fn small(i: i32(0..4), acc: i32) -> i32 { small(i + 1, acc + i) }
    fn always(i: i32(0..4)) -> i32 {
      match i < 4 { true => inc(i), false => 0 }
    }
    pub fn main(host: io, i: i32(0..4)) -> i32 { always(i) + small(0, 0) + tick(host) * 0 }
  `);

  const plan = summarizeOptimizationPlan(checked.program, { optMode: "release" });
  const hasDecision = (target: string, action: string) =>
    plan.decisions.some((decision) => decision.target === target && decision.action === action);

  assertEquals(plan.profile, "release_balanced");
  assert(hasDecision("inc", "call.inline.private_scalar"));
  assert(hasDecision("tick", "call.inline.skip_effectful"));
  assert(hasDecision("small", "recurrence.unfold.finite_static"));
  assert(hasDecision("always", "domain.compare.always_true"));
});

Deno.test("optimization plan lowers large refined finite recursion structurally", async () => {
  const checked = await checkSource(`
    fn sum_go(i: i32(1000), acc: i32) -> i32 {
      acc
    }
    fn sum_go(i: i32(0..1000), acc: i32) -> i32 {
      sum_go(i + 1, acc + i)
    }
    pub fn main() -> i32 {
      sum_go(0, 0)
    }
  `);

  const plan = summarizeOptimizationPlan(checked.program, { optMode: "release" });
  assert(
    plan.decisions.some((decision) =>
      decision.target === "sum_go" && decision.action === "recurrence.lower.tail_loop"
    ),
  );
});

Deno.test("optimization plan records tail-exposure helper inlining", async () => {
  const checked = await checkSource(`
    fn sum_continue(n: i32, acc: i32) -> i32 {
      match n == 0 {
        true => acc,
        false => sum(n - 1, acc + n + 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8)
      }
    }
    fn sum(n: i32, acc: i32) -> i32 {
      sum_continue(n, acc)
    }
    pub fn main() -> i32 { sum(4, 0) }
  `);

  const plan = summarizeOptimizationPlan(checked.program, { optMode: "release" });
  assert(
    plan.decisions.some((decision) =>
      decision.target === "sum_continue" &&
      decision.action === "call.inline.tail_exposure" &&
      decision.evidence?.caller === "sum"
    ),
  );
});

Deno.test("optimization plan recurrence and inline actions match release WAT shape", async () => {
  const source = `
    fn inc(x: i32) -> i32 { x + 1 }
    fn small(i: i32(4), acc: i32) -> i32 { acc }
    fn small(i: i32(0..4), acc: i32) -> i32 { small(i + 1, acc + i) }
    fn sum_go(i: i32(1000), acc: i32) -> i32 { acc }
    fn sum_go(i: i32(0..1000), acc: i32) -> i32 { sum_go(i + 1, acc + i) }
    pub fn main() -> i32 { inc(1) + small(0, 0) + sum_go(0, 0) }
  `;
  const plan = await explainOptimization(source, { optMode: "release" });
  const hasDecision = (target: string, action: string) =>
    plan.decisions.some((decision) => decision.target === target && decision.action === action);

  assert(hasDecision("inc", "call.inline.private_scalar"));
  assert(hasDecision("small", "recurrence.unfold.finite_static"));
  assert(hasDecision("sum_go", "recurrence.lower.tail_loop"));

  const { wat } = await compileArtifactsFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "loop");
  assert(!wat.includes("call $inc"));
  assert(!wat.includes("call $small"));
  assert(!wat.includes("call $sum_go"));
});

Deno.test("optimization plan domain branch action matches release WAT shape", async () => {
  const source = `
    fn inc(x: i32) -> i32 { x + 1 }
    fn always(i: i32(0..4)) -> i32 {
      match i < 4 { true => inc(i), false => 0 }
    }
    pub fn main(i: i32(0..4)) -> i32 { always(i) }
  `;
  const plan = await explainOptimization(source, { optMode: "release" });
  assert(
    plan.decisions.some((decision) =>
      decision.target === "always" && decision.action === "domain.compare.always_true"
    ),
  );

  const { wat } = await compileArtifactsFromSource(source, { optMode: "release" });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("if"));
  assert(!main.includes("i32.const 0"));
  assert(!main.includes("call $inc"));
});

Deno.test("optimization plan domain false branch action matches release WAT shape", async () => {
  const source = `
    fn inc(x: i32) -> i32 { x + 1 }
    fn never(i: i32(0..4)) -> i32 {
      match i > 5 { true => inc(i), false => 0 }
    }
    pub fn main(i: i32(0..4)) -> i32 { never(i) }
  `;
  const plan = await explainOptimization(source, { optMode: "release" });
  assert(
    plan.decisions.some((decision) =>
      decision.target === "never" && decision.action === "domain.compare.always_false"
    ),
  );

  const { wat } = await compileArtifactsFromSource(source, { optMode: "release" });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("if"));
  assert(!main.includes("i32.gt_s"));
  assert(!main.includes("call $inc"));
});

Deno.test("explainOptimization reports backend structural fixed-array layout decisions", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn read(xs: layout.InlineArray(4, u3), index: i32) -> i32 {
      xs[index]
    }
    fn bump_read(xs: layout.InlineArray(4, u3), index: i32) -> i32 {
      read(layout.InlineArray::set(4, u3, xs, index, 7), index)
    }
    pub fn main(index: i32) -> i32 {
      bump_read(#[1, 2, 3, 4], index)
    }
  `;

  const plan = await explainOptimization(source, { resolveModule: resolveProjectModule });
  assert(
    plan.decisions.some((decision) =>
      decision.target === "read.xs" && decision.action === "array.layout_packed"
    ),
  );
});

Deno.test("explainOptimization reports packed local-slot and scratch fixed-array layouts", async () => {
  const packedSource = `
    const layout = @import("prelude.layout");
    fn read(xs: layout.InlineArray(4, u3), index: i32) -> i32 {
      xs[index]
    }
    fn bump_read(xs: layout.InlineArray(4, u3), index: i32) -> i32 {
      read(layout.InlineArray::set(4, u3, xs, index, 7), index)
    }
    pub fn main(index: i32) -> i32 {
      bump_read(#[1, 2, 3, 4], index)
    }
  `;
  const localSlotSource = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn loop(i: i32, xs: InlineArray(4, i32)) -> InlineArray(4, i32) {
      match i < 4 {
        true => loop(i + 1, [...xs, [i]: i]),
        false => xs,
      }
    }
    pub fn main() -> i32 {
      let out = loop(0, #[0, 0, 0, 0]);
      out[0]
    }
  `;
  const scratchSource = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn loop(i: i32, xs: InlineArray(32, i32)) -> InlineArray(32, i32) {
      match i < 32 {
        true => loop(i + 1, [...xs, [i]: i]),
        false => xs,
      }
    }
    pub fn main(i: i32) -> i32 {
      let out = loop(0, #[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      out[i]
    }
  `;

  const packed = await explainOptimization(packedSource, { resolveModule: resolveProjectModule });
  const localSlot = await explainOptimization(localSlotSource, { optMode: "release" });
  const scratch = await explainOptimization(scratchSource, { optMode: "release" });

  assert(packed.decisions.some((decision) => decision.action === "array.layout_packed"));
  assert(localSlot.decisions.some((decision) => decision.action === "array.layout_local_slots"));
  assert(scratch.decisions.some((decision) => decision.action === "array.layout_scratch"));

  const { wat: localWat } = await compileArtifactsFromSource(localSlotSource, {
    optMode: "release",
  });
  const { wat: scratchWat } = await compileArtifactsFromSource(scratchSource, {
    optMode: "release",
  });
  assert(!localWat.includes("fig_buffers"));
  assertStringIncludes(scratchWat, "(memory $fig_buffers");
});

Deno.test("prelude and user tail folds get the same structural optimization decision", async () => {
  const preludeSource = `
    const range = @import("prelude.range");
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    pub fn main(seed: i32) -> i32 {
      range.RangeIter::fold(range.RangeI32::Iter(seed - seed .. 1000), 0, add)
    }
  `;
  const userSource = `
    type fn Iter() {
      let Iter = {start: i32, end: i32};
      struct(Iter)
    }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    fn make_iter(start: i32, end: i32) -> Iter {
      Iter {start: start, end: end}
    }
    fn fold(iter: Iter, init: i32) -> i32 {
      my_fold_loop(iter.start, iter.end, init)
    }
    fn my_fold_loop(i: i32, end: i32, acc: i32) -> i32 {
      match i < end {
        true => my_fold_loop(i + 1, end, add(acc, i)),
        false => acc,
      }
    }
    pub fn main(seed: i32) -> i32 {
      fold(make_iter(seed - seed, 1000), 0)
    }
  `;

  const preludeChecked = await checkSource(preludeSource, {
    resolveModule: resolveProjectModule,
    pruneImports: true,
  });
  const userChecked = await checkSource(userSource);
  const preludePlan = summarizeOptimizationPlan(preludeChecked.program, { optMode: "release" });
  const userPlan = summarizeOptimizationPlan(userChecked.program, { optMode: "release" });

  assert(
    preludePlan.decisions.some((decision) =>
      decision.target.includes("RangeIter") && decision.target.includes("fold_loop") &&
      decision.action === "recurrence.lower.tail_loop"
    ),
  );
  assert(
    userPlan.decisions.some((decision) =>
      decision.target === "my_fold_loop" && decision.action === "recurrence.lower.tail_loop"
    ),
  );

  const preludeWat = await watFromSource(preludeSource, {
    resolveModule: resolveProjectModule,
    pruneImports: true,
    optMode: "release",
  });
  const userWat = await watFromSource(userSource, { optMode: "release" });
  assertStringIncludes(preludeWat, "loop");
  assertStringIncludes(userWat, "loop");
  assert(!preludeWat.includes("call $range.RangeIter::fold_loop"));
  assert(!userWat.includes("call $make_iter"));
  assert(!userWat.includes("call $fold"));
  assert(!userWat.includes("call $my_fold_loop"));
});

Deno.test("release optimizer lowers generated tail recurrences before finite expansion", async () => {
  const compileTrace: CompileTraceEvent[] = [];
  const source = `
    const range = @import("prelude.range");
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    pub fn main(seed: i32) -> i32 {
      range.RangeIter::fold(range.RangeI32::Iter(seed - seed .. 1000), 0, add)
    }
  `;

  const artifact = await compileArtifactsFromSource(source, {
    resolveModule: resolveProjectModule,
    pruneImports: true,
    optMode: "release",
    compileTrace,
  });
  const lowerIndex = compileTrace.findIndex((event) =>
    event.name === "opt.lowerTailRecurrenceClauseGroups"
  );
  const expandIndex = compileTrace.findIndex((event) =>
    event.name === "opt.expandFiniteStaticRecurrences.initial"
  );
  const expand = compileTrace[expandIndex];
  const optimizeDecls = compileTrace.find((event) => event.name === "opt.pass.0.optimizeDecls");

  assert(lowerIndex >= 0);
  assert(expandIndex >= 0);
  assert(lowerIndex < expandIndex);
  assertEquals(expand?.counters?.changedFunctions, 0);
  assertEquals(optimizeDecls?.counters?.optimizedFunctions, 5);
  assertStringIncludes(artifact.wat, "loop");
  assert(!artifact.wat.includes("call $range.RangeIter::fold_loop"));
});

Deno.test("optimizer scope traces only reachable imported runtime helpers", async () => {
  const compileTrace: CompileTraceEvent[] = [];
  const source = `
    const lib = @import("fixture.lib");
    pub fn main() -> i32 { lib.used() }
  `;
  const moduleSource = [
    "pub fn helper() -> i32 { 1 }",
    "pub fn used() -> i32 { helper() }",
    ...Array.from({ length: 12 }, (_, index) => `pub fn unused_${index}() -> i32 { ${index} }`),
  ].join("\n");
  const artifact = await compileArtifactsFromSource(source, {
    resolveModule: (moduleName) => moduleName === "fixture.lib" ? moduleSource : undefined,
    optMode: "release",
    compileTrace,
  });

  const scope = compileTrace.find((event) => event.name === "opt.scope");
  const analysis = compileTrace.find((event) => event.name === "opt.pass.0.analysis");
  const optimizeDecls = compileTrace.find((event) => event.name === "opt.pass.0.optimizeDecls");
  const foldFacts = compileTrace.find((event) => event.name === "opt.pass.0.foldAbstractFacts");
  assertEquals(scope?.counters?.reachableFunctions, 3);
  assertEquals(analysis?.counters?.dirtyFunctions, 2);
  assertEquals(analysis?.counters?.plannedActions, 2);
  assertEquals(optimizeDecls?.counters?.optimizedFunctions, 2);
  assertEquals(optimizeDecls?.counters?.visitedDeclarations, 2);
  assertEquals(optimizeDecls?.counters?.changedFunctions, 1);
  assertEquals(foldFacts?.counters?.visitedDeclarations, 2);
  const exports = WebAssembly.Module.exports(new WebAssembly.Module(artifact.wasm))
    .map((item) => item.name);
  assertEquals(exports, ["main"]);
});

Deno.test("optimizer cleanup second pass only revisits changed functions and callers", async () => {
  const compileTrace: CompileTraceEvent[] = [];
  const source = `
    fn inc(x: i32) -> i32 { x + 1 }
    fn wrap(x: i32) -> i32 { inc(x) }
    fn choose(x: i32) -> i32 {
      match (x + 1) == (x + 1) {
        true => wrap(x),
        false => inc(x)
      }
    }
    fn unused(x: i32) -> i32 { x + 100 }
    pub fn main(x: i32) -> i32 { choose(x) }
  `;

  await compileArtifactsFromSource(source, { optMode: "release", compileTrace });

  const pass0 = compileTrace.find((event) => event.name === "opt.pass.0.optimizeDecls");
  const analysis1 = compileTrace.find((event) => event.name === "opt.pass.1.analysis");
  const next0 = compileTrace.find((event) => event.name === "opt.pass.0.dirtyNext");
  const pass1 = compileTrace.find((event) => event.name === "opt.pass.1.optimizeDecls");
  assert(pass0);
  assert(analysis1);
  assert(next0);
  assert(pass1);
  assertEquals(analysis1.counters?.dirtyFunctions, next0.counters?.nextDirtyFunctions);
  assertEquals(pass1.counters?.dirtyFunctions, next0.counters?.nextDirtyFunctions);
  assert(
    (pass1.counters?.optimizedFunctions as number) < (pass0.counters?.optimizedFunctions as number),
  );
  assertEquals(pass1.counters?.visitedDeclarations, pass1.counters?.dirtyFunctions);
  assertEquals(pass0.counters?.changedFunctions, 1);
  assertEquals(pass1.counters?.dirtyFunctions, 2);
});

Deno.test("optimizer dirty pass tracks reachable top-level runtime declarations", async () => {
  const compileTrace: CompileTraceEvent[] = [];
  const source = `
    let top = (1 + 1) * 1;
    fn use(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 { use(top) }
  `;

  await compileArtifactsFromSource(source, { optMode: "release", compileTrace });

  const analysis0 = compileTrace.find((event) => event.name === "opt.pass.0.analysis");
  const pass0 = compileTrace.find((event) => event.name === "opt.pass.0.optimizeDecls");
  const next0 = compileTrace.find((event) => event.name === "opt.pass.0.dirtyNext");
  const pass1 = compileTrace.find((event) => event.name === "opt.pass.1.optimizeDecls");
  assert(analysis0);
  assert(pass0);
  assert(next0);
  assert(pass1);
  assertEquals(analysis0.counters?.dirtyDeclarations, 1);
  assertEquals(pass0.counters?.visitedDeclarations, 3);
  assertEquals(pass0.counters?.changedDeclarations, 1);
  assertEquals(next0.counters?.nextDirtyFunctions, 1);
  assertEquals(next0.counters?.nextDirtyDeclarations, 1);
  assertEquals(pass1.counters?.visitedDeclarations, 2);
});

Deno.test("optimizer extracts cheapest local equality candidates", async () => {
  const checked = await checkSource(`
    fn tautology(x: i32) -> i32 {
      match (x + 1) == (x + 1) { true => 7, false => 9 }
    }
    fn factored(x: i32, y: i32, z: i32) -> i32 {
      (x * y) + (x * z)
    }
    pub fn main(x: i32, y: i32, z: i32) -> i32 {
      tautology(x) + factored(x, y, z)
    }
  `);

  const optimized = optimizeProgram(checked.program, { optMode: "release" });
  const tautology = findFn(optimized, "tautology");
  assertEquals(tautology?.kind === "fn" ? tautology.body.expr : undefined, {
    kind: "literal",
    literalKind: "number",
    value: "7",
  });
  const factored = findFn(optimized, "factored");
  const expr = factored?.kind === "fn" ? factored.body.expr : undefined;
  assert(expr?.kind === "binary");
  assertEquals(expr.op, "*");
  const productTerms = [expr.left, expr.right];
  assert(productTerms.some((term) => term.kind === "var" && term.name === "x"));
  const sumTerm = productTerms.find((term) => term.kind === "binary");
  assert(sumTerm?.kind === "binary");
  assertEquals(sumTerm.op, "+");
});

Deno.test("function summaries distinguish self-tail recursion", async () => {
  const checked = await checkSource(`
    fn tail(n: i32, acc: i32) -> i32 {
      match n {
        0 => acc,
        _ => tail(n - 1, acc + n),
      }
    }
    fn non_tail(n: i32) -> i32 {
      match n {
        0 => 0,
        _ => 1 + non_tail(n - 1),
      }
    }
    pub fn main() -> i32 { tail(3, 0) + non_tail(3) }
  `);

  const summaries = summarizeProgram(checked.program);
  assertEquals(summaries.get("tail")?.recursiveKind, "self_tail");
  assertEquals(summaries.get("tail")?.stackBehavior, "tail_call");
  assertEquals(summaries.get("non_tail")?.recursiveKind, "self_non_tail");
  assertEquals(summaries.get("non_tail")?.stackBehavior, "recursive_stack");
});

Deno.test("recurrence summaries capture refined-domain recursive clauses", async () => {
  const checked = await checkSource(`
    fn sum_go(i: i32(4), acc: i32) -> i32 {
      acc
    }
    fn sum_go(i: i32(0..4), acc: i32) -> i32 {
      sum_go(i + 1, acc + i)
    }
    pub fn main() -> i32 { sum_go(0, 0) }
  `);

  const recurrence = summarizeRecurrences(checked.program).get("sum_go");
  const summaries = summarizeProgram(checked.program);
  assertEquals(recurrence?.kind, "finite_static");
  assertEquals(summaries.get("sum_go")?.maxRecursionUnfoldingCardinality, 5);
  assertEquals(summaries.get("sum_go__clause_1")?.maxRecursionUnfoldingCardinality, 5);
  assertEquals(recurrence?.params, ["i", "acc"]);
  assertEquals(recurrence?.clauses.length, 2);
  assertEquals(recurrence?.recursiveCalls.length, 1);
  assertEquals(recurrence?.recursiveCalls[0]?.tail, true);
  assertEquals(recurrence?.measure, {
    kind: "domain",
    param: "i",
    cardinality: 5,
    direction: "increasing",
    terminates: true,
  });
  assertEquals(
    recurrence?.clauses.map((clause) => clause.paramDomains[0]?.intervals[0]?.start),
    [
      { kind: "literal", value: 4, source: "4" },
      { kind: "literal", value: 0, source: "0" },
    ],
  );
});

Deno.test("recurrence summaries require domain progress for finite static classification", async () => {
  const checked = await checkSource(`
    fn stuck(i: i32(4), acc: i32) -> i32 {
      acc
    }
    fn stuck(i: i32(0..4), acc: i32) -> i32 {
      stuck(i, acc + i)
    }
    fn uncovered(i: i32(4), acc: i32) -> i32 {
      acc
    }
    fn uncovered(i: i32(0..4), acc: i32) -> i32 {
      uncovered(i + 2, acc + i)
    }
    pub fn main() -> i32 { stuck(0, 0) + uncovered(0, 0) }
  `);

  const recurrences = summarizeRecurrences(checked.program);
  assertEquals(recurrences.get("stuck")?.kind, "tail_linear");
  assertEquals(recurrences.get("stuck")?.measure?.terminates, false);
  assertEquals(recurrences.get("uncovered")?.kind, "tail_linear");
  assertEquals(recurrences.get("uncovered")?.measure?.terminates, false);
});

Deno.test("release optimizer expands proven finite static recurrences", async () => {
  const source = `
    fn sum_go(i: i32(4), acc: i32) -> i32 {
      acc
    }
    fn sum_go(i: i32(0..4), acc: i32) -> i32 {
      sum_go(i + 1, acc + i)
    }
    pub fn main() -> i32 { sum_go(0, 0) }
  `;
  const checked = await checkSource(source);
  const counts = countCalls(optimizeProgram(checked.program, { optMode: "release" }), {
    includeGenerated: false,
  });
  assertEquals(counts.get("sum_go") ?? 0, 0);

  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.const 6");
  assert(!wat.includes("call $sum_go"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 6);
});

Deno.test("release optimizer expands decreasing finite static recurrences", async () => {
  const source = `
    fn down(i: i32(0), acc: i32) -> i32 {
      acc
    }
    fn down(i: i32(1..5), acc: i32) -> i32 {
      down(i - 1, acc + i)
    }
    pub fn main() -> i32 { down(4, 0) }
  `;
  const checked = await checkSource(source);
  const recurrence = summarizeRecurrences(checked.program).get("down");
  assertEquals(recurrence?.measure?.direction, "decreasing");
  assertEquals(recurrence?.measure?.terminates, true);

  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.const 10");
  assert(!wat.includes("call $down"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 10);
});

Deno.test("release optimizer expands tiny non-tail finite static recurrences", async () => {
  const source = `
    fn fib(n: i32(0)) -> i32 {
      0
    }
    fn fib(n: i32(1)) -> i32 {
      1
    }
    fn fib(n: i32(2..6)) -> i32 {
      fib(n - 1) + fib(n - 2)
    }
    pub fn main() -> i32 { fib(5) }
  `;
  const checked = await checkSource(source);
  const recurrence = summarizeRecurrences(checked.program).get("fib");
  assertEquals(recurrence?.kind, "finite_static");
  assertEquals(recurrence?.recursiveCalls.every((call) => call.tail), false);

  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.const 5");
  assert(!wat.includes("call $fib"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 5);
});

Deno.test("release optimizer partially evaluates finite exponent recursion", async () => {
  const checked = await checkSource(`
    fn pow(base: i32, exp: i32(0)) -> i32 { 1 }
    fn pow(base: i32, exp: i32(1..8)) -> i32 {
      base * pow(base, exp - 1)
    }
    pub fn main(x: i32) -> i32 { pow(x, 3) }
  `);

  const optimized = optimizeProgram(checked.program, { optMode: "release" });
  const main = findFn(optimized, "main");
  const expr = main?.kind === "fn" ? main.body.expr : undefined;
  assertEquals(countCalls(optimized, { includeGenerated: false }).get("pow") ?? 0, 0);
  assert(expr?.kind === "binary");
  assertEquals(expr.op, "*");
  assertEquals(countExprRefs(expr, "x"), 3);
});

Deno.test("recurrence summaries classify structural and general recursion", async () => {
  const checked = await checkSource(`
    type fn Option(a: type) -> type {
      let None = {};
      let Some = {value: a};
      union(None, Some)
    }
    fn structural(xs: Option(i32)) -> i32 {
      match xs {
        Some(_) => 1 + structural(xs),
        None => 0,
      }
    }
    fn general(n: i32) -> i32 {
      1 + general(n - 1)
    }
    pub fn main(xs: Option(i32), n: i32) -> i32 {
      match n == 0 {
        true => structural(xs),
        false => general(n),
      }
    }
  `);

  const recurrences = summarizeRecurrences(checked.program);
  assertEquals(recurrences.get("structural")?.kind, "structural");
  assertEquals(recurrences.get("general")?.kind, "general_recursive");
});

Deno.test("does not inline large private helpers above the cost budget", async () => {
  const checked = await checkSource(`
    fn many(x: i32) -> i32 {
      let a = x + 1;
      let b = a + 1;
      let c = b + 1;
      let d = c + 1;
      let e = d + 1;
      let f = e + 1;
      let g = f + 1;
      let h = g + 1;
      h + 1
    }
    pub fn main() -> i32 { many(1) }
  `);
  const counts = countCalls(optimizeProgram(checked.program), { includeGenerated: false });
  assertEquals(counts.get("many") ?? 0, 1);
});

Deno.test("does not inline recursive or effectful helpers", async () => {
  const checked = await checkSource(`
    const clock = @external("clock", fn(host: io) -> io(i32));
    fn tick(host: io) -> i32 { clock(host) }
    fn count(n: i32) -> i32 { match n { 0 => 0, _ => count(n - 1) } }
    pub fn main(host: io) -> i32 { tick(host) + count(2) }
  `);
  const counts = countCalls(optimizeProgram(checked.program), { includeGenerated: false });
  assertEquals(counts.get("tick") ?? 0, 1);
  assertEquals(counts.get("count") ?? 0, 2);
});

Deno.test("inlining preserves shadowed local bindings", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
        fn helper(x: i32) -> i32 {
          let x = 2;
          x
        }
        pub fn main() -> i32 { helper(40) }
      `),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 2);
});

Deno.test("inlining alpha-renames helper locals away from caller locals", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
        fn helper(x: i32) -> i32 {
          let tmp = x + 1;
          tmp
        }
        pub fn main() -> i32 {
          let tmp = 10;
          helper(tmp) + tmp
        }
      `),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 21);
});

Deno.test("product helpers do not inline into nested value arguments", async () => {
  const checked = await checkSource(`
    type fn Pair() { let Pair = {left: i32, right: i32}; struct(Pair) }
    fn make_pair() -> Pair { Pair {left: 1, right: 2} }
    fn sum(pair: Pair) -> i32 { pair.left + pair.right }
    pub fn main() -> i32 { sum(make_pair()) }
  `);
  const counts = countCalls(optimizeProgram(checked.program), { includeGenerated: false });
  assertEquals(counts.get("make_pair") ?? 0, 1);
});

Deno.test("emits deterministic WAT and valid wasm32", async () => {
  const source = `pub fn main() -> i32 { 40 + 2 }`;
  assertEquals(
    await watFromSource(source),
    `(module
  (func $main (export "main") (result i32)
    i32.const 42
  )
)`,
  );
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as () => number)(), 42);
});

Deno.test("compileArtifactsFromSource emits WAT and Wasm from one checked source", async () => {
  const source = `pub fn main() -> i32 { 40 + 2 }`;
  const options = { optMode: "release" as const };
  const artifact = await compileArtifactsFromSource(source, options);
  assertStringIncludes(artifact.wat, "i32.const 42");
  assertEquals(artifact.wat, await watFromSource(source, options));
  assertEquals(artifact.wasm, await wasmFromSource(source, options));
  assert(artifact.wasm.byteLength > 0);
  assert(artifact.timings.parseMs >= 0);
  assert(artifact.timings.checkMs >= 0);
  assert(artifact.timings.backendMs >= 0);
  assert(artifact.timings.optimizeMs >= 0);
  assert(artifact.timings.backendLayoutMs >= 0);
  assert(artifact.timings.backendLowerMs >= 0);
  assert(artifact.timings.backendCleanupMs >= 0);
  assert(artifact.timings.watRenderMs >= 0);
  assert(artifact.timings.wasmEncodeMs >= 0);
  assert(artifact.timings.watMs >= 0);
  assert(artifact.timings.wasmMs >= 0);

  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
  assertEquals((instance.exports.main as () => number)(), 42);
});

Deno.test("compileWasmFromSource skips WAT rendering", async () => {
  const source = `pub fn main() -> i32 { 40 + 2 }`;
  const artifact = await compileArtifactsFromSource(source, {
    includeWat: false,
    optMode: "release",
  });
  assertEquals(artifact.wat, undefined);
  assertEquals(artifact.timings.watMs, 0);
  assertEquals(artifact.timings.watRenderMs, 0);
  assertEquals(artifact.wasm, await compileWasmFromSource(source, { optMode: "release" }));

  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
  assertEquals((instance.exports.main as () => number)(), 42);
});

Deno.test("checkSource emits parse subphase trace events", async () => {
  const compileTrace: CompileTraceEvent[] = [];
  await checkSource(`pub fn main() -> i32 { 1 }`, { compileTrace });
  const events = new Map(compileTrace.map((event) => [event.name, event]));
  assert(events.has("parse.syntax"));
  assert(events.has("parse.adapt"));
  assertEquals(events.get("parse.docs")?.counters?.hasDocs, false);
  assert(events.has("parse.lower"));
});

Deno.test("compileArtifactsFromSource traces import phases", async () => {
  const artifact = await compileArtifactsFromSource(
    `
      const core = @import("prelude.core");
      pub fn main(raw: i32) -> i32 {
        match core.i32::try_domain(i32(0..4), raw) {
          Some(i) => i,
          None => 0,
        }
      }
    `,
    {
      resolveModule: resolveProjectModule,
      pruneImports: true,
      trace: true,
    },
  );
  const phaseNames = new Set(artifact.importTrace?.phases.map((phase) => phase.name));
  assert(phaseNames.has("import.parse.module"));
  assert(phaseNames.has("import.merge.module"));
  assert(phaseNames.has("import.prune.collect_names"));
  assert(phaseNames.has("import.prune.worklist"));
  assert(phaseNames.has("import.prune.references"));
});

Deno.test("compile trace sink receives import phase events", async () => {
  const compileTrace: CompileTraceEvent[] = [];
  await checkSource(
    `
      const core = @import("prelude.core");
      pub fn main(raw: i32) -> i32 {
        match core.i32::try_domain(i32(0..4), raw) {
          Some(i) => i,
          None => 0,
        }
      }
    `,
    {
      resolveModule: resolveProjectModule,
      pruneImports: true,
      compileTrace,
    },
  );
  const importEvents = compileTrace.filter((event) => event.name.startsWith("import."));
  assert(importEvents.some((event) => event.name === "import.parse.module"));
  assert(importEvents.some((event) => event.name === "import.prune.worklist"));
  assert(importEvents.some((event) => event.name === "import.prune.references"));
  assert(importEvents.some((event) => typeof event.counters?.declarationsIn === "number"));
  assert(importEvents.some((event) => typeof event.counters?.fnCount === "number"));
});

Deno.test("compileArtifactsFromSource reuses shared import cache", async () => {
  const cache = createCompileCache();
  let resolveCalls = 0;
  const resolveModule = async (moduleName: string) => {
    resolveCalls++;
    return await resolveProjectModule(moduleName);
  };
  const source = `
    const core = @import("prelude.core");
    pub fn main(raw: i32) -> i32 {
      match core.i32::try_domain(i32(0..4), raw) {
        Some(i) => i,
        None => 0,
      }
    }
  `;
  await compileArtifactsFromSource(source, { resolveModule, pruneImports: true, cache });
  const firstResolveCalls = resolveCalls;
  const parsedCacheSize = cache.parsedModules.size;
  const resolvedCacheSize = cache.resolvedModules.size;
  assert(firstResolveCalls > 0);
  assert(parsedCacheSize > 0);
  assert(resolvedCacheSize > 0);

  await compileArtifactsFromSource(source, { resolveModule, pruneImports: true, cache });
  assert(resolveCalls > firstResolveCalls);
  assertEquals(cache.parsedModules.size, parsedCacheSize);
  assertEquals(cache.resolvedModules.size, resolvedCacheSize);
});

Deno.test("compileArtifactsFromSource reuses cached pruned imports", async () => {
  const cache = createCompileCache();
  const source = `
    const left = @import("fixture.lib");
    const right = @import("fixture.lib");
    pub fn main() -> i32 { left.used() + right.used() }
  `;
  const moduleSource = `
    fn helper() -> i32 { 1 }
    fn used() -> i32 { helper() }
    fn unused() -> i32 { 99 }
  `;
  const artifact = await compileArtifactsFromSource(source, {
    resolveModule: (moduleName) => moduleName === "fixture.lib" ? moduleSource : undefined,
    pruneImports: true,
    cache,
    trace: true,
  });
  const cacheHit = artifact.importTrace?.phases.some((phase) =>
    phase.name === "import.prune.finish" && phase.cacheHit
  );
  assertEquals(cache.prunedImports.size, 1);
  assertEquals(cacheHit, true);

  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
  assertEquals((instance.exports.main as () => number)(), 2);
});

Deno.test("compileArtifactsFromSource resolves repeated imports once per importer", async () => {
  let resolveCalls = 0;
  const source = `
    const left = @import("fixture.lib");
    const right = @import("fixture.lib");
    pub fn main() -> i32 { left.value() + right.value() }
  `;
  const artifact = await compileArtifactsFromSource(source, {
    resolveModule: (moduleName) => {
      resolveCalls++;
      return moduleName === "fixture.lib" ? "fn value() -> i32 { 4 }" : undefined;
    },
    pruneImports: true,
    trace: true,
  });
  assertEquals(resolveCalls, 1);
  assert(
    artifact.importTrace?.phases.some((phase) =>
      phase.name === "import.resolve.root" && phase.cacheHit
    ),
  );
  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
  assertEquals((instance.exports.main as () => number)(), 8);
});

Deno.test("compileArtifactsFromSource reuses cached import closures", async () => {
  const cache = createCompileCache();
  const source = `
    const lib = @import("fixture.lib");
    pub fn main() -> i32 { lib.used() }
  `;
  const moduleSource = `
    fn helper() -> i32 { 1 }
    fn used() -> i32 { helper() }
    fn unused() -> i32 { 99 }
  `;
  await compileArtifactsFromSource(source, {
    resolveModule: (moduleName) => moduleName === "fixture.lib" ? moduleSource : undefined,
    pruneImports: true,
    cache,
    trace: true,
  });
  const second = await compileArtifactsFromSource(source, {
    resolveModule: (moduleName) => moduleName === "fixture.lib" ? moduleSource : undefined,
    pruneImports: true,
    cache,
    trace: true,
  });
  assertEquals(cache.importClosures?.size, 1);
  assert(
    second.importTrace?.phases.some((phase) =>
      phase.name === "import.closure.cache" && phase.cacheHit
    ),
  );
});

Deno.test("compileArtifactsFromSource reuses linked modules with nested imports", async () => {
  const cache = createCompileCache();
  const modules = new Map([
    [
      "/fixture/lib.fig",
      `
      const leaf = @import("./leaf.fig");
      fn value() -> i32 { leaf.value() }
    `,
    ],
    ["/fixture/leaf.fig", "fn value() -> i32 { 4 }"],
  ]);
  const resolveModule = (moduleName: string, context?: { fromSourceId?: string }) => {
    if (moduleName === "./lib.fig") {
      return { sourceId: "/fixture/lib.fig", text: modules.get("/fixture/lib.fig")! };
    }
    if (moduleName === "./leaf.fig" && context?.fromSourceId === "/fixture/lib.fig") {
      return { sourceId: "/fixture/leaf.fig", text: modules.get("/fixture/leaf.fig")! };
    }
    return undefined;
  };
  const source = `
    const lib = @import("./lib.fig");
    pub fn main() -> i32 { lib.value() }
  `;
  await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
    trace: true,
  });
  const second = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
    trace: true,
  });
  assert((cache.linkedModules?.size ?? 0) > 0);
  assert(
    second.importTrace?.phases.some((phase) =>
      phase.name === "import.link.module" && phase.cacheHit
    ),
  );
});

Deno.test("linked module cache key changes when a dependency changes", async () => {
  const cache = createCompileCache();
  let leafValue = 1;
  const resolveModule = (moduleName: string, context?: { fromSourceId?: string }) => {
    if (moduleName === "./lib.fig") {
      return {
        sourceId: "/fixture/lib.fig",
        text: `
          const leaf = @import("./leaf.fig");
          fn value() -> i32 { leaf.value() }
        `,
      };
    }
    if (moduleName === "./leaf.fig" && context?.fromSourceId === "/fixture/lib.fig") {
      return { sourceId: "/fixture/leaf.fig", text: `fn value() -> i32 { ${leafValue} }` };
    }
    return undefined;
  };
  const source = `
    const lib = @import("./lib.fig");
    pub fn main() -> i32 { lib.value() }
  `;
  const first = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
  });
  let instance = new WebAssembly.Instance(new WebAssembly.Module(first.wasm));
  assertEquals((instance.exports.main as () => number)(), 1);

  leafValue = 2;
  const second = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
  });
  instance = new WebAssembly.Instance(new WebAssembly.Module(second.wasm));
  assertEquals((instance.exports.main as () => number)(), 2);
});

Deno.test("compile cache records body-stable linked module key candidates", async () => {
  class CountingSet<T> extends Set<T> {
    hits = 0;
    misses = 0;

    override has(value: T): boolean {
      const found = super.has(value);
      if (found) {
        this.hits++;
      } else {
        this.misses++;
      }
      return found;
    }

    resetCounts() {
      this.hits = 0;
      this.misses = 0;
    }
  }

  const cache = createCompileCache();
  const stableLinkedModuleKeys = new CountingSet<string>();
  cache.stableLinkedModuleKeys = stableLinkedModuleKeys;
  let leafValue = 1;
  const resolveModule = (moduleName: string, context?: { fromSourceId?: string }) => {
    if (moduleName === "./lib.fig") {
      return {
        sourceId: "/fixture/lib.fig",
        text: `
          const leaf = @import("./leaf.fig");
          fn value() -> i32 { leaf.value() }
        `,
      };
    }
    if (moduleName === "./leaf.fig" && context?.fromSourceId === "/fixture/lib.fig") {
      return { sourceId: "/fixture/leaf.fig", text: `fn value() -> i32 { ${leafValue} }` };
    }
    return undefined;
  };
  const source = `
    const lib = @import("./lib.fig");
    pub fn main() -> i32 { lib.value() }
  `;

  const first = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
  });
  let instance = new WebAssembly.Instance(new WebAssembly.Module(first.wasm));
  assertEquals((instance.exports.main as () => number)(), 1);

  stableLinkedModuleKeys.resetCounts();
  leafValue = 2;
  const second = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
  });
  instance = new WebAssembly.Instance(new WebAssembly.Module(second.wasm));
  assertEquals((instance.exports.main as () => number)(), 2);
  assert(stableLinkedModuleKeys.hits > 0);
});

Deno.test("compile cache records body-stable import closure key candidates", async () => {
  class CountingSet<T> extends Set<T> {
    hits = 0;
    misses = 0;

    override has(value: T): boolean {
      const found = super.has(value);
      if (found) {
        this.hits++;
      } else {
        this.misses++;
      }
      return found;
    }

    resetCounts() {
      this.hits = 0;
      this.misses = 0;
    }
  }

  const cache = createCompileCache();
  const stableImportClosureKeys = new CountingSet<string>();
  cache.stableImportClosureKeys = stableImportClosureKeys;
  let leafValue = 1;
  const resolveModule = (moduleName: string, context?: { fromSourceId?: string }) => {
    if (moduleName === "./lib.fig") {
      return {
        sourceId: "/fixture/lib.fig",
        text: `
          const leaf = @import("./leaf.fig");
          fn value() -> i32 { leaf.value() }
        `,
      };
    }
    if (moduleName === "./leaf.fig" && context?.fromSourceId === "/fixture/lib.fig") {
      return { sourceId: "/fixture/leaf.fig", text: `fn value() -> i32 { ${leafValue} }` };
    }
    return undefined;
  };
  const source = `
    const lib = @import("./lib.fig");
    pub fn main() -> i32 { lib.value() }
  `;

  const first = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
  });
  let instance = new WebAssembly.Instance(new WebAssembly.Module(first.wasm));
  assertEquals((instance.exports.main as () => number)(), 1);

  stableImportClosureKeys.resetCounts();
  leafValue = 2;
  const second = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
  });
  instance = new WebAssembly.Instance(new WebAssembly.Module(second.wasm));
  assertEquals((instance.exports.main as () => number)(), 2);
  assert(stableImportClosureKeys.hits > 0);
  assertEquals(stableImportClosureKeys.misses, 0);
});

Deno.test("compile cache records body-stable checked program key candidates", async () => {
  class CountingSet<T> extends Set<T> {
    hits = 0;
    misses = 0;

    override has(value: T): boolean {
      const found = super.has(value);
      if (found) {
        this.hits++;
      } else {
        this.misses++;
      }
      return found;
    }

    resetCounts() {
      this.hits = 0;
      this.misses = 0;
    }
  }

  const cache = createCompileCache();
  const checkedProgramKeys = new CountingSet<string>();
  cache.checkedProgramKeys = checkedProgramKeys;
  let leafValue = 1;
  const resolveModule = (moduleName: string, context?: { fromSourceId?: string }) => {
    if (moduleName === "./lib.fig") {
      return {
        sourceId: "/fixture/lib.fig",
        text: `
          const leaf = @import("./leaf.fig");
          fn value() -> i32 { leaf.value() }
        `,
      };
    }
    if (moduleName === "./leaf.fig" && context?.fromSourceId === "/fixture/lib.fig") {
      return { sourceId: "/fixture/leaf.fig", text: `fn value() -> i32 { ${leafValue} }` };
    }
    return undefined;
  };
  const source = `
    const lib = @import("./lib.fig");
    pub fn main() -> i32 { lib.value() }
  `;

  const first = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
  });
  let instance = new WebAssembly.Instance(new WebAssembly.Module(first.wasm));
  assertEquals((instance.exports.main as () => number)(), 1);

  checkedProgramKeys.resetCounts();
  leafValue = 2;
  const second = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
  });
  instance = new WebAssembly.Instance(new WebAssembly.Module(second.wasm));
  assertEquals((instance.exports.main as () => number)(), 2);
  assertEquals(checkedProgramKeys.hits, 1);
  assertEquals(checkedProgramKeys.misses, 0);
});

Deno.test("module interface key ignores function bodies but tracks signatures", async () => {
  const original = await parse(`
    const dep = @import("./dep.fig");
    type fn Box() -> type {
      let Box = {value: i32};
      struct(Box)
    }
    fn value(x: i32) -> i32 { x + 1 }
    const exported: i32 = 1
  `);
  const bodyEdit = await parse(`
    const dep = @import("./dep.fig");
    type fn Box() -> type {
      let Box = {value: i32};
      struct(Box)
    }
    fn value(x: i32) -> i32 { x + 99 }
    const exported: i32 = 2
  `);
  const signatureEdit = await parse(`
    const dep = @import("./dep.fig");
    type fn Box() -> type {
      let Box = {value: i32};
      struct(Box)
    }
    fn value(x: i64) -> i32 { 1 }
    const exported: i32 = 1
  `);
  const typeEdit = await parse(`
    const dep = @import("./dep.fig");
    type fn Box() -> type {
      let Box = {value: i64};
      struct(Box)
    }
    fn value(x: i32) -> i32 { x + 1 }
    const exported: i32 = 1
  `);
  assertEquals(moduleInterfaceKey(original), moduleInterfaceKey(bodyEdit));
  assert(moduleInterfaceKey(original) !== moduleInterfaceKey(signatureEdit));
  assert(moduleInterfaceKey(original) !== moduleInterfaceKey(typeEdit));
});

Deno.test("compile cache records stable module interface keys across body edits", async () => {
  const cache = createCompileCache();
  let value = 1;
  const source = `
    const lib = @import("fixture.lib");
    pub fn main() -> i32 { lib.value() }
  `;
  const resolveModule = (moduleName: string) =>
    moduleName === "fixture.lib" ? `fn value() -> i32 { ${value} }` : undefined;
  await compileArtifactsFromSource(source, { resolveModule, pruneImports: true, cache });
  value = 2;
  await compileArtifactsFromSource(source, { resolveModule, pruneImports: true, cache });
  assertEquals(new Set(cache.moduleInterfaceKeys?.values()).size, 1);
  assertEquals(cache.moduleInterfaceKeysBySourceId?.size, 1);
  assertEquals(cache.stableModuleInterfaces?.size, 1);
});

Deno.test("compile cache reuses module reference keys for unchanged imports", async () => {
  class CountingMap<K, V> extends Map<K, V> {
    hits = 0;
    misses = 0;

    override get(key: K): V | undefined {
      if (this.has(key)) {
        this.hits++;
      } else {
        this.misses++;
      }
      return super.get(key);
    }

    resetCounts() {
      this.hits = 0;
      this.misses = 0;
    }
  }

  const cache = createCompileCache();
  const moduleReferenceKeys = new CountingMap<string, string>();
  cache.moduleReferenceKeys = moduleReferenceKeys;
  const modules = new Map([
    [
      "/project/lib.fig",
      `
        const leaf = @import("./leaf.fig");
        fn value() -> i32 { leaf.value() }
      `,
    ],
    ["/project/leaf.fig", "fn value() -> i32 { 1 }"],
  ]);
  const source = `
    const lib = @import("./lib.fig");
    pub fn main() -> i32 { lib.value() }
  `;
  const resolveModule = (moduleName: string, context?: { fromSourceId?: string }) => {
    if (moduleName === "./lib.fig") {
      return { sourceId: "/project/lib.fig", text: modules.get("/project/lib.fig")! };
    }
    if (moduleName === "./leaf.fig" && context?.fromSourceId === "/project/lib.fig") {
      return { sourceId: "/project/leaf.fig", text: modules.get("/project/leaf.fig")! };
    }
    return undefined;
  };

  await compileArtifactsFromSource(source, { resolveModule, pruneImports: true, cache });
  moduleReferenceKeys.resetCounts();
  modules.set("/project/leaf.fig", "fn value() -> i32 { 2 }");
  const second = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
  });
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.wasm));
  assertEquals((instance.exports.main as () => number)(), 2);
  assert(moduleReferenceKeys.hits > 0);
  assert(moduleReferenceKeys.misses > 0);
});

Deno.test("compile cache rehydrates pruned import selections after body edits", async () => {
  const cache = createCompileCache();
  let value = 1;
  const source = `
    const lib = @import("fixture.selection");
    pub fn main() -> i32 { lib.used() }
  `;
  const resolveModule = (moduleName: string) => {
    if (moduleName !== "fixture.selection") return undefined;
    return `
        fn helper() -> i32 { ${value} }
        fn used() -> i32 { helper() }
        fn unused() -> i32 { 99 }
      `;
  };

  await compileArtifactsFromSource(source, { resolveModule, pruneImports: true, cache });
  value = 2;
  const compileTrace: CompileTraceEvent[] = [];
  const second = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
    compileTrace,
  });
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.wasm));
  assertEquals((instance.exports.main as () => number)(), 2);

  let selectionCacheHits = 0;
  for (const event of compileTrace) {
    const matchesSelectionCache = event.name === "import.prune.selection_cache";
    const matchesModule = event.counters?.moduleName === "fixture.selection";
    if (matchesSelectionCache && matchesModule) selectionCacheHits++;
  }
  assertEquals(selectionCacheHits, 1);
});

Deno.test("compile cache misses pruned import selections when body references change", async () => {
  const cache = createCompileCache();
  let useFallback = false;
  const source = `
    const lib = @import("fixture.reference_change");
    pub fn main() -> i32 { lib.used() }
  `;
  const resolveModule = (moduleName: string) => {
    if (moduleName !== "fixture.reference_change") return undefined;
    const helperBody = useFallback ? "fallback()" : "1";
    return `
        fn fallback() -> i32 { 7 }
        fn helper() -> i32 { ${helperBody} }
        fn used() -> i32 { helper() }
        fn unused() -> i32 { 99 }
      `;
  };

  await compileArtifactsFromSource(source, { resolveModule, pruneImports: true, cache });
  useFallback = true;
  const compileTrace: CompileTraceEvent[] = [];
  const second = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
    compileTrace,
  });
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.wasm));
  assertEquals((instance.exports.main as () => number)(), 7);

  for (const event of compileTrace) {
    const matchesSelectionCache = event.name === "import.prune.selection_cache";
    const matchesModule = event.counters?.moduleName === "fixture.reference_change";
    assert(!(matchesSelectionCache && matchesModule));
  }
});

Deno.test("compile cache invalidates parsed imports when module source changes", async () => {
  const cache = createCompileCache();
  let value = 1;
  const resolveModule = (moduleName: string) =>
    moduleName === "fixture.dynamic" ? `fn value() -> i32 { ${value} }` : undefined;
  const source = `
    const fixture = @import("fixture.dynamic");
    pub fn main() -> i32 { fixture.value() }
  `;
  const first = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
  });
  let instance = new WebAssembly.Instance(new WebAssembly.Module(first.wasm));
  assertEquals((instance.exports.main as () => number)(), 1);

  value = 2;
  const second = await compileArtifactsFromSource(source, {
    resolveModule,
    pruneImports: true,
    cache,
  });
  instance = new WebAssembly.Instance(new WebAssembly.Module(second.wasm));
  assertEquals((instance.exports.main as () => number)(), 2);
});

Deno.test("compiler session tracks import dependencies and affected roots", async () => {
  const modules = new Map([
    ["/project/lib.fig", "fn value() -> i32 { 1 }"],
  ]);
  const session = createCompilerSession({
    includeWat: false,
    resolveModule: (moduleName, context) => {
      if (moduleName !== "./lib.fig") return undefined;
      assertEquals(context?.fromSourceId, "/project/main.fig");
      return { text: modules.get("/project/lib.fig")!, sourceId: "/project/lib.fig" };
    },
  });

  const first = await session.compileRoot({
    sourceId: "/project/main.fig",
    text: `
      const lib = @import("./lib.fig");
      pub fn main() -> i32 { lib.value() }
    `,
  });
  assertEquals(first.ok, true);
  assertEquals(first.dependencies, [{
    importerSourceId: "/project/main.fig",
    moduleName: "./lib.fig",
    sourceId: "/project/lib.fig",
  }]);
  assertEquals(session.affectedRoots("/project/lib.fig"), ["/project/main.fig"]);

  modules.set("/project/lib.fig", "fn value() -> i32 { 2 }");
  const update = session.update({
    sourceId: "/project/lib.fig",
    text: modules.get("/project/lib.fig")!,
  });
  assertEquals(update.affectedRoots, ["/project/main.fig"]);
  const second = await session.compileRoot({
    sourceId: "/project/main.fig",
    text: `
      const lib = @import("./lib.fig");
      pub fn main() -> i32 { lib.value() }
    `,
  });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.artifact.wasm));
  assertEquals((instance.exports.main as () => number)(), 2);
});

Deno.test("compiler session reuses artifact for semantic no-op root edits", async () => {
  const session = createCompilerSession({
    includeWat: false,
    resolveModule: () => undefined,
  });
  const source = "pub fn main() -> i32 { 1 }";
  const first = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(first.ok, true);
  const second = await session.compileRoot({
    sourceId: "/project/main.fig",
    text: `${source}\n// trailing edit`,
  });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assertEquals(second.artifact.timings.importMs, 0);
  assertEquals(second.artifact.timings.checkMs, 0);
  assertEquals(second.artifact.timings.backendMs, 0);
  assertEquals(second.artifact.timings.wasmEncodeMs, 0);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.artifact.wasm));
  assertEquals((instance.exports.main as () => number)(), 1);
});

Deno.test("compiler session reuses parsed root for trailing trivia replacements", async () => {
  const session = createCompilerSession({
    includeWat: false,
    resolveModule: () => undefined,
  });
  const source = "pub fn main() -> i32 { 1 }";
  const first = await session.compileRoot({
    sourceId: "/project/main.fig",
    text: `${source}\n// first trailing edit`,
  });
  assertEquals(first.ok, true);
  const second = await session.compileRoot({
    sourceId: "/project/main.fig",
    text: `${source}\n// second trailing edit`,
  });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assertEquals(second.artifact.timings.parseMs, 0);
  assertEquals(second.artifact.timings.importMs, 0);
  assertEquals(second.artifact.timings.checkMs, 0);
  assertEquals(second.artifact.timings.backendMs, 0);
  assertEquals(second.artifact.timings.wasmEncodeMs, 0);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.artifact.wasm));
  assertEquals((instance.exports.main as () => number)(), 1);
});

Deno.test("compiler session reuses artifact for semantic no-op import edits", async () => {
  const modules = new Map([
    ["/project/lib.fig", "fn value() -> i32 { 1 }"],
  ]);
  const session = createCompilerSession({
    includeWat: false,
    resolveModule: (moduleName) => {
      if (moduleName !== "./lib.fig") return undefined;
      return { text: modules.get("/project/lib.fig")!, sourceId: "/project/lib.fig" };
    },
  });
  const source = `
    const lib = @import("./lib.fig");
    pub fn main() -> i32 { lib.value() }
  `;
  const first = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(first.ok, true);

  modules.set("/project/lib.fig", "fn value() -> i32 { 1 }\n// trailing edit");
  session.update({ sourceId: "/project/lib.fig", text: modules.get("/project/lib.fig")! });
  const second = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assertEquals(second.artifact.timings.parseMs, 0);
  assertEquals(second.artifact.timings.importMs, 0);
  assertEquals(second.artifact.timings.checkMs, 0);
  assertEquals(second.artifact.timings.backendMs, 0);
  assertEquals(second.artifact.timings.wasmEncodeMs, 0);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.artifact.wasm));
  assertEquals((instance.exports.main as () => number)(), 1);
});

Deno.test("compiler session reuses artifact for import trailing trivia replacements", async () => {
  const modules = new Map([
    ["/project/lib.fig", "fn value() -> i32 { 1 }\n// first trailing edit"],
  ]);
  const session = createCompilerSession({
    includeWat: false,
    resolveModule: (moduleName) => {
      if (moduleName !== "./lib.fig") return undefined;
      return { text: modules.get("/project/lib.fig")!, sourceId: "/project/lib.fig" };
    },
  });
  const source = `
    const lib = @import("./lib.fig");
    pub fn main() -> i32 { lib.value() }
  `;
  const first = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(first.ok, true);

  modules.set("/project/lib.fig", "fn value() -> i32 { 1 }\n// second trailing edit");
  session.update({ sourceId: "/project/lib.fig", text: modules.get("/project/lib.fig")! });
  const second = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assertEquals(second.artifact.timings.parseMs, 0);
  assertEquals(second.artifact.timings.importMs, 0);
  assertEquals(second.artifact.timings.checkMs, 0);
  assertEquals(second.artifact.timings.backendMs, 0);
  assertEquals(second.artifact.timings.wasmEncodeMs, 0);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.artifact.wasm));
  assertEquals((instance.exports.main as () => number)(), 1);
});

Deno.test("compiler session keeps function caches across semantic import edits", async () => {
  class CountingMap<K, V> extends Map<K, V> {
    hits = 0;
    misses = 0;

    override get(key: K): V | undefined {
      if (this.has(key)) this.hits++;
      else this.misses++;
      return super.get(key);
    }

    resetCounts() {
      this.hits = 0;
      this.misses = 0;
    }
  }

  class CountingWeakMap<K extends object, V> extends WeakMap<K, V> {
    hits = 0;
    misses = 0;

    override get(key: K): V | undefined {
      const value = super.get(key);
      if (value === undefined) this.misses++;
      else this.hits++;
      return value;
    }

    resetCounts() {
      this.hits = 0;
      this.misses = 0;
    }
  }

  const cache = createCompileCache();
  const functionChecks = new CountingMap<string, unknown>();
  const backendFunctions = new CountingMap<string, unknown>();
  const backendDirectCalls = new CountingWeakMap<object, Extract<Expr, { kind: "call" }>[]>();
  cache.functionChecks = functionChecks as typeof cache.functionChecks;
  cache.backendFunctions = backendFunctions as typeof cache.backendFunctions;
  cache.backendDirectCalls = backendDirectCalls as typeof cache.backendDirectCalls;
  const modules = new Map([
    [
      "/project/lib.fig",
      `
        fn stable(x: i32) -> i32 { x * 2 }
        fn changed(x: i32) -> i32 { x + 1 }
        fn entry(x: i32) -> i32 { stable(x) + changed(x) }
      `,
    ],
  ]);
  const session = createCompilerSession({
    cache,
    includeWat: false,
    resolveModule: (moduleName) => {
      if (moduleName !== "./lib.fig") return undefined;
      return { text: modules.get("/project/lib.fig")!, sourceId: "/project/lib.fig" };
    },
  });
  const source = `
    const lib = @import("./lib.fig");
    pub fn main(x: i32) -> i32 { lib.entry(x) }
  `;
  const first = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(first.ok, true);
  functionChecks.resetCounts();
  backendFunctions.resetCounts();
  backendDirectCalls.resetCounts();

  modules.set(
    "/project/lib.fig",
    `
      fn stable(x: i32) -> i32 { x * 2 }
      fn changed(x: i32) -> i32 { x + 2 }
      fn entry(x: i32) -> i32 { stable(x) + changed(x) }
    `,
  );
  session.update({ sourceId: "/project/lib.fig", text: modules.get("/project/lib.fig")! });
  const second = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.artifact.wasm));
  assertEquals((instance.exports.main as (x: number) => number)(3), 11);
  assert(functionChecks.hits > 0);
  assert(functionChecks.misses <= 1);
  assert(backendFunctions.hits > 0);
  assert(backendFunctions.misses <= 1);
  assert(backendDirectCalls.hits + backendDirectCalls.misses > 0);
});

Deno.test("checker declaration transform caches survive semantic import edits", async () => {
  class CountingWeakSet<T extends object> extends WeakSet<T> {
    hits = 0;

    override has(value: T): boolean {
      const hit = super.has(value);
      if (hit) this.hits++;
      return hit;
    }
  }

  class CountingWeakMap<K extends object, V> extends WeakMap<K, V> {
    hits = 0;

    override get(key: K): V | undefined {
      const value = super.get(key);
      if (value !== undefined) this.hits++;
      return value;
    }
  }

  class CountingSet<T> extends Set<T> {
    hits = 0;

    override has(value: T): boolean {
      const hit = super.has(value);
      if (hit) this.hits++;
      return hit;
    }
  }

  const cache = createCompileCache();
  const builtinOperatorLoweredDeclarations = new CountingWeakSet<object>();
  const branchHintCheckedDeclarations = new CountingWeakSet<object>();
  const balancedBinaryDeclarations = new CountingWeakSet<object>();
  const collectorLoweredDeclarations = new CountingWeakMap<object, string>();
  const typeContractChecks = new CountingSet<string>();
  cache.builtinOperatorLoweredDeclarations = builtinOperatorLoweredDeclarations;
  cache.branchHintCheckedDeclarations = branchHintCheckedDeclarations;
  cache.balancedBinaryDeclarations = balancedBinaryDeclarations;
  cache.collectorLoweredDeclarations = collectorLoweredDeclarations;
  cache.typeContractChecks = typeContractChecks;
  const modules = new Map([
    [
      "/project/lib.fig",
      `
        type fn Lane4I32() -> type {
          let Lane4I32 = {4*i32};
          struct(Lane4I32)
        }
        fn stable(seed: i32) -> i32 {
          let row: Lane4I32 = #[1, 2, 3, 4];
          seed + row[0] + row[1] + row[2] + row[3]
        }
        fn changed(seed: i32) -> i32 { seed + 1 }
        fn entry(seed: i32) -> i32 { stable(seed) + changed(seed) }
      `,
    ],
  ]);
  const session = createCompilerSession({
    cache,
    includeWat: false,
    pruneImports: true,
    resolveModule: (moduleName) => {
      if (moduleName !== "./lib.fig") return undefined;
      return { text: modules.get("/project/lib.fig")!, sourceId: "/project/lib.fig" };
    },
  });
  const source = `
    const lib = @import("./lib.fig");
    pub fn main(seed: i32) -> i32 { lib.entry(seed) }
  `;
  const first = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(first.ok, true);

  modules.set(
    "/project/lib.fig",
    `
      type fn Lane4I32() -> type {
        let Lane4I32 = {4*i32};
        struct(Lane4I32)
      }
      fn stable(seed: i32) -> i32 {
        let row: Lane4I32 = #[1, 2, 3, 4];
        seed + row[0] + row[1] + row[2] + row[3]
      }
      fn changed(seed: i32) -> i32 { seed + 2 }
      fn entry(seed: i32) -> i32 { stable(seed) + changed(seed) }
    `,
  );
  session.update({ sourceId: "/project/lib.fig", text: modules.get("/project/lib.fig")! });
  const second = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assert(builtinOperatorLoweredDeclarations.hits > 0);
  assert(branchHintCheckedDeclarations.hits > 0);
  assert(balancedBinaryDeclarations.hits > 0);
  assert(collectorLoweredDeclarations.hits > 0);
  assert(typeContractChecks.hits > 0);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.artifact.wasm));
  assertEquals((instance.exports.main as (seed: number) => number)(10), 32);
});

Deno.test("alias root cache survives imported body-only edits", async () => {
  class CountingMap<K, V> extends Map<K, V> {
    hits = 0;
    misses = 0;

    override get(key: K): V | undefined {
      if (this.has(key)) this.hits++;
      else this.misses++;
      return super.get(key);
    }

    resetCounts() {
      this.hits = 0;
      this.misses = 0;
    }
  }

  const cache = createCompileCache();
  const aliasReferenceRoots = new CountingMap<string, Set<string>>();
  cache.aliasReferenceRoots = aliasReferenceRoots;
  const modules = new Map([
    ["/project/lib.fig", "fn value() -> i32 { 1 }"],
  ]);
  const session = createCompilerSession({
    cache,
    includeWat: false,
    pruneImports: true,
    resolveModule: (moduleName) => {
      if (moduleName !== "./lib.fig") return undefined;
      return { text: modules.get("/project/lib.fig")!, sourceId: "/project/lib.fig" };
    },
  });
  const source = `
    const lib = @import("./lib.fig");
    pub fn main() -> i32 { lib.value() }
  `;
  const first = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(first.ok, true);
  aliasReferenceRoots.resetCounts();

  modules.set("/project/lib.fig", "fn value() -> i32 { 2 }");
  session.update({ sourceId: "/project/lib.fig", text: modules.get("/project/lib.fig")! });
  const second = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assert(aliasReferenceRoots.hits > 0);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.artifact.wasm));
  assertEquals((instance.exports.main as () => number)(), 2);
});

Deno.test("qualified declaration cache survives imported body-only edits", async () => {
  class CountingMap<K, V> extends Map<K, V> {
    hits = 0;
    misses = 0;

    override get(key: K): V | undefined {
      if (this.has(key)) this.hits++;
      else this.misses++;
      return super.get(key);
    }

    resetCounts() {
      this.hits = 0;
      this.misses = 0;
    }
  }

  const cache = createCompileCache();
  const qualifiedDeclarations = new CountingMap<string, unknown>();
  cache.qualifiedDeclarations = qualifiedDeclarations as typeof cache.qualifiedDeclarations;
  const modules = new Map([
    [
      "/project/lib.fig",
      `
        fn stable(x: i32) -> i32 { x * 2 }
        fn changed(x: i32) -> i32 { x + 1 }
        fn entry(x: i32) -> i32 { stable(x) + changed(x) }
      `,
    ],
  ]);
  const session = createCompilerSession({
    cache,
    includeWat: false,
    pruneImports: true,
    resolveModule: (moduleName) => {
      if (moduleName !== "./lib.fig") return undefined;
      return { text: modules.get("/project/lib.fig")!, sourceId: "/project/lib.fig" };
    },
  });
  const source = `
    const lib = @import("./lib.fig");
    pub fn main(x: i32) -> i32 { lib.entry(x) }
  `;
  const first = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(first.ok, true);
  qualifiedDeclarations.resetCounts();

  modules.set(
    "/project/lib.fig",
    `
        fn stable(x: i32) -> i32 { x * 2 }
        fn changed(x: i32) -> i32 { x + 2 }
        fn entry(x: i32) -> i32 { stable(x) + changed(x) }
      `,
  );
  session.update({ sourceId: "/project/lib.fig", text: modules.get("/project/lib.fig")! });
  const second = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assert(qualifiedDeclarations.hits > 0);
  assert(qualifiedDeclarations.misses > 0);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.artifact.wasm));
  assertEquals((instance.exports.main as (x: number) => number)(3), 11);
});

Deno.test("declaration reference summary cache survives imported body-only edits", async () => {
  class CountingMap<K, V> extends Map<K, V> {
    hits = 0;
    misses = 0;

    override get(key: K): V | undefined {
      if (this.has(key)) this.hits++;
      else this.misses++;
      return super.get(key);
    }

    resetCounts() {
      this.hits = 0;
      this.misses = 0;
    }
  }

  const cache = createCompileCache();
  const referenceSummaries = new CountingMap<string, unknown>();
  cache.referenceSummaries = referenceSummaries as typeof cache.referenceSummaries;
  cache.prunedImportSelections = undefined;
  const modules = new Map([
    [
      "/project/lib.fig",
      `
        fn stable(x: i32) -> i32 { x * 2 }
        fn changed(x: i32) -> i32 { x + 1 }
        fn entry(x: i32) -> i32 { stable(x) + changed(x) }
      `,
    ],
  ]);
  const session = createCompilerSession({
    cache,
    includeWat: false,
    pruneImports: true,
    resolveModule: (moduleName) => {
      if (moduleName !== "./lib.fig") return undefined;
      return { text: modules.get("/project/lib.fig")!, sourceId: "/project/lib.fig" };
    },
  });
  const source = `
    const lib = @import("./lib.fig");
    pub fn main(x: i32) -> i32 { lib.entry(x) }
  `;
  const first = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(first.ok, true);
  referenceSummaries.resetCounts();

  modules.set(
    "/project/lib.fig",
    `
        fn stable(x: i32) -> i32 { x * 2 }
        fn changed(x: i32) -> i32 { x + 2 }
        fn entry(x: i32) -> i32 { stable(x) + changed(x) }
      `,
  );
  session.update({ sourceId: "/project/lib.fig", text: modules.get("/project/lib.fig")! });
  const second = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assert(referenceSummaries.hits > 0);
  assert(referenceSummaries.misses > 0);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.artifact.wasm));
  assertEquals((instance.exports.main as (x: number) => number)(3), 11);
});

Deno.test("compiler session patches parsed imports for body-only function edits", async () => {
  const modules = new Map([
    [
      "/project/lib.fig",
      `
        fn changed(x: i32) -> i32 { x + 1 }
        fn stable(x: i32) -> i32 { x * 2 }
        fn entry(x: i32) -> i32 { stable(x) + changed(x) }
      `,
    ],
  ]);
  const session = createCompilerSession({
    includeWat: false,
    pruneImports: true,
    resolveModule: (moduleName) => {
      if (moduleName !== "./lib.fig") return undefined;
      return { text: modules.get("/project/lib.fig")!, sourceId: "/project/lib.fig" };
    },
  });
  const source = `
    const lib = @import("./lib.fig");
    pub fn main(x: i32) -> i32 { lib.entry(x) }
  `;
  const first = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(first.ok, true);

  modules.set(
    "/project/lib.fig",
    `
        fn changed(x: i32) -> i32 { x + 1000 }
        fn stable(x: i32) -> i32 { x * 2 }
        fn entry(x: i32) -> i32 { stable(x) + changed(x) }
      `,
  );
  session.update({ sourceId: "/project/lib.fig", text: modules.get("/project/lib.fig")! });
  const second = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(second.artifact.wasm));
  assertEquals((instance.exports.main as (x: number) => number)(3), 1009);
});

Deno.test("compiler session patches later functions after length-changing body edits", async () => {
  const modules = new Map([
    [
      "/project/lib.fig",
      `
        fn first(x: i32) -> i32 { x + 1 }
        fn later(x: i32) -> i32 { x * 2 }
        fn entry(x: i32) -> i32 { first(x) + later(x) }
      `,
    ],
  ]);
  const session = createCompilerSession({
    includeWat: false,
    pruneImports: true,
    resolveModule: (moduleName) => {
      if (moduleName !== "./lib.fig") return undefined;
      return { text: modules.get("/project/lib.fig")!, sourceId: "/project/lib.fig" };
    },
  });
  const source = `
    const lib = @import("./lib.fig");
    pub fn main(x: i32) -> i32 { lib.entry(x) }
  `;
  const first = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(first.ok, true);

  modules.set(
    "/project/lib.fig",
    `
        fn first(x: i32) -> i32 { x + 1000 }
        fn later(x: i32) -> i32 { x * 2 }
        fn entry(x: i32) -> i32 { first(x) + later(x) }
      `,
  );
  session.update({ sourceId: "/project/lib.fig", text: modules.get("/project/lib.fig")! });
  const second = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(second.ok, true);

  modules.set(
    "/project/lib.fig",
    `
        fn first(x: i32) -> i32 { x + 1000 }
        fn later(x: i32) -> i32 { x * 3 }
        fn entry(x: i32) -> i32 { first(x) + later(x) }
      `,
  );
  session.update({ sourceId: "/project/lib.fig", text: modules.get("/project/lib.fig")! });
  const third = await session.compileRoot({ sourceId: "/project/main.fig", text: source });
  assertEquals(third.ok, true);
  if (!third.ok) return;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(third.artifact.wasm));
  assertEquals((instance.exports.main as (x: number) => number)(3), 1012);
});

Deno.test("shared parsed import cache is reusable across import shapes", async () => {
  const cache = createCompileCache();
  const modules = new Map([
    ["/project/lib.fig", "fn value() -> i32 { 7 }"],
  ]);
  const resolveModule = (moduleName: string) => {
    if (moduleName !== "./lib.fig") return undefined;
    return { text: modules.get("/project/lib.fig")!, sourceId: "/project/lib.fig" };
  };
  const aliased = `
    const lib = @import("./lib.fig");
    pub fn main() -> i32 { lib.value() }
  `;
  const destructured = `
    const { value } = @import("./lib.fig");
    pub fn main() -> i32 { value() }
  `;

  for (
    const [sourceId, source] of [
      ["/project/aliased.fig", aliased],
      ["/project/destructured.fig", destructured],
      ["/project/aliased-again.fig", aliased],
    ] as const
  ) {
    const artifact = await compileArtifactsFromSource(source, {
      cache,
      includeWat: false,
      pruneImports: true,
      resolveModule,
      sourceId,
    });
    const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
    assertEquals((instance.exports.main as () => number)(), 7);
  }
});

Deno.test("compiler session passes importer context to nested relative imports", async () => {
  const seen: Array<[string, string | undefined]> = [];
  const session = createCompilerSession({
    includeWat: false,
    resolveModule: (moduleName, context) => {
      seen.push([moduleName, context?.fromSourceId]);
      if (moduleName === "./lib.fig") {
        return {
          sourceId: "/project/lib.fig",
          text: `
            const leaf = @import("./leaf.fig");
            fn value() -> i32 { leaf.value() }
          `,
        };
      }
      if (moduleName === "./leaf.fig" && context?.fromSourceId === "/project/lib.fig") {
        return { sourceId: "/project/leaf.fig", text: "fn value() -> i32 { 3 }" };
      }
      return undefined;
    },
  });

  const result = await session.compileRoot({
    sourceId: "/project/main.fig",
    text: `
      const lib = @import("./lib.fig");
      pub fn main() -> i32 { lib.value() }
    `,
  });
  assertEquals(result.ok, true);
  assert(
    seen.some(([moduleName, from]) => moduleName === "./leaf.fig" && from === "/project/lib.fig"),
  );
  assertEquals(session.watchedSourceIds("/project/main.fig"), [
    "/project/main.fig",
    "/project/lib.fig",
    "/project/leaf.fig",
  ]);
});

Deno.test("release_fast_compile profile compiles with fewer optimizer passes", async () => {
  assert(OPTIMIZE_PROFILES.release_fast_compile.abstract.maxPasses <= 2);
  const artifact = await compileArtifactsFromSource(
    `
      fn inc(x: i32) -> i32 { x + 1 }
      pub fn main(seed: i32) -> i32 { inc(seed) + inc(2) }
    `,
    { optMode: "release", profile: "release_fast_compile" },
  );
  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
  assertEquals((instance.exports.main as (seed: number) => number)(40), 44);
});

Deno.test("checker skips inferred specialization scans without inferred targets", async () => {
  const checked = await checkSource(
    `
      fn inc(x: i32) -> i32 { x + 1 }
      pub fn main() -> i32 { inc(1) }
    `,
    { trace: true },
  );
  const inferredPhases =
    checked.trace?.phases.filter((phase) => phase.name.startsWith("specializeInferredTypeCalls")) ??
      [];
  assert(inferredPhases.length > 0);
  assertEquals(inferredPhases.map((phase) => phase.specialization?.visitedCalls ?? 0), [0, 0, 0]);
  const constPhases =
    checked.trace?.phases.filter((phase) => phase.name.startsWith("specializeConstParamCalls")) ??
      [];
  assertEquals(constPhases.map((phase) => phase.specialization?.visitedCalls ?? 0), [0, 0]);
});

Deno.test("checker caches successful function checks but not failing checks", async () => {
  const cache = createCompileCache();
  const source = `
    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 { inc(1) }
  `;
  await checkSource(source, { cache });
  const cachedChecks = cache.functionChecks?.size ?? 0;
  assert(cachedChecks > 0);
  await checkSource(source, { cache });
  assertEquals(cache.functionChecks?.size, cachedChecks);

  const failingCache = createCompileCache();
  try {
    await checkSource(`pub fn main() -> i32 { fork(1) }`, { cache: failingCache });
    throw new Error("expected checkSource to fail");
  } catch (error) {
    assert(error instanceof Error);
  }
  assertEquals(failingCache.functionChecks?.size ?? 0, 0);
});

Deno.test("backend function cache reuses side-effect-free lowered functions", async () => {
  const cache = createCompileCache();
  const source = `
    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main(seed: i32) -> i32 { inc(seed) }
  `;
  await compileArtifactsFromSource(source, { cache, trace: true, includeWat: false });
  const compileTrace: CompileTraceEvent[] = [];
  await compileArtifactsFromSource(source, { cache, compileTrace, includeWat: false });
  const event = compileTrace.find((item) => item.name === "backend.lower.function_cache");
  assert(event);
  assert((event.counters?.cacheHits as number | undefined ?? 0) > 0);
});

Deno.test("wasm encoder cache reuses unchanged function bodies without stale edits", async () => {
  const cache = createCompileCache();
  const first = `
    fn inc(x: i32) -> i32 { x + 1 }
    fn pass(x: i32) -> i32 { x }
    pub fn main(seed: i32) -> i32 { pass(inc(seed)) }
  `;
  const second = `
    fn inc(x: i32) -> i32 { x + 2 }
    fn pass(x: i32) -> i32 { x }
    pub fn main(seed: i32) -> i32 { pass(inc(seed)) }
  `;
  await compileArtifactsFromSource(first, { cache, includeWat: false });
  await compileArtifactsFromSource(first, { cache, includeWat: false });
  const compileTrace: CompileTraceEvent[] = [];
  const artifact = await compileArtifactsFromSource(second, {
    cache,
    compileTrace,
    includeWat: false,
  });
  const event = compileTrace.find((item) => item.name === "wasm.encode.function_cache");
  assert(event);
  assert((event.counters?.cacheHits as number | undefined ?? 0) > 0);
  assert((event.counters?.cacheMisses as number | undefined ?? 0) > 0);
  const nameEvent = compileTrace.find((item) => item.name === "wasm.encode.name_section_cache");
  assert(nameEvent);
  assert((nameEvent.counters?.cacheHits as number | undefined ?? 0) > 0);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
  assertEquals((instance.exports.main as (seed: number) => number)(10), 12);
});

Deno.test("backend planning cache reuses literal-only edits without stale output", async () => {
  const cache = createCompileCache();
  const first = `
    fn inc(x: i32) -> i32 { x + 1 }
    fn pass(x: i32) -> i32 { x }
    pub fn main(seed: i32) -> i32 { pass(inc(seed)) }
  `;
  const second = `
    fn inc(x: i32) -> i32 { x + 2 }
    fn pass(x: i32) -> i32 { x }
    pub fn main(seed: i32) -> i32 { pass(inc(seed)) }
  `;
  const structural = `
    fn inc(x: i32) -> i32 { pass(x + 2) }
    fn pass(x: i32) -> i32 { x }
    pub fn main(seed: i32) -> i32 { pass(inc(seed)) }
  `;
  await compileArtifactsFromSource(first, { cache, includeWat: false });
  const literalTrace: CompileTraceEvent[] = [];
  const literalArtifact = await compileArtifactsFromSource(second, {
    cache,
    compileTrace: literalTrace,
    includeWat: false,
  });
  const literalEvent = literalTrace.find((item) => item.name === "backend.layout.plan_cache");
  assert(literalEvent);
  assertEquals(literalEvent.counters?.cacheHit, true);
  const literalInstance = new WebAssembly.Instance(new WebAssembly.Module(literalArtifact.wasm));
  assertEquals((literalInstance.exports.main as (seed: number) => number)(10), 12);

  const structuralTrace: CompileTraceEvent[] = [];
  const structuralArtifact = await compileArtifactsFromSource(structural, {
    cache,
    compileTrace: structuralTrace,
    includeWat: false,
  });
  const structuralEvent = structuralTrace.find((item) => item.name === "backend.layout.plan_cache");
  assert(structuralEvent);
  assertEquals(structuralEvent.counters?.cacheHit, false);
  const structuralInstance = new WebAssembly.Instance(
    new WebAssembly.Module(structuralArtifact.wasm),
  );
  assertEquals((structuralInstance.exports.main as (seed: number) => number)(10), 12);
});

Deno.test("debug optimizer fast path skips clone when no profile expressions need erasing", async () => {
  const compileTrace: CompileTraceEvent[] = [];
  const artifact = await compileArtifactsFromSource(
    `pub fn main() -> i32 { 1 }`,
    { compileTrace, includeWat: false },
  );
  const fastPath = compileTrace.find((item) => item.name === "opt.debug_fast_path");
  assert(fastPath);
  assertEquals(compileTrace.some((item) => item.name === "opt.clone"), false);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
  assertEquals((instance.exports.main as () => number)(), 1);
});

Deno.test("debug optimizer keeps profile erasure path when profiling is disabled", async () => {
  const compileTrace: CompileTraceEvent[] = [];
  const artifact = await compileArtifactsFromSource(
    `pub fn main() -> i32 { @profile("work") { 1 } }`,
    { compileTrace, includeWat: false },
  );
  assert(compileTrace.some((item) => item.name === "opt.clone"));
  assertEquals(compileTrace.some((item) => item.name === "opt.debug_fast_path"), false);
  assertEquals(artifact.profileSites, []);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
  assertEquals((instance.exports.main as () => number)(), 1);
});

Deno.test("backend function cache skips functions that emit debug trace sites", async () => {
  const cache = createCompileCache();
  const source = `
    pub fn main() -> i32 {
      @trace("main");
      1
    }
  `;
  await compileArtifactsFromSource(source, { cache, trace: true, includeWat: false });
  const compileTrace: CompileTraceEvent[] = [];
  await compileArtifactsFromSource(source, { cache, compileTrace, includeWat: false });
  const event = compileTrace.find((item) => item.name === "backend.lower.function_cache");
  assert(event);
  assertEquals(event.counters?.cacheHits ?? 0, 0);
  assert((event.counters?.skippedSideEffects as number | undefined ?? 0) > 0);
});

Deno.test("defaults unsuffixed integer literals in i32 contexts", async () => {
  const returned = await checkSource("pub fn main() -> i32 { 40 + 2 }");
  const main = returned.program.declarations.find((decl) => decl.kind === "fn");
  assertEquals(
    main?.kind === "fn" && main.body.expr?.kind === "binary" &&
      main.body.expr.left.kind === "literal"
      ? main.body.expr.left.inferredType
      : undefined,
    "i32",
  );

  const annotated = await checkSource("pub fn main() -> i32 { let x: i32 = 40; x }");
  const annotatedMain = annotated.program.declarations.find((decl) => decl.kind === "fn");
  assertEquals(
    annotatedMain?.kind === "fn" &&
      annotatedMain.body.statements[0]?.kind === "let" &&
      annotatedMain.body.statements[0].value.kind === "literal"
      ? annotatedMain.body.statements[0].value.inferredType
      : undefined,
    "i32",
  );

  await checkSource("pub fn main() -> i32 { 40i32 }");
});

Deno.test("checks bounded inline array indexing", async () => {
  const header = `
    type fn InlineArray(n: count, a: type) {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Index(n: count) -> type { i32(0..n) }
    type fn Lane4I32() -> type { InlineArray(4, i32) }
    type fn Lane8I32() -> type { InlineArray(8, i32) }
    type fn Lane8Alias() -> type { Lane8I32 }
    type fn Option(a: type) -> union {
      let None = {};
      let Some = {value: a};
      union(None, Some)
    }
    fn get(xs: Lane4I32, i: i32) -> Option(i32) { 0 }
  `;
  await checkSource(`${header} fn ok(xs: Lane4I32) -> i32 { xs[0] }`);
  await assertThrowsCompile(
    `${header} fn Bad(xs: Lane4I32) -> i32 { xs[4] }`,
    "index.out_of_bounds",
  );
  await checkSource(`${header} fn ok(xs: Lane4I32, i: Index(4)) -> i32 { xs[i] }`);
  await checkSource(`${header} fn ok_expr(xs: Lane4I32, i: i32(0..3)) -> i32 { xs[i + 1] }`);
  await checkSource(
    `${header} fn ok_const(const n: count, xs: InlineArray(n, i32), i: i32(0..n)) -> i32 { xs[i] }`,
  );
  await checkSource(`${header} fn ok(xs: Lane8Alias, i: Index(8)) -> i32 { xs[i] }`);
  await checkSource(`${header} fn subset(xs: Lane8Alias, i: Index(4)) -> i32 { xs[i] }`);
  await checkSource(`${header} fn checked(xs: Lane4I32, i: i32) -> Option(i32) { get(xs, i) }`);
  await checkSource(`${header} fn runtime(xs: Lane4I32, i: i32) -> i32 { xs[i] }`);
  await assertThrowsCompile(
    `${header} fn Bad(xs: Lane8Alias, i: Index(9)) -> i32 { xs[i] }`,
    "index.requires_proof",
  );
});

Deno.test("checks refined i32 scalar domains", async () => {
  const parsed = await parse(`type fn Small() -> type { i32(0..4 | 8) }`);
  const small = parsed.declarations[0];
  assert(small?.kind === "type");
  assertEquals(small.body.expr?.kind, "type_scalar_domain");

  await checkSource(`fn lit() -> i32(1 | 2 | 3) { 2 }`);
  await checkSource(`fn range_lit() -> i32(1 | 2..10 | 14) { 9 }`);
  await checkSource(`fn sparse(x: i32(0..4 | 8)) -> i32 { x }`);
  await checkSource(`fn widen(x: i32(0..4)) -> i32 { x }`);
  await checkSource(`fn subset(x: i32(0..4)) -> i32(0..10) { x }`);
  await checkSource(`fn const_bound(const n: count, x: i32(0..n)) -> i32 { x }`);
  await checkSource(
    `type fn Index(n: count) -> type { i32(0..n) } fn ok(const n: count, x: Index(n)) -> i32 { x }`,
  );
  await assertThrowsCompile(
    `fn bad(x: i32, y: i32(0..x)) -> i32 { y }`,
    "type.scalar_domain_endpoint",
  );
  await assertThrowsCompile(
    `fn bad(x: i32) -> i32 { let y: i32(0..x) = 0; y }`,
    "type.scalar_domain_endpoint",
  );
  await checkSource(`fn add_one(x: i32(0..4)) -> i32(1..5) { x + 1 }`);
  await checkSource(`fn mul_two(x: i32(0..4)) -> i32(0..8) { x * 2 }`);
  await checkSource(`fn rem_small(x: i32(0..16)) -> i32(0..4) { x % 4 }`);
  await assertThrowsCompile(`fn bad(x: i32) -> i32(0..4) { x }`, "type.literal_mismatch");
  await assertThrowsCompile(`fn bad(x: i32(5..8)) -> i32(0..4) { x }`, "type.literal_mismatch");
  await assertThrowsCompile(
    `fn bad(x: i32(0..4)) -> i32(2..5) { x + 1 }`,
    "type.literal_mismatch",
  );
  await assertThrowsCompile(`fn bad() -> i32(4..4) { 4 }`, "type.scalar_domain_empty");
  await assertThrowsCompile(`fn bad() -> i32(10..4) { 4 }`, "type.scalar_domain_empty");
  await assertThrowsCompile(
    `fn bad(const n: count) -> i32(n) { 0 }`,
    "type.scalar_domain_endpoint",
  );
  await assertThrowsCompile(`fn bad() -> i32() { 0 }`, "type.scalar_domain_syntax");
  await assertThrowsCompile(`fn bad() -> i32("x") { 0 }`, "type.scalar_domain_endpoint");
  await assertThrowsCompile(`fn bad() -> i64(0..4) { 0 }`, "type.scalar_domain_carrier");
  await assertThrowsCompile(`type fn Bad() -> type { 0..4 }`, "parse.syntax");
  await assertThrowsCompile(
    `type fn Vec(T: type) -> type { T } type fn Bad() -> type { Vec(0..4) }`,
    "parse.syntax",
  );
});

Deno.test("derives empty values for refined i32 domains containing zero", async () => {
  await checkSource(`pub fn main() -> i32(0..4) { @empty(i32(0..4)) }`);
});

Deno.test("canonicalizes refined i32 interval sets semantically", () => {
  const canonical = parseRefinedI32Type("i32(3 | 1 | 2 | 4..6 | 6 | 10..12 | 11..14)");
  assert(canonical);
  assertEquals(renderRefinedI32Domain(canonical), "i32(1..7 | 10..14)");

  const negative = parseRefinedI32Type("i32(0..2 | -2 | -1)");
  assert(negative);
  assertEquals(renderRefinedI32Domain(negative), "i32(-2..2)");

  assertEquals(refinedI32Assignable("i32(1..4)", "i32(1 | 2 | 3)"), true);
});

Deno.test("supports semantic refined i32 set operations", () => {
  const unionLeft = parseRefinedI32Type("i32(1..4)");
  const unionRight = parseRefinedI32Type("i32(4)");
  assert(unionLeft && unionRight);
  assertEquals(
    renderRefinedI32Domain(refinedI32DomainUnion(unionLeft, unionRight)),
    "i32(1..5)",
  );

  const intersectionLeft = parseRefinedI32Type("i32(0..4)");
  const intersectionRight = parseRefinedI32Type("i32(2..6)");
  assert(intersectionLeft && intersectionRight);
  assertEquals(
    renderRefinedI32Domain(refinedI32DomainIntersection(intersectionLeft, intersectionRight)),
    "i32(2..4)",
  );

  const differenceLeft = parseRefinedI32Type("i32(0..4)");
  const differenceRight = parseRefinedI32Type("i32(2)");
  assert(differenceLeft && differenceRight);
  const difference = refinedI32DomainDifference(differenceLeft, differenceRight);
  assert(difference);
  assertEquals(renderRefinedI32Domain(difference), "i32(0..2 | 3)");

  assertEquals(canonicalDomainKey(unionDomain(unionLeft, unionRight)), "i32(1..5)");
  assertEquals(
    canonicalDomainKey(intersectDomain(intersectionLeft, intersectionRight)),
    "i32(2..4)",
  );
  assertEquals(
    subtractDomain(differenceLeft, differenceRight) &&
      canonicalDomainKey(subtractDomain(differenceLeft, differenceRight)!),
    "i32(0..2 | 3)",
  );
  assertEquals(
    domainContains(parseRefinedI32Type("i32(0..4)")!, parseRefinedI32Type("i32(1..3)")!),
    true,
  );
  assertEquals(
    domainIsEmpty(
      intersectDomain(parseRefinedI32Type("i32(0..1)")!, parseRefinedI32Type("i32(2..3)")!),
    ),
    true,
  );
  assertEquals(cardinality(parseRefinedI32Type("i32(0 | 1..4 | 8)")!), 5);
});

Deno.test("narrows refined i32 domains from boolean control flow", async () => {
  await checkSource(`
    fn bounded(x: i32) -> i32(0..16) {
      if 0 <= x {
        if x < 16 { x } else { 0 }
      } else {
        0
      }
    }
  `);
  await checkSource(`
    fn false_branch(x: i32(0..8)) -> i32(4..8) {
      if x < 4 { 4 } else { x }
    }
  `);
  await checkSource(`
    fn not_equal_false_branch(x: i32(0..4)) -> i32(1..4) {
      if x == 0 { 1 } else { x }
    }
  `);
  await checkSource(`
    fn greater_branch(x: i32(0..8)) -> i32(5..8) {
      if x > 4 { x } else { 5 }
    }
  `);
  await assertThrowsCompile(
    `fn bad(x: i32) -> i32(0..16) { if x < 16 { x } else { 0 } }`,
    "type.literal_mismatch",
  );
});

Deno.test("checks finite refined i32 match coverage", async () => {
  await checkSource(`
    fn exhaustive(x: i32(0..3)) -> i32 {
      match x { 0 => 10, 1 => 20, 2 => 30 }
    }
  `);
  await checkSource(`
    fn fallback(x: i32(0..3)) -> i32 {
      match x { 0 => 10, _ => 20 }
    }
  `);
  await assertThrowsCompile(
    `
      fn missing(x: i32(0..3)) -> i32 {
        match x { 0 => 10, 1 => 20 }
      }
    `,
    "type.non_exhaustive_match",
  );
  await assertThrowsCompile(
    `
      fn unreachable(x: i32(0..3)) -> i32 {
        match x { 0 => 10, 1 => 20, 2 => 30, 3 => 40 }
      }
    `,
    "match.unreachable_arm",
  );
});

Deno.test("core Index is a refined i32 domain proof", async () => {
  await checkSource(
    `
      const core = @import("prelude.core");
      type fn InlineArray(n: count, a: type) {
        let InlineArray = {n*a};
        struct(InlineArray)
      }
      pub fn main(raw: i32, xs: InlineArray(16, i32)) -> i32 {
        match core.Index::try(16, raw) {
          Some(i) => xs[i],
          None => 0,
        }
      }
    `,
    { resolveModule: resolveProjectModule },
  );
  await checkSource(
    `
      const core = @import("prelude.core");
      fn narrow(raw: i32) -> i32(0..4) {
        match core.i32::try_domain(i32(0..4), raw) {
          Some(i) => i,
          None => 0,
        }
      }
    `,
    { resolveModule: resolveProjectModule },
  );
});

Deno.test("supports arbitrary unsigned integer widths with storage-lane packing", async () => {
  await checkSource(`
    pub fn one(x: u1) -> u1 { x }
    pub fn seven(x: u7) -> u7 { x }
    pub fn eight(x: u8) -> u8 { x }
    pub fn sixteen(x: u16) -> u16 { x }
    pub fn thirty_one(x: u31) -> u31 { x }
    pub fn thirty_two(x: u32) -> u32 { x }
    pub fn sixty_four(x: u64) -> u64 { x }
  `);

  await assertThrowsCompile("pub fn Bad(x: u0) -> u0 { x }", "type.unknown_type");
  await assertThrowsCompile("pub fn Bad(x: u65) -> u65 { x }", "type.unknown_type");

  const packedByte = await watFromSource(`
    type fn Pair() { let Pair = {a: u1, b: u7}; struct(Pair) }
    pub fn main(p: Pair) -> u7 { p.b }
  `);
  assertStringIncludes(packedByte, `(param $p$a$b i32)`);
  assertStringIncludes(packedByte, `i32.shr_u`);
  assertStringIncludes(packedByte, `i32.const 127`);
  assertStringIncludes(packedByte, `i32.and`);

  const packedNibbles = await watFromSource(`
    type fn Pair() { let Pair = {a: u4, b: u4}; struct(Pair) }
    pub fn main(p: Pair) -> Pair { p }
  `);
  assertStringIncludes(packedNibbles, `(param $p$a$b i32)`);
  assertStringIncludes(packedNibbles, `(result i32)`);

  const packedRefinedNibbles = await watFromSource(`
    type fn Pair() { let Pair = {a: i32(0..16), b: i32(0..16)}; struct(Pair) }
    pub fn main(p: Pair) -> Pair { p }
  `);
  assertStringIncludes(packedRefinedNibbles, `(param $p$a$b i32)`);
  assertStringIncludes(packedRefinedNibbles, `(result i32)`);

  const separateByteLanes = await watFromSource(`
    type fn Pair() { let Pair = {a: u7, b: u7}; struct(Pair) }
    pub fn main(p: Pair) -> Pair { p }
  `);
  assertStringIncludes(separateByteLanes, `(param $p$a i32) (param $p$b i32)`);
  assertStringIncludes(separateByteLanes, `(result i32) (result i32)`);

  const arrayLanes = await watFromSource(`
    type fn Lane4U7() -> type { let Lane = {4*u7}; struct(Lane) }
    pub fn main(xs: Lane4U7) -> Lane4U7 { xs }
  `);
  assertStringIncludes(
    arrayLanes,
    `(param $xs$0 i32) (param $xs$1 i32) (param $xs$2 i32) (param $xs$3 i32)`,
  );
  assertStringIncludes(arrayLanes, `(result i32) (result i32) (result i32) (result i32)`);

  const publicAbi = await watFromSource(`pub fn main(x: u7, y: u64) -> u7 { x }`);
  assertStringIncludes(publicAbi, `(param $x i32) (param $y i64) (result i32)`);
});

Deno.test("contract fn rewrite declarations parse with associated names and const templates", async () => {
  const program = await parse(`
    contract fn Option::bind_left_zero() -> rewrite {
      @assume(
        \\f -> Option::bind(Option::zero(), f),
        \\f -> Option::zero()
      )
    }

    contract fn MonadZero::bind_left_zero(
      const M: type fn(a: type) -> type
    ) -> rewrite {
      const proof = MonadZero(M);
      @assume(
        \\f -> M::bind(M::zero(), f),
        \\f -> M::zero()
      )
    }
  `);

  const concrete = program.declarations[0];
  assert(concrete?.kind === "contract");
  assertEquals(concrete.name, "Option::bind_left_zero");
  assertEquals(concrete.memberOf, { owner: "Option", member: "bind_left_zero" });
  assertEquals(concrete.resultKind, "rewrite");

  const generic = program.declarations[1];
  assert(generic?.kind === "contract");
  assertEquals(generic.params[0]?.name, "M");
  assertEquals(generic.params[0]?.const, true);
  assertEquals(generic.params[0]?.type, "type fn(a: type) -> type");
  assertEquals(generic.resultKind, "rewrite");
});

Deno.test("checkSource exposes contracts separately from runtime declarations", async () => {
  const checked = await checkSource(`
    contract fn add_zero_right() -> rewrite {
      @assume(
        \\x -> x + 0,
        \\x -> x
      )
    }

    pub fn main(x: i32) -> i32 { x + 0 }
  `);

  assert(checked.program.declarations.some((decl) => decl.kind === "contract"));
  assert(!checked.runtimeProgram.declarations.some((decl) => decl.kind === "contract"));
  assertEquals(checked.contracts.declarations.length, 1);
  assertEquals(checked.contracts.byName.get("add_zero_right")?.name, "add_zero_right");
});

Deno.test("contract fn rewrite validates context and rewrite-only type spelling", async () => {
  await assertThrowsCompile(
    `fn bad() -> rewrite { 0 }`,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `let x: rewrite = 0;`,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `fn bad() -> i32 { let x: rewrite = 0; x }`,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `type fn Bad() -> rewrite { i32 }`,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `fn bad() -> i32 { @assume(\\f -> f, \\f -> f) }`,
    "rewrite.assume_context",
  );
  await assertThrowsCompile(
    `contract fn bad(x: i32) -> rewrite { @assume(\\f -> f, \\f -> f) }`,
    "rewrite.param_must_be_const",
  );
  await assertThrowsCompile(
    `pub contract fn bad() -> rewrite { @assume(\\f -> f, \\f -> f) }`,
    "rewrite.public",
  );
  await assertThrowsCompile(
    `contract fn bad() -> rewrite { @assume(\\x -> M::pure(x), \\x -> g(x)) }`,
    "rewrite.assume_rhs_unknown",
  );
  await assertThrowsCompile(
    `contract fn bad() -> rewrite { @assume(\\x -> x, \\y -> y) }`,
    "rewrite.assume_template_params",
  );
  await assertThrowsCompile(
    `
    fn inc(x: i32) -> i32 { x + 1 }
    contract fn bad() -> rewrite { @assume(\\x -> inc(x), \\x -> true) }
    `,
    "rewrite.assume_result_type",
  );
  const wat = await watFromSource(`
    contract fn A::id() -> rewrite { @assume(\\x -> x, \\x -> x) }
    pub fn main() -> i32 { 1 }
  `);
  assert(!wat.includes("A::id"));
});

Deno.test("concrete assumed rewrites remove matching calls when enabled", async () => {
  const source = `
    type fn A() -> type { struct({value: i32}) }
    fn A::zero() -> i32 { 0 }
    fn A::bind(x: i32, f: fn(i32) -> i32) -> i32 { f(x) }
    contract fn A::bind_left_zero() -> rewrite {
      @assume(\\f -> A::bind(A::zero(), f), \\f -> A::zero())
    }
    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 { A::bind(A::zero(), inc) }
  `;
  const checked = await checkSource(source);

  const withoutAssumptions = optimizeProgram(checked.program);
  assertEquals(countCalls(withoutAssumptions).get("A::bind"), 1);

  const trace: import("../src/trace.ts").CompileTraceEvent[] = [];
  const withAssumptions = optimizeProgram(checked.program, { assumeRewrites: true, trace });
  const calls = countCalls(withAssumptions);
  assertEquals(calls.get("A::bind") ?? 0, 0);
  assertEquals(calls.get("A::zero"), 1);
  assert(
    trace.some((event) =>
      event.name === "rewrite.assume" &&
      event.counters?.action === "assume_rewrite" &&
      event.counters?.target === "main" &&
      event.counters?.reason === "A::bind_left_zero"
    ),
  );
  assertEquals(findFn(withAssumptions, "main")?.body.expr, {
    kind: "call",
    callee: { kind: "var", name: "A::zero" },
    args: [],
  });
});

Deno.test("generic assumed rewrites instantiate from proof constants", async () => {
  const source = `
    type fn A() -> type { struct({value: i32}) }
    type fn MonadZero(m: type fn(a: type) -> type) -> type { m }
    fn A::zero() -> i32 { 0 }
    fn A::pure(x: i32) -> i32 { x }
    fn A::bind(x: i32, f: fn(i32) -> i32) -> i32 { f(x) }
    contract fn MonadZero::bind_left_zero(
      const M: type fn(a: type) -> type
    ) -> rewrite {
      const proof = MonadZero(M);
      @assume(\\f -> M::bind(M::zero(), f), \\f -> M::zero())
    }
    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 {
      const proof = MonadZero(A);
      A::bind(A::zero(), inc)
    }
  `;
  const checked = await checkSource(source);
  const withAssumptions = optimizeProgram(checked.program, { assumeRewrites: true });

  const calls = countCalls(withAssumptions);
  assertEquals(calls.get("A::bind") ?? 0, 0);
  assertEquals(findFn(withAssumptions, "main")?.body.expr, {
    kind: "call",
    callee: { kind: "var", name: "A::zero" },
    args: [],
  });
});

Deno.test("generic assumed rewrites instantiate from do strategy proofs", async () => {
  const source = `
    type fn A(a: type) -> type { a }
    type fn Monad(m: type fn(a: type) -> type) -> type { m }
    fn A::zero() -> A(i32) { 0 }
    fn A::pure(x: i32) -> A(i32) { x }
    fn A::bind(x: A(i32), f: fn(i32) -> A(i32)) -> A(i32) { f(x) }
    contract fn Monad::bind_left_zero(
      const M: type fn(a: type) -> type
    ) -> rewrite {
      const proof = Monad(M);
      @assume(\\f -> M::bind(M::zero(), f), \\f -> M::zero())
    }
    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 {
      do @monad(A(_)) {
        A::bind(A::zero(), inc)
      }
    }
  `;
  const checked = await checkSource(source);
  const withAssumptions = optimizeProgram(checked.program, { assumeRewrites: true });

  const calls = countCalls(withAssumptions);
  assertEquals(calls.get("A::bind") ?? 0, 0);
  assertEquals(findFn(withAssumptions, "main")?.body.expr?.kind, "block");
});

Deno.test("generic law rewrites require matching proof", async () => {
  const source = `
    type fn Functor(t: type fn(a: type) -> type) -> type { t }
    fn identity(x: a) -> a { x }
    contract fn Functor::map_identity(const T: type fn(a: type) -> type) -> rewrite {
      const proof = Functor(T);
      @assume(\\x -> T::map(identity, x), \\x -> x)
    }
    fn use_law(x: t(a)) -> t(a) {
      const proof = Functor(t);
      t::map(identity, x)
    }
  `;
  const checked = await checkSource(source);

  const withAssumptions = optimizeProgram(checked.program, { assumeRewrites: true });
  assertEquals(findFn(withAssumptions, "use_law")?.body.expr, { kind: "var", name: "x" });

  await assertThrowsCompile(
    source.replace("      const proof = Functor(t);\n", ""),
    "type.member_requires_proof",
  );
});

Deno.test("generic law rewrites instantiate from const proof parameters", async () => {
  const checked = await checkSource(`
    type fn Box(a: type) -> type { let Box = {value: a}; struct(Box) }
    type fn Functor(t: type fn(a: type) -> type) -> type { t }
    fn identity(x: a) -> a { x }
    fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) { Box {value: f(v.value)} }
    contract fn Functor::map_identity(const T: type fn(a: type) -> type) -> rewrite {
      const proof = Functor(T);
      @assume(\\x -> T::map(identity, x), \\x -> x)
    }
    fn use_law(const _proof: Functor(Box), x: Box(i32)) -> Box(i32) {
      Box::map(identity, x)
    }
  `);
  const optimized = optimizeProgram(checked.program, { assumeRewrites: true });
  const useLaw = findFn(optimized, "use_law");
  assert(
    useLaw?.body.expr?.kind === "call" &&
      useLaw.body.expr.callee.kind === "var" &&
      useLaw.body.expr.callee.name.startsWith("Box__map__"),
  );
});

Deno.test("monad proof activates inherited functor law rewrites", async () => {
  const checked = await checkSource(`
    type fn Functor(t: type fn(a: type) -> type) -> type { t }
    type fn Applicative(t: type fn(a: type) -> type) -> type { t }
    type fn Monad(t: type fn(a: type) -> type) -> type { t }
    fn identity(x: a) -> a { x }
    contract fn Functor::map_identity(const T: type fn(a: type) -> type) -> rewrite {
      const proof = Functor(T);
      @assume(\\x -> T::map(identity, x), \\x -> x)
    }
    fn use_law(x: t(a)) -> t(a) {
      const proof = Monad(t);
      t::map(identity, x)
    }
  `);
  const optimized = optimizeProgram(checked.program, { assumeRewrites: true });
  assertEquals(findFn(optimized, "use_law")?.body.expr, { kind: "var", name: "x" });
});

Deno.test("monad proof activates inherited applicative law rewrites", async () => {
  const checked = await checkSource(`
    type fn Applicative(t: type fn(a: type) -> type) -> type { t }
    type fn Monad(t: type fn(a: type) -> type) -> type { t }
    contract fn Applicative::apply_pure(
      const T: type fn(a: type) -> type
    ) -> rewrite {
      const proof = Applicative(T);
      @assume(\\(f, x) -> T::apply(T::pure(f), x), \\(f, x) -> T::map(f, x))
    }
    fn use_law(const f: fn(x: a) -> b, x: t(a)) -> t(b) {
      const proof = Monad(t);
      t::apply(t::pure(f), x)
    }
  `);
  const optimized = optimizeProgram(checked.program, { assumeRewrites: true });
  assertEquals(findFn(optimized, "use_law")?.body.expr, {
    kind: "call",
    callee: { kind: "var", name: "t::map" },
    args: [{ kind: "var", name: "f" }, { kind: "var", name: "x" }],
  });
});

Deno.test("monad rewrites remove pure bind calls on both sides", async () => {
  const checked = await checkSource(`
    type fn Monad(t: type fn(a: type) -> type) -> type { t }
    contract fn Monad::bind_pure_left(const T: type fn(a: type) -> type) -> rewrite {
      const proof = Monad(T);
      @assume(\\(x, f) -> T::bind(T::pure(x), f), \\(x, f) -> f(x))
    }
    contract fn Monad::bind_pure_right(const T: type fn(a: type) -> type) -> rewrite {
      const proof = Monad(T);
      @assume(\\m -> T::bind(m, T::pure), \\m -> m)
    }
    fn left(x: a, const f: fn(x: a) -> t(b)) -> t(b) {
      const proof = Monad(t);
      t::bind(t::pure(x), f)
    }
    fn right(m: t(a)) -> t(a) {
      const proof = Monad(t);
      t::bind(m, t::pure)
    }
  `);
  const optimized = optimizeProgram(checked.program, { assumeRewrites: true });
  assertEquals(findFn(optimized, "left")?.body.expr, {
    kind: "call",
    callee: { kind: "var", name: "f" },
    args: [{ kind: "var", name: "x" }],
  });
  assertEquals(findFn(optimized, "right")?.body.expr, { kind: "var", name: "m" });
});

Deno.test("monoid rewrites remove empty append calls on both sides", async () => {
  const checked = await checkSource(`
    type fn Point() -> type { let Point = {x: i32}; struct(Point) }
    type fn Monoid(t: type) -> type { t }
    fn Point::empty() -> Point { Point {x: 0} }
    fn Point::append(a: Point, b: Point) -> Point { Point {x: a.x + b.x} }
    contract fn Monoid::append_empty_left(const T: type) -> rewrite {
      const proof = Monoid(T);
      @assume(\\x -> T::append(T::empty(), x), \\x -> x)
    }
    contract fn Monoid::append_empty_right(const T: type) -> rewrite {
      const proof = Monoid(T);
      @assume(\\x -> T::append(x, T::empty()), \\x -> x)
    }
    pub fn main(x: Point) -> Point {
      const proof = Monoid(Point);
      let left = Point::append(Point::empty(), x);
      Point::append(left, Point::empty())
    }
  `);
  const optimized = optimizeProgram(checked.program, { assumeRewrites: true });
  assertEquals(countCalls(optimized).get("Point::append") ?? 0, 0);
  const main = findFn(optimized, "main");
  const left = main?.body.statements.find((stmt) => stmt.kind === "let" && stmt.name === "left");
  assertEquals(left?.kind === "let" ? left.value : undefined, { kind: "var", name: "x" });
  assertEquals(main?.body.expr, { kind: "var", name: "left" });
});

Deno.test("prelude functor rewrite works through namespaced imports", async () => {
  const checked = await checkSource(
    `
    const fun = @import("prelude.function");

    fn use_law(x: t(a)) -> t(a) {
      const proof = fun.Functor(t);
      t::map(fun.identity, x)
    }
    `,
    { resolveModule: resolveProjectModule },
  );
  const optimized = optimizeProgram(checked.program, { assumeRewrites: true });
  assertEquals(findFn(optimized, "use_law")?.body.expr, { kind: "var", name: "x" });
});

async function assertThrowsCompile(
  source: string,
  code: string,
  options?: Parameters<typeof checkSource>[1],
) {
  try {
    await checkSource(source, options);
  } catch (error) {
    if (error instanceof CompileError) {
      assert(
        error.diagnostics.some((diagnostic) => diagnostic.code === code),
        JSON.stringify(error.diagnostics),
      );
      return;
    }
    throw error;
  }
  throw new Error(`expected ${code}`);
}

function findFn(program: Program, name: string): FnDecl | undefined {
  return program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === name
  );
}

function findFns(program: Program, name: string): FnDecl[] {
  return program.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === name
  );
}

function maxBinaryDepth(expr: Expr, op: string): number {
  if (expr.kind !== "binary" || expr.op !== op) return 0;
  return 1 + Math.max(maxBinaryDepth(expr.left, op), maxBinaryDepth(expr.right, op));
}

function countCalls(
  program: Program,
  options: { includeGenerated?: boolean } = {},
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      if (options.includeGenerated === false && decl.generated) continue;
      countExprCalls(decl.body, counts);
    } else if (decl.kind === "let" || decl.kind === "const") countExprCalls(decl.value, counts);
  }
  return counts;
}

function countExprCalls(expr: Expr, counts: Map<string, number>) {
  switch (expr.kind) {
    case "call":
      if (expr.callee.kind === "var") {
        counts.set(expr.callee.name, (counts.get(expr.callee.name) ?? 0) + 1);
      }
      countExprCalls(expr.callee, counts);
      for (const arg of expr.args) countExprCalls(arg, counts);
      return;
    case "index":
      countExprCalls(expr.target, counts);
      countExprCalls(expr.index, counts);
      return;
    case "binary":
      countExprCalls(expr.left, counts);
      countExprCalls(expr.right, counts);
      return;
    case "match":
      countExprCalls(expr.value, counts);
      for (const arm of expr.arms) countExprCalls(arm.value, counts);
      return;
    case "shape":
      for (const slot of expr.slots) countExprCalls(slot.value, counts);
      return;
    case "range":
      countExprCalls(expr.start, counts);
      countExprCalls(expr.end, counts);
      return;
    case "block":
      for (const stmt of expr.statements) {
        if (stmt.kind === "let") countExprCalls(stmt.value, counts);
      }
      if (expr.expr) countExprCalls(expr.expr, counts);
      return;
    case "literal":
    case "var":
      return;
  }
}

function countExprRefs(expr: Expr, name: string): number {
  switch (expr.kind) {
    case "var":
      return expr.name === name ? 1 : 0;
    case "call":
      return countExprRefs(expr.callee, name) +
        expr.args.reduce((sum, arg) => sum + countExprRefs(arg, name), 0);
    case "index":
      return countExprRefs(expr.target, name) + countExprRefs(expr.index, name);
    case "binary":
      return countExprRefs(expr.left, name) + countExprRefs(expr.right, name);
    case "operator_chain":
      return countExprRefs(expr.first, name) +
        expr.rest.reduce((sum, item) => sum + countExprRefs(item.value, name), 0);
    case "pipe_bind":
      return countExprRefs(expr.value, name) + countExprRefs(expr.body, name);
    case "match":
      return countExprRefs(expr.value, name) +
        expr.arms.reduce((sum, arm) => sum + countExprRefs(arm.value, name), 0);
    case "shape":
    case "product_constructor":
      return expr.slots.reduce(
        (sum, slot) =>
          sum + (slot.index ? countExprRefs(slot.index, name) : 0) +
          countExprRefs(slot.value, name),
        0,
      );
    case "static_for_slots":
      return countExprRefs(expr.value, name) +
        (expr.source.kind === "range"
          ? countExprRefs(expr.source.start, name) + countExprRefs(expr.source.end, name)
          : countExprRefs(expr.source.shape, name));
    case "field":
      return countExprRefs(expr.value, name) + countExprRefs(expr.key, name);
    case "range":
      return countExprRefs(expr.start, name) + countExprRefs(expr.end, name);
    case "block":
      return expr.statements.reduce(
        (sum, stmt) =>
          stmt.kind === "proof_const"
            ? sum
            : stmt.kind === "debug_trace"
            ? sum + stmt.args.reduce((total, arg) => total + countExprRefs(arg, name), 0)
            : sum + countExprRefs(stmt.value, name),
        expr.expr ? countExprRefs(expr.expr, name) : 0,
      );
    case "do":
      return expr.statements.reduce(
        (sum, stmt) =>
          stmt.kind === "proof_const"
            ? sum
            : stmt.kind === "debug_trace"
            ? sum + stmt.args.reduce((total, arg) => total + countExprRefs(arg, name), 0)
            : sum + countExprRefs(stmt.value, name),
        expr.expr ? countExprRefs(expr.expr, name) : 0,
      );
    case "const_fn":
      return countExprRefs(expr.body, name);
    case "profile":
      return expr.args.reduce((sum, arg) => sum + countExprRefs(arg, name), 0) +
        countExprRefs(expr.body, name);
    case "literal":
      return 0;
  }
}
