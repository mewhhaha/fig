# Codex Agent Operating Guide

## WebAssembly Target

- Target WebAssembly 3.0 features that are supported by current browser engines and Deno.
- Browser compatibility means Chromium- and Firefox-family engines; Safari/WebKit support is not
  required unless a task explicitly asks for it.
- Prefer features that are available in both browsers and Deno over proposal-only or engine-specific
  behavior.
- When implementing, testing, or documenting backend behavior, treat the browser + Deno supported
  subset as the default portability target.
