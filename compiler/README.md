# Fig Compiler Rewrite

This tree is the in-progress Fig-source rewrite of the compiler. The current boundary is the
front-end data model: spans, source text, module graph records, a resolver/cache layer, token kinds,
a typed lexer cursor/result model, a prelude-backed heap-array source/text-token lexer with typed
punctuation tokens that exercises compact annotated value and typed function source programs, a
source-token declaration parser path for annotated `let`/`const` declarations and compact
typed-parameter function signatures with compact call-expression bodies, a typed source-backed
program parser with diagnostic-bearing program frames, a fixed generated token stream, a compact AST
model, parser-combinator primitives, typed annotation unions with parser results for named and
single-arg applied annotations, typed expression/declaration/program parse results, a diagnostic
accumulator, a checked-program pipeline that threads declaration environments across parsed program
items, a lowered-program pipeline that preserves typed declaration lowering records and merged
diagnostics, a checker environment with explicit symbol/type state, a declaration/type dependency
graph, a small lowering/ABI boundary, a type-safe declaration and program Wasm IR/emission boundary
with compact section/binary serialization records, a front-end summary path, a compile artifact
table, and an incremental cache/invalidation model that compile through the existing TypeScript
compiler.

The rewrite should use a functional style where it helps correctness:

- Pass parser/checker state explicitly instead of mutating global compiler state.
- Prefer `Parser(a)`, `Reply(a)`, `ParseError`, and other union/product pairs over ad hoc status
  integers.
- Compose front-end steps through `map`, `bind`, `apply`, and small pure helpers.
- Keep context-specific grammar, summary, and import behavior behind focused modules such as
  `textgrammar.fig`, `textsummary.fig`, and `textimportsummary.fig`; avoid encoding module
  ownership into every helper name inside `parser.fig`.
- Put shared scanner and summary invariants in `textmodel.fig`: summary modes are enums, import
  resolution modes are enums, and declaration/window boundaries use typed records instead of loose
  `i32` pairs. Keep hot recursive scan structs scalar-backed until imported alias fields are proven
  stable in compiled recursion; expose typed helpers at the module boundary first.
- Keep performance visible by compiling this source tree in the benchmark after each larger module
  is added.

The benchmark goal is to compare:

- `deno/js`: this Fig compiler source compiled by the current TypeScript compiler.
- `deno/fig`: this Fig compiler source compiled to Wasm, then executed from Deno as a compiled
  slice. Use `--fig-wasm-opt=debug` to track the straightforward backend path and
  `--fig-wasm-opt=release` to track the optimized runtime path.
- `go`: a matching Go front-end model used as the Go comparison leg while the Fig rewrite grows.

Run the source comparison with:

```sh
deno task bench:compiler-sources
```

The `deno/fig` row first validates parsed declaration totals, declaration-kind counts, function
parameter totals, type-parameter totals, a stable declaration signature hash, and function/type
parameter signature hashes against the `deno/js` parser before timing the compiled slice. It also
checks type result-kind counts, normalized function parameter type signatures, function return
signatures, and top-level value annotation signatures so annotation parsing drift is caught before
timing. Function and type-sugar body signatures are also checked from normalized source spans, which
keeps the compiled Fig scanner honest as expression and type-body parsing grows. The same preflight
counts top-level function local `let` statements, lowered type-sugar statements, and value-context
`match`, `do`, and pipe-bind expressions, value match arms, plus function match-body declarations,
to keep block/type-block statement discovery and expression-shape discovery aligned with the JS
parser, including whole value-expression operator-link totals and source-order operator
signatures. It also checks a conservative declared type-class signature for primitive returns,
primitive value annotations, function declarations, and type result kinds as the first checked-shape
parity gate, then maps that declared shape into scalar/function/handle/void ABI classes as the
first lowering-boundary parity gate. It combines declaration names, declared type classes, and ABI
classes into a symbol-environment signature, and checks public function export ABI summaries so
export/lowering drift is caught before timing. A conservative value-body type-class and ABI-class
signature now covers simple literal, function, record, and product-constructor bodies while leaving
calls, matches, pipes, and dependent forms unknown until the checked expression model is richer.
The harness also records resolved value-body type and ABI classes for simple identifier returns from
function parameters and top-level declarations. A simple body type-check signature then compares
declared return/annotation classes with those resolved body classes, giving the rewrite a first
diagnostics-oriented mismatch gate. Same-module named declarations now form a small type environment
so resolved signatures can classify
annotations such as `Span`, `TokenView`, `SymbolId`, or `TextParser(a)` as product, scalar, or
function-shaped without needing full cross-module type evaluation yet. The same resolved view feeds
ABI, symbol-environment, and export summaries so lowering-boundary drift is caught alongside
front-end type-shape drift. A typed declaration-facts layer then combines the resolved declaration
type shape, resolved body type shape, diagnostics-oriented type-check shape, and lowered ABI/export
shape into checked declaration, checked diagnostic, and lowered declaration signatures. Those facts
are intentionally derived from typed summary modes rather than ad hoc benchmark counters, so they
form a stable parity boundary while the real checked program and lowering records grow. The same
layer now scans each declaration into a typed checked declaration record that keeps the declaration
kind, binding name, resolved symbol type, expected body type, resolved body type, check status,
diagnostic code, and lowered ABI class in one per-declaration hash. That catches drift where
separate aggregate totals would still agree but the checked/lowered facts no longer belong to the
same source declaration.
It also scans each declaration into a checked expression record with the declaration kind, binding
name, stable lexical expression-head kind/hash, root child count, root child signature, root
grandchild count, root grandchild signature, full root-descendant count/signature, root expression
type class, resolved expression type class, expected type class, check status, diagnostic code, and
lowered value class. Child, grandchild, and descendant signatures cover call arguments and
record/product slots by mixing each nested root's kind, head hash, and simple type class in source
order. The expression head is intentionally conservative: it records simple literal, identifier,
constructor, shape, match/do, and const-function starts while leaving unsupported grouped or
collection starts as unknown. The semantic type and lowering fields remain the checked parity
boundary while richer expression-tree facts grow.
Root children also have their own checked child-record signature now: each call argument,
record/product slot, explicit match scrutinee, match guard, or match-arm result under the
declaration root is tied back to the parent declaration kind/name, preorder child index, child role,
slot label hash when present, child root kind/hash/type class, child child count, and child
descendant count. The record scan recurses through nested call arguments, record/product slots,
pipe-bind bodies, explicit match scrutinees, match guards, match-arm result values, and do-block
value segments, so the aggregate child signatures are now backed by individual facts for nested
expression children as well as direct root children, pipe-bind segments, match arms, and do
bind/expression/final values.
Function block locals now have their own checked local-environment record as well: each top-level
local `let` or proof `const` is tied back to the owning function name, local binding name, stable
value expression-head kind/hash, expected type class, value type class, simple check status, and
diagnostic code. This moves local block parity beyond raw statement counts and catches drift where
locals are found but attached to the wrong function, rooted in the wrong expression, diagnosed
differently, or classified differently.
Expression-shape discovery is also recorded per declaration now: the checked expression-shape record
ties each binding name to its stable root expression-head kind/hash, root selector count for
qualified heads, root slot count when the head is a record or product constructor, root call arity
when the head is a call, root field-postfix count after root calls, root operator-link count,
whole-expression operator-link count, whole-expression operator signature, value-context `match`,
match-arm, `do`, do-bind, pipe-bind, call, and
function match-body counts, whole-expression name/literal token counts and signatures, plus the
resolved diagnostic code for the declaration's simple body check. The older whole-program counters
remain as quick summary gates, while the record hash proves those expression-shape counts still
belong to the same declaration, expression head, and diagnostic outcome.
Public export lowering now has a per-export record too, tying each exported function name to its
runtime parameter count and resolved return ABI class. This keeps the aggregate export ABI summary
but also proves the lowered export shape is attached to the expected public function.
The next Wasm-facing parity record is per function rather than only per public export: it ties each
function name to its export tag, runtime parameter count, local-let count, result valtype, first
body opcode/immediate, terminator opcode, compact body size, and simple diagnostic code. This is
still a compact record boundary, not full byte emission, but it proves the compiled Fig source can
derive a stable Wasm function shape from checked/lowered facts before the byte serializer is made
complete. A module-level Wasm section record now groups those function facts into compact type,
function, export, and code section facts as well: each section carries its item count, payload size,
payload signature, and diagnostic signature. That extends parity from per-function lowering into
the section table shape that the eventual byte serializer will emit. A byte-level Wasm record now
reuses those section facts to account for the module header, section ids, ULEB payload-size headers,
per-section byte sizes, and whole-module byte size/signature. The compact Wasm byte model is also
exposed as a returned `HeapArray(i32)` byte buffer through the compiled Fig slice and compared
byte-for-byte against the JS parity model.

The blocker found during the first returned byte-buffer attempt was a general backend issue:
product-valued field projections such as `let name_span = token.span` were inferred as one scalar
local instead of all flattened fields, leaving extra values on the Wasm stack and corrupting the
heap-array writer. The backend now infers product field expression types before lowering local lets,
so the minimal source `pub fn main() -> i32 { 1 }` emits the expected export payload prefix
`1, 4, 109, 97, 105, 110, 0, 0`.
Direct source imports also get a two-source preflight: the compiled Fig slice receives the importer
and imported module source, finds the import alias, and checks the imported module's named type
environment under that alias against the JS parser. That imported environment now also feeds
qualified annotation summaries, so declared type and ABI signatures can classify names such as
`span.Span`, `ast.Decl`, and `layout.HeapArray(i32)` before full cross-module checking is in place.
The import path now has a direct import resolution record as well, combining the module hash, alias
hash, imported type-environment signature, qualified resolved declared type/ABI signatures, and
qualified resolved value-body type/ABI signatures, qualified simple body type-check signature,
qualified resolved symbol-environment signature, and qualified resolved export ABI signature. That
keeps the individual two-source checks while also proving they belong to the same import edge.

This is not yet a self-hosting compiler. Keep adding compiler subsystems here as direct Fig source
instead of generated benchmark filler. The compiler source may import prelude modules when that
keeps the implementation idiomatic and type-safe; the benchmark includes those sources in the Fig
LOC/resolution set. The `deno/fig` benchmark row is intentionally honest: it reports
`compiled_source_tree_unavailable` when the emitted module cannot instantiate. Large repeated
compiler payloads should be summarized through typed compiler records, such as artifact summaries
inside incremental caches, instead of pushing full AST/check/lowering trees through every cache
state. If release-only failures reappear, fix them as general backend stack-shape/inlining or
optimizer stack-depth issues, not benchmark-specific shortcuts.

The source model should remain very type-safe as it grows:

- Model syntax, tokens, diagnostics, checked values, lowering values, and Wasm IR as unions and
  structs with explicit constructors.
- Use function match bodies and ordinary `match` expressions to make state transitions and payload
  handling exhaustive.
- Prefer typed result values such as `Parser(a)`, `Reply(a)`, and diagnostic-bearing structs over
  unstructured sentinel integers.
- Use prelude collection layouts, including heap arrays, for variable-length compiler data instead
  of fixed numbered fields.
- Keep hot scanners as direct tail-recursive loops with explicit `rec(...)` where the current
  backend must produce Wasm loops. Avoid `scan -> scan_next -> scan` mutual-recursion shapes in hot
  source walks until mutual tail calls are a deliberate language/backend feature.
- Use prelude functional data types such as `Option(a)` rather than local one-off `MaybeI32`-style
  helpers when the current import/parity harness can compile the path; add local wrappers only when
  they name compiler-specific intent.
- Prefer applicative parser composition where the shape is regular, while keeping direct matching
  where it makes diagnostics and recovery clearer.
- Keep numeric scores and checksums as benchmark-visible summaries of typed structures, not as a
  replacement for typed compiler data.
- Send large `HeapArray(i32)` benchmark inputs through `createFigHost.call` rather than benchmark
  raw-handle caches. The host call path restores temporary ABI arena allocations after decoding
  results, so repeated source-tree parity checks do not leak handles while still exercising the
  public memory ABI used by external callers.

Current parity status:

- The semantic Wasm body-byte slice now resolves small scalar and bool literal bodies through typed
  `core.Option(i32)` results, and emits `local.get` for scalar function bodies that return an exact
  runtime parameter or simple local `let`. Wasm function and section record signatures use the same
  semantic body instruction selection as the returned byte buffer, so opcode/immediate facts cannot
  drift from emitted bytes. Non-niche option-like unions preserve tags and zero payloads across
  constructors, pattern matches, and the stable memory ABI.
- Resolved value-body type summaries now classify bare same-module function calls such as `f(...)`
  from the callee return annotation, including direct-import summaries with imported qualified type
  annotations. The first pass intentionally excludes qualified/member calls, pipe-bind expressions,
  operator chains, and field projections so it matches the current AST root shape exactly.
- The semantic Wasm byte-buffer slice now emits real instruction tapes for bare same-module scalar
  calls when every argument is a locally proven scalar literal, runtime parameter, local `let`,
  single scalar-operator expression, or nested same-module scalar call and the callee arity/index
  fit the current compact immediate model. The body facts keep the first instruction and byte size
  as compact records while the returned byte buffer writes the same lowered instruction tape.
- Simple single-operator scalar function bodies now participate in the same path. When a body is a
  single top-level `+`, `-`, `*`, `/`, `%`, comparison, or equality operator and both operands are
  locally proven scalar expressions, including nested scalar calls, the Fig-source compiler resolves
  the result type and emits the operand instruction tapes followed by the corresponding Wasm i32
  opcode. Product field projections and richer expression operands are intentionally left for later
  semantic lowering.
- Bare same-module scalar calls now also accept locally proven scalar `let` arguments, not only
  runtime parameters and literals. Local arguments are lowered with the correct Wasm local index
  when the binding is scalar by annotation or by a simple scalar initializer such as a literal,
  runtime-parameter alias, or single scalar operator expression.
- Scalar top-level local `let` initializers now participate in the emitted instruction tape when
  every local initializer in the function is supported by the current scalar lowerer. The byte
  model prefixes those initializer instructions with `local.set` before the final body expression,
  keeping the function facts and returned Wasm byte buffer aligned.
- Resolved body-type facts now recognize final scalar local identifiers, scalar body operators over
  those locals, and scalar locals whose initializers are literals, parameter aliases, simple scalar
  operators, or bare same-module scalar calls. Scalar operator type facts now recurse through nested
  scalar operators and bare scalar calls, matching the semantic byte-lowering operand subset.
  Direct-import resolved summaries use the same local facts with import-aware annotation and
  call-return resolution.
- Wasm body plans are now backed by a `HeapArray(WasmBodyInstruction)` instead of fixed numbered
  prefix fields, so simple scalar operands can expand to multiple emitted instructions without
  changing the byte-buffer or fact-record path.
- Code-section byte records now encode function local declarations as real Wasm local declaration
  vectors instead of placeholder zero bytes, with body and code-entry sizes derived from the emitted
  ULEB lengths.
- The Fig-source lexer skips whitespace and `//` line comments before tokenizing, so imported
  prelude modules with leading comments participate in source-import summaries.
- The compiled Fig-source compiler currently passes the source-tree parity benchmark in debug mode
  for the checked summary and Wasm byte-buffer slice. The previous direct-import resolved
  value-body blocker in `textfacts.fig` was a backend bug: pipe-bound sum values stored their tag in
  flattened locals such as `$punctuation$tag`, while later `match punctuation` reads did not know
  the bound variable's sum type and fell back to `$punctuation`. Pipe-bind lowering now threads the
  bound value type into the body context, so recursive scanners can match pipe-bound union values.

The next useful additions are:

1. Continue replacing compact Wasm body placeholders with semantically lowered instruction bytes for
   a broader expression subset, such as simple calls and scalar operators, while keeping the
   returned byte-buffer parity gate.
2. A richer declaration graph with cross-module import edges and cycle diagnostics.
3. Incremental artifact invalidation against full module graphs and import edges.
4. Stable serialized compiler artifacts that can survive process restarts.
