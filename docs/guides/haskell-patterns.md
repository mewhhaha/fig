# Haskell Patterns in Fig

This guide maps common Haskell idioms to Fig. Fig deliberately borrows several ideas from functional
programming, but it is strict, explicit, and WebAssembly-oriented. There is no implicit typeclass
search, no lazy evaluation by default, no general currying, and no hidden runtime dictionary passing
unless you write values that behave that way.

The practical rule is:

- Haskell data declarations become Fig `struct` and `union` types.
- Typeclasses become `type fn` contracts plus attached members.
- Typeclass dictionaries become erased `const _proof` parameters or transparent annotations.
- Higher-kinded constraints use type constructor parameters.
- `fmap`, `<$>`, `<&>`, `<*>`, `<**>`, `>>=`, `=<<`, `>=>`, `<=<`, and `do`
  are available through explicit contracts and do strategies.
- Effects are ordinary typed values handled by explicit runners.

## Algebraic Data Types

Haskell:

```haskell
data Maybe a = Nothing | Just a
```

Fig:

```fig
type Option(a) = union {
  None,
  Some(value: a)
}
```

Pattern matching is expression-oriented:

```fig
fn unwrap_or(value: Option(i32), fallback: i32) -> i32 {
  match value {
    Some(inner) => inner,
    None => fallback,
  }
}
```

Product types can use declaration sugar:

```fig
type Point = struct {x: i32, y: i32}
```

Computed product types use `type fn`:

```fig
type fn Pair(a: type, b: type) -> struct {
  let Pair = {first: a, second: b};
  struct(Pair)
}
```

## Typeclasses as Contracts

Haskell:

```haskell
class Eq a where
  eql :: a -> a -> Bool
```

Fig:

```fig
type fn Eq(t: type) -> type {
  let Expected = fn(a: t, b: t) -> bool;
  @require(@type_has_member(t, #eql), "Eq requires eql");
  @require(@type_member_type(t, #eql) == Expected, "Eq.eql has wrong type");
  t
}
```

An instance is an attached member:

```fig
type Point = struct {x: i32, y: i32}

fn Point::eql(a: Point, b: Point) -> bool {
  a.x == b.x && a.y == b.y
}
```

Use a transparent contract annotation when the value itself carries the evidence:

```fig
fn same(a: Eq(t), b: t) -> bool {
  t::eql(a, b)
}
```

Use an erased proof when you want a Haskell-like constraint argument:

```fig
fn same_explicit(a: t, b: t, const _proof: Eq(t)) -> bool {
  t::eql(a, b)
}
```

`const _proof` is checked at compile time and removed from runtime calls.

## Functor

The prelude `Functor` contract is a type function over a unary type constructor:

```fig
type fn Functor(t: type fn(a: type) -> type) -> type {
  let Expected = fn(const f: fn(x: a) -> b, v: t(a)) -> t(b);
  @require(@type_has_member(t, #map), "Functor requires map");
  @require(@type_member_type(t, #map) == Expected, "Functor.map has wrong type");
  t
}
```

A Fig type constructor satisfies it by attaching `map`:

```fig
type Box(a) = struct {value: a}

fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
  Box {value: f(v.value)}
}
```

Generic use:

```fig
fn mapped(
  v: t(a),
  const f: fn(x: a) -> b,
  const _proof: Functor(t)
) -> t(b) {
  t::map(f, v)
}
```

The helper `fmap` in `prelude.function` has this shape.

## Applicative

An applicative type constructor needs `map`, `pure`, and `apply`:

```fig
fn Box::pure(value: a) -> Box(a) {
  Box {value}
}

fn Box::apply(v: Box(fn(x: a) -> b), x: Box(a)) -> Box(b) {
  Box {value: v.value(x.value)}
}
```

Use `do @applicative(T(_))` for independent computations:

```fig
fn checked_total(left: i32, right: i32) -> i32 {
  left + right
}

fn independent() -> Box(i32) {
  do @applicative(Box(_)) {
    left <- Box {value: 10};
    right <- Box {value: 20};
    pure(checked_total(left, right))
  }
}
```

Applicative `do` is intentionally stricter than monadic `do`: bound values may be combined in the
final returned expression, but later applicative statements must not depend on earlier bound values.
If the next computation needs a previous value, use `do @monad`.

## Monad

A monad adds `bind`:

```fig
fn Box::bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) {
  f(v.value)
}
```

Dependent sequencing uses `do @monad`:

```fig
fn wrap(x: i32) -> Box(i32) {
  Box {value: x + 1}
}

fn dependent() -> Box(i32) {
  do @monad(Box(_)) {
    x <- Box {value: 1};
    y <- wrap(x);
    pure(y + 1)
  }
}
```

The strategy must be fully applied at its declared arity. Use `_` only for value positions inferred
from the block:

```fig
do @monad(Option(_)) { ... }
do @monad(State(World, _)) { ... }
do @monad(Reader(Env, _)) { ... }
```

Bare constructors such as `do @monad(Option)` and partial strategies such as
`do @monad(State(World))` are invalid.

## IO

Host effects use the built-in `io` executor. Imports take `io` as their first parameter and return
an `io(T)` action:

```fig
const clock = @external("clock", fn(host: io) -> io(i32));

pub fn main(host: io) -> io(i32) {
  do @io(_) {
    now <- clock(host);
    return(now)
  }
}
```

`return(value)` is the IO expression builtin that lifts a pure value into `io(T)`.

## Reader

Use `prelude.monad.Reader(env, a)` when a computation reads shared context:

```fig
const monad = @import("prelude.monad");

type Config = struct {base: i32, step: i32}

fn read_step() -> monad.Reader(Config, i32) {
  do @monad(monad.Reader(Config, _)) {
    config <- monad.Reader::ask();
    pure(config.step)
  }
}

fn run(config: Config) -> i32 {
  read_step()
    \program -> monad.Reader::run(program, config)
}
```

Fig uses named pipe-bind for the explicit runner step. It does not support `|>` pipeline syntax.

## State

Use `prelude.monad.State(state, a)` for ordered state transitions:

```fig
const monad = @import("prelude.monad");

type Counter = struct {count: i32}

fn bump() -> monad.State(Counter, Counter) {
  do @monad(monad.State(Counter, _)) {
    current <- monad.State::get();
    let next = Counter {count: current.count + 1};
    monad.State::put(next);
    monad.State::get()
  }
}

fn run_counter(seed: Counter) -> Counter {
  bump()
    \program -> monad.State::eval(program, seed)
}
```

Outside `State`, ordinary Fig values are reusable and immutable. Use fresh names for pure value
versions.

## Reader + State + Effect Rows

For programs that combine contexts, use `prelude.effect.Eff` rows:

```fig
const effect = @import("prelude.effect");

fn program() -> effect.Eff({state: Store, reader: Env}, i32) {
  do @monad(effect.Eff({state: Store, reader: Env}, _)) {
    env <- effect.ask();
    store <- effect.get();
    effect.put(store + env);
    effect.get()
  }
}
```

Handlers are explicit and ordered with pipe-bind:

```fig
program()
  \program -> effect.run_state(program, seed)
  \program -> effect.run_reader(program, env)
```

This makes effect handling visible in the source instead of relying on an implicit transformer
stack.

## Operators

Fig defines operators with compile-time `const` declarations, but operators are explicit imports
rather than global magic. The standard prelude exposes common declarations:

```fig
const std = @import("prelude.std");

pub fn mapped() -> Box(i32) {
  inc <$> Box {value: 1}
}

pub fn bound() -> Box(i32) {
  Box {value: 1} >>= wrap
}

pub fn flipped_bound() -> Box(i32) {
  wrap =<< Box {value: 1}
}

pub fn kleisli() -> Box(i32) {
  (wrap >=> wrap)(1)
}
```

Operator calls resolve through visible declarations, usually from `prelude.operators` or
`prelude.std`. If an operator has no visible declaration or the target member is missing, checking
fails.

## Rewrite Laws

Haskell laws are normally comments, tests, or equational reasoning. Fig keeps optimizer-facing laws
out of source code: rewrite rules are compiler-plugin facts expressed as const-function template
strings. The default prelude rewrite plugin supplies the standard `Functor`, `Applicative`,
`Monad`, and `Monoid` simplifications when rewrite assumptions are enabled.

## Strictness and Evaluation

Fig is strict. Do not assume Haskell laziness:

- Function arguments are ordinary runtime values unless they are `const`.
- Type functions and `const` values run at compile time.
- Runtime function values exist, but const function parameters are the preferred shape for
  specialization.
- There is no general thunking or lazy list surface.

If you want a delayed computation, model it explicitly as a function or effect value.

## Function Style

Haskell currying:

```haskell
add x y = x + y
```

Fig uses named parameters in function types and ordinary multi-argument calls:

```fig
fn add(x: i32, y: i32) -> i32 {
  x + y
}
```

Use const function parameters for higher-order static callbacks:

```fig
fn apply_to(value: a, const f: fn(x: a) -> b) -> b {
  f(value)
}
```

Use pipe-bind for local value flow:

```fig
read_config()
  \config -> run_with(config)
```

## Inferred Type Holes

Use `_` only where Fig has an expression-backed inference source:

```fig
fn answer() -> _ { 42 }
let x: _ = 1;
let boxed: Box(_) = Box {value: 1};
do @monad(Box(_)) { ... }
```

Do not use `_` in parameter types, external signatures, product fields, type-function bodies, or
contracts where no local expression determines the type.

## What Not To Translate Literally

- Do not rely on implicit typeclass search. Import helpers and pass proofs explicitly.
- Do not assume laziness.
- Do not write partially applied do strategies.
- Do not use `|>` pipeline syntax.
- Do not expect runtime lambdas to replace every Haskell lambda. Use top-level functions,
  const-function parameters, or pipe-bind.
- Do not hide effect handlers. Run Reader, State, Eff, and IO explicitly.

## Checklist

When porting Haskell-shaped code to Fig:

1. Translate data declarations to `struct` or `union`.
2. Translate typeclasses to `type fn` contracts.
3. Translate instances to attached members.
4. Use erased proof parameters for generic functions.
5. Use `do @applicative` only for independent steps.
6. Use `do @monad` for dependent sequencing.
7. Use `prelude.monad` or `prelude.effect` for Reader/State-style programs.
8. Use `match` and union constructors for ordinary ADT handling.
9. Add compiler-plugin rewrite rules only for laws the compiler should know.
