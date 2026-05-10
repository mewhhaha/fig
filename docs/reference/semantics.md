# Fig Semantics

## Ownership

Fig tracks moves for Values. Passing a value to a function consumes it unless the operation is known
to borrow it. Reusing a moved local is rejected. Memory load intrinsics borrow the memory argument;
stores consume and return memory.

Call-scoped borrows use `&value` with a parameter type written `&(t)`. a borrowed argument is not
moved by the call, but the borrowed value cannot be stored, returned, or accepted as an owned
parameter.

`fork(local)` consumes a local variable and creates multiple owned copies through multi-bind.
Forking an unknown name or a non-local expression is rejected.

Frozen values use frozen types such as `#(t)` and frozen literals such as `#[1, 2, 3]`. Frozen
values are immutable and are checked against their frozen expected type.

## Effects

Effect rows are written as:

```fig
fn pure() -> i32 !{} { 1 }
fn uses_clock() -> i32 !{time} { clock() }
```

An effectful call is rejected unless the caller's effect row covers the callee effects. Host
capabilities declare their effects in the function type used by `@capability`.

## Const Evaluation and Reflection

Top-level constants, type-function bodies, const parameters, local proof consts, and static builtins
are evaluated at compile time. Static reflection exposes product slots, sum variants, attached
members, shape transforms, and selected WGSL metadata.

Compile-time expressions are intentionally smaller than runtime expressions. `fork` is not
const-evaluable or type-evaluable, and unsupported static forms report focused diagnostics.

Static slots in records and product constructors evaluate a compile-time shape and generate one
field per key. Static `for` statement blocks and array-comprehension-style `[for ...]` literals are
rejected.

## WebAssembly Target

Fig targets WebAssembly 3.0 features supported by current Chromium- and Firefox-family engines and
Deno. Safari/WebKit support is not required unless a task explicitly asks for it.

Prefer the browser and Deno supported subset when adding backend behavior. Heap-backed growable
collections and allocation-backed append APIs are intentionally not part of the current standard
prelude. Use fixed inline arrays, explicit memory tokens, and host capabilities for lower-level
work.
