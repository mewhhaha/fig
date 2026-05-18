# Codex Agent Operating Guide

## WebAssembly Target

- Target WebAssembly 3.0 features that are supported by current browser engines and Deno.
- Browser compatibility means Chromium- and Firefox-family engines; Safari/WebKit support is not
  required unless a task explicitly asks for it.
- Prefer features that are available in both browsers and Deno over proposal-only or engine-specific
  behavior.
- When implementing, testing, or documenting backend behavior, treat the browser + Deno supported
  subset as the default portability target.

## Compiler Generality

- Fig is a general-purpose programming language. Do not add compiler, checker, optimizer, backend,
  parser, formatter, or LSP behavior that is specific to ECS, rendering, audio, games, examples,
  benchmarks, fixture names, or any other particular application/library domain.
- Do not tune compiler behavior to recognize project source-code names such as `engine.ecs`,
  `web.canvas`, `SparseWorld`, `ComponentSlot`, benchmark helper names, or example-specific APIs. If
  a feature needs to work, express it through general language semantics, type reflection,
  contracts, plugins, intrinsics with domain-neutral names, or ordinary library code.
- Benchmarks and examples may motivate improvements, but the implementation must be a reusable
  language/compiler capability with neutral tests that demonstrate the general rule. Domain-specific
  tests belong in the library/example layer and must not require hardcoded compiler knowledge.
- If a change seems to require a domain-specific compiler shortcut, stop and redesign the surface so
  the library can state the requirement through existing general levers or a new general-purpose
  mechanism.

## Fig Syntax

- Fig does not support `|>` pipeline syntax. Continue value-flow segments with pipe-bind syntax such
  as `expr \x -> next_expr`, or `expr \$ -> use($)` when using the placeholder form.
