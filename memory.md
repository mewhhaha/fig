# Figlang upgrade specification: Temporal Values → Branch-Bit Values

Assumption: your current implementation is based on the previous **Temporal Values** model:

```text
Handle = pointer + revision
Object = current state + head revision + undo log
Old values are preserved by reading historical revisions
```

This spec upgrades that implementation to the simpler **Branch-Bit Values** model:

```text
Handle = pointer
Object = current state + branched bit
Old values are preserved by copy-before-write
```

The goal is to keep the same surface language while replacing the runtime model.

---

# 1. Upgrade summary

## Current model

```text
value handle = ptr + rev

update latest value:
    mutate object
    append undo log

read old value:
    consult undo log

update stale value:
    materialize old revision
    update copy
```

## New model

```text
value handle = ptr

when a value is logically duplicated:
    mark object as branched

update unbranched object:
    mutate in place

update branched object:
    shallow-copy object
    branch reused children
    mutate copy
```

The user-facing semantics stay the same:

```fig
let a = [1, 2, 3]
let b = a.set(0, 9)

a[0] // 1
b[0] // 9
```

The implementation changes from:

```text
mutate + undo logs
```

to:

```text
branch marking + copy-before-write
```

---

# 2. Compatibility target

## Source compatibility

Existing Figlang source code should continue to work.

No user-facing concepts need to be added.

The core surface model remains:

```text
Values are immutable.
Passing values is cheap.
Updating a value returns a new value.
```

## Runtime compatibility

Runtime compatibility depends on your current ABI.

If your current handle is:

```text
i64 = high 32 bits revision + low 32 bits pointer
```

then use a transitional ABI:

```text
i64 handle:
    high 32 bits = ignored / must be zero
    low 32 bits  = object pointer
```

Later, once all code is recompiled, switch to:

```text
i32 handle on wasm32
i64 handle on wasm64
```

## Semantic compatibility

The new model preserves value semantics but changes performance behavior.

Temporal Values are better for this pattern:

```fig
let a = huge
let b = a.update(...)
let c = a.update(...)
let d = a.update(...)
```

Branch-Bit Values will copy from `a` for each independent branch.

Branch-Bit Values are better for the common linear pattern:

```fig
let a1 = huge.update(...)
let a2 = a1.update(...)
let a3 = a2.update(...)
```

because this can mutate in place with no undo logs.

---

# 3. New runtime representation

## Old handle

```text
TemporalHandle {
    ptr: ObjectPtr
    rev: Revision
}
```

## New handle

```text
ValueHandle {
    ptr: ObjectPtr
}
```

On `wasm32`, this should usually be:

```text
i32 offset into linear memory
```

Immediate values may use tagged representations:

```text
small int
bool
null/unit
short enum
heap pointer
```

The exact tagging scheme is separate from the memory model.

---

# 4. New object header

Replace the temporal header:

```text
ObjectHeader {
    type_id
    size
    head_rev
    log_head
    ...
}
```

with:

```text
ObjectHeader {
    type_id
    size_or_len
    flags
    ...
}
```

Recommended flags:

```text
MARK      // GC mark bit
BRANCHED  // object must be copied before update
PINNED    // host/FFI may retain this object
FORWARDED // optional, for compacting GC
```

The important bit is:

```text
BRANCHED
```

Meaning:

```text
This object may be observed through more than one logical value.
Do not update it in place.
```

Newly allocated objects start as:

```text
BRANCHED = false
```

---

# 5. Remove temporal runtime machinery

Delete or disable:

```text
revision counter
per-object head_rev
undo log allocation
undo log traversal on read
revision-aware field reads
revision-aware array reads
stale revision materialization
revision-aware tracing
history compaction
```

Keep:

```text
allocator
type layout metadata
pointer-field metadata
GC root stack
object traversal
array layout logic
```

The new runtime needs type layouts because shallow-copying an object must know which fields are pointers.

---

# 6. Add hidden primitive: `branch`

The compiler inserts this. Users do not write it.

```fig
branch(x: A) -> A
```

Runtime behavior:

```text
branch(immediate):
    return immediate

branch(object):
    object.flags |= BRANCHED
    return object
```

`branch` is idempotent.

```fig
branch(branch(x)) == branch(x)
```

It does not copy.

It only marks the object as unsafe for in-place mutation.

---

# 7. Core update algorithm

Every physical update must go through:

```text
ensureEditable(object)
```

Pseudo-code:

```text
ensureEditable(obj):
    if obj is immediate:
        return obj

    if obj.flags has PINNED:
        return copyForUpdate(obj)

    if obj.flags has BRANCHED:
        return copyForUpdate(obj)

    return obj
```

Then:

```text
update object field:
    obj = ensureEditable(obj)
    write field
    return obj
```

So:

```fig
enemy.hp = 80
```

lowers to:

```text
enemy = ensureEditable(enemy)
enemy.hp = 80
return enemy
```

If `enemy` is unbranched, this mutates in place.

If `enemy` is branched, this copies first.

---

# 8. Copying a branched object

When copying a branched object, reused child pointers must be branched.

Example:

```fig
let a = Node {
    name: "old",
    child: child
}

let b = a.with(name = "new")
```

After the update:

```text
a.child and b.child point to the same child
```

Therefore `child` must be marked branched.

Pseudo-code:

```text
copyForUpdate(obj):
    new = allocateSameShape(obj)

    copy all fields from obj into new

    new.flags.BRANCHED = false
    new.flags.PINNED = false

    for each pointer field f copied from obj into new:
        branch(new.f)

    return new
```

For an overwritten field, branching the old value is not needed if the value is not copied into the new object.

A simpler first implementation may branch all pointer fields during copy. That is safe, only slightly more pessimistic.

---

# 9. Nested update algorithm

For this source:

```fig
world.player.inventory.items[3].count = 4
```

lower to a path update:

```text
editPath(world, [
    .player,
    .inventory,
    .items,
    index(3),
    .count
], 4)
```

Runtime behavior:

```text
1. ensureEditable(world)
2. ensureEditable(world.player)
3. ensureEditable(world.player.inventory)
4. ensureEditable(items root/chunk)
5. ensureEditable(item)
6. write count
7. stitch updated children back into parents
```

At each level:

```text
if unbranched:
    mutate in place

if branched:
    copy this node
    branch reused child pointers
    continue into the copy
```

This gives pure persistent update semantics with in-place mutation in the linear case.

---

# 10. Field access rules

This is the most important correctness detail.

There are three internal field access forms.

## 10.1 `peek_field`

Used only for read-only access.

```text
peek_field(parent, field)
```

It does not branch.

Use this inside inferred read-only functions:

```fig
fn length(xs: Array[A]) -> Int
```

A read-only function may inspect values but cannot return, store, or update them.

---

## 10.2 `get_field`

Used when both the parent and child remain live.

```text
get_field(parent, field):
    child = parent.field
    branch(child)
    return child
```

Example:

```fig
let child = parent.child
use(parent)
use(child)
```

The child must be branched because it is now reachable through two logical paths:

```text
parent.child
child
```

---

## 10.3 `take_field`

Used when the parent is consumed.

```text
take_field(parent, field):
    child = parent.field

    if parent.flags has BRANCHED or PINNED:
        branch(child)

    return child
```

The runtime branch check is necessary.

Example:

```fig
fn getChild(parent: Parent) -> Child {
    parent.child
}

let child = getChild(parent)
use(parent)
```

The caller will branch `parent` before passing it, because `parent` is still used later.

Inside `getChild`, the local `parent` is consumed, but the physical object is still branched. Therefore the returned child must be branched.

Without this rule, updating `child` could accidentally mutate `parent.child`.

---

# 11. Array rules

Do not represent large arrays as one flat object.

Use:

```text
small arrays:
    flat inline storage

large arrays:
    chunk tree
```

Recommended structure:

```text
ArrayRoot
    len
    tree height
    child pointers

ArrayNode
    child pointers

ArrayChunk
    elements
```

For array update:

```fig
xs[i] = value
```

lower to:

```text
arraySet(xs, i, value)
```

Algorithm:

```text
arraySet(root, i, value):
    root = ensureEditable(root)

    node path = locate chunk containing i

    for each node on path:
        node = ensureEditable(node)

    chunk = ensureEditable(chunk)

    write chunk[i] = value

    return root
```

When copying array nodes or chunks:

```text
branch reused pointer children/elements
```

For pointer-element arrays, copied elements must be branched if reused.

For numeric arrays, no branching is needed.

---

# 12. Constructors

Object construction consumes its field values unless those values are used again.

Source:

```fig
let texture = loadTexture()

let a = Sprite { texture, pos: p1 }
let b = Sprite { texture, pos: p2 }
```

Lowering:

```fig
let a = Sprite { texture: branch(texture), pos: p1 }
let b = Sprite { texture, pos: p2 }
```

No copy occurs.

Both sprites share the same texture object, but it is marked branched.

If someone later updates the texture through one sprite, it copies first.

---

# 13. Function calls

Function calls need branch insertion at the caller.

Source:

```fig
let b = update(a)
let c = render(a)
```

Since `a` is used twice, lower to:

```fig
let b = update(branch(a))
let c = render(a)
```

If `update` mutates internally, it sees a branched object and copies first.

If the value is used only once:

```fig
let b = update(a)
```

no branch is needed.

The callee may update `a` in place if it is unbranched.

---

# 14. Read-only function optimization

A conservative compiler can branch too often.

Example:

```fig
let n = len(xs)
let ys = xs.set(0, value)
```

Naively, because `xs` is used twice, this becomes:

```fig
let n = len(branch(xs))
let ys = xs.set(0, value)
```

That is safe but unnecessary.

Add inferred parameter effects:

```text
observe
consume
retain
```

## `observe`

The parameter is only read.

It is not:

```text
stored
returned
updated
captured
passed to a retaining function
```

Example:

```fig
fn len(xs: Array[A]) -> Int
```

can be inferred as:

```text
xs: observe
```

Then this needs no branch:

```fig
let n = len(xs)
let ys = xs.set(0, value)
```

because `len` only observes.

## `consume`

The function may update, return, transform, or otherwise use the value as a real value.

```fig
fn normalize(mesh: Mesh) -> Mesh
```

Caller branches if the caller still needs the old value.

## `retain`

The function stores or captures the value somewhere.

```fig
fn cachePut(cache: Cache, asset: Asset) -> Cache
```

Caller branches if the original remains live.

---

# 15. Compiler branch insertion pass

Add a lowering pass:

```text
Source IR → Linearized Value IR
```

For each source value:

```text
last value use:
    move

non-last value use:
    branch
```

Example:

```fig
let y = f(x)
let z = g(x)
```

Lower to:

```fig
let y = f(branch(x))
let z = g(x)
```

Another example:

```fig
let pair = Pair(x, x)
```

Lower to:

```fig
let pair = Pair(branch(x), x)
```

For control flow, use conservative liveness.

Example:

```fig
if cond {
    f(x)
} else {
    g(x)
}

h(x)
```

Since `x` is used after the branch, calls inside the branch receive branched values unless their parameters are `observe`.

Conservative lowering:

```fig
if cond {
    f(branch(x))
} else {
    g(branch(x))
}

h(x)
```

This is safe.

You can optimize later.

---

# 16. Closure capture rules

Capturing a value duplicates it if the original remains live.

```fig
let asset = loadAsset()

let draw = fn () {
    render(asset)
}

use(asset)
```

Lower capture to:

```fig
let draw = fn_capture(branch(asset)) {
    render(asset)
}

use(asset)
```

Reusable closures should branch captured heap values by default.

One-shot closures may consume captures without branching:

```fig
let consumeOnce = fn_once () {
    process(asset)
}
```

If the closure is guaranteed one-shot and `asset` is not used elsewhere, no branch is needed.

---

# 17. FFI and host values

Any value passed to the host must be treated as retained unless the import is explicitly annotated read-only.

Default rule:

```text
exported value → branch or pin
imported host-retained value → branch or pin
```

Recommended:

```text
Values passed to JS/host:
    set PINNED
    set BRANCHED
```

A pinned object is never updated in place.

```text
ensureEditable(pinned object):
    copy first
```

This avoids the host observing hidden mutation.

For imports, support annotations:

```fig
extern fn log(value: Value) observe
extern fn store(value: Value) retain
```

Default unknown imports to:

```text
retain
```

---

# 18. GC changes

## Minimum GC

A normal tracing GC is enough.

It traces:

```text
roots
objects
arrays
closures
host handles
```

It does not need revisions.

It does not need undo logs.

The `BRANCHED` bit is preserved.

This is safe but pessimistic because branch bits are sticky.

---

## Optional GC freshening

A compacting GC can recover uniqueness.

During tracing, count incoming references.

Then:

```text
if object has one incoming reference and is not pinned:
    clear BRANCHED

if object has multiple incoming references:
    set BRANCHED
```

This repairs stale branch bits.

Example:

```fig
let a = bigTree
let b = a

use(b)
// b dies

let c = a.update(...)
```

Without freshening, `a` may still be branched and update may copy.

After GC freshening, `a` can become unbranched again.

---

# 19. `materialize`, `compact`, and `transient`

If your Temporal Values implementation exposed these, keep them as compatibility intrinsics.

## `materialize(x)`

New meaning:

```text
Create a fresh physical representation of x.
Do not share with the old x.
```

Implementation:

```text
deep-copy reachable graph
preserve internal sharing if desired
recompute BRANCHED bits from internal sharing
```

Important: if the materialized value internally shares a child through two paths, that child must still be branched.

Example:

```fig
let x = NodePair {
    left: child,
    right: child,
}
```

After `materialize(x)`, `left` and `right` either:

```text
point to separate child copies
```

or:

```text
share one child marked BRANCHED
```

Both are correct.

---

## `compact(x)`

New meaning:

```text
Semantic identity.
May rebuild x into a fresher representation.
May recompute branch bits.
```

Implementation may simply return `x`.

Better implementation:

```text
copy x into fresh memory
set BRANCHED based on actual internal sharing
```

---

## `transient { ... }`

New meaning:

```text
Optimization hint.
Prefer linear update lowering inside this block.
```

It does not change semantics.

A first implementation may treat it as a no-op.

---

# 20. Migration phases

## Phase 0 — Add branch infrastructure without changing semantics

Keep Temporal Values active.

Add:

```text
BRANCHED flag
branch primitive
compiler branch insertion pass
debug counters
```

`branch(x)` may initially only set a flag and return `x`.

Temporal undo logs still guarantee correctness.

Purpose:

```text
Test branch insertion without risking semantic bugs.
```

---

## Phase 1 — Add Branch-Bit update path

Implement:

```text
ensureEditable
copyForUpdate
branch reused children
branch-aware field extraction
branch-aware array update
```

Keep the temporal path available behind a flag.

Recommended build flags:

```text
--memory=temporal
--memory=branch-debug
--memory=branch
```

In `branch-debug` mode:

```text
compute result with Branch-Bit runtime
optionally compare against Temporal runtime/reference interpreter
```

---

## Phase 2 — Remove revision-aware reads from branch mode

In branch mode, reads become direct:

```text
field read = load field
array read = load element
```

No history lookup.

No revision comparison.

No undo traversal.

Keep Temporal mode for comparison until tests are stable.

---

## Phase 3 — Stop allocating undo logs

In branch mode:

```text
updates never allocate undo entries
objects do not update head_rev
handles ignore revision bits
```

Existing i64 handles can still be used temporarily:

```text
high bits = 0
low bits = pointer
```

---

## Phase 4 — Simplify GC

Remove:

```text
revision-aware marking
undo-log marking
old-revision retention
history compaction
```

Use ordinary tracing.

Optional later:

```text
incoming-reference counting
branch-bit freshening
compacting GC
```

---

## Phase 5 — Shrink ABI

After all code is compiled with branch mode:

```text
Temporal ABI:
    i64 ptr+rev

Branch ABI:
    i32 ptr on wasm32
```

This is a runtime ABI break.

Use a version marker:

```text
FIGLANG_ABI_TEMPORAL = 1
FIGLANG_ABI_BRANCH  = 2
```

Modules compiled with ABI 1 and ABI 2 should not freely exchange raw handles.

Use adapters if needed:

```text
temporal handle → materialized branch handle
branch handle   → temporal handle with rev = current
```

---

# 21. Debug assertions

Add runtime assertions in debug builds.

## Before write

```text
assert object is not BRANCHED
assert object is not PINNED
```

Every physical write must happen only after `ensureEditable`.

---

## During copy

```text
if pointer field is reused by both old and new object:
    assert branch(pointer field) was called
```

---

## During field extraction

```text
if parent remains live:
    returned pointer child must be branched

if parent is BRANCHED:
    returned pointer child must be branched
```

---

## During FFI export

```text
exported heap object must be BRANCHED or PINNED
```

---

# 22. Test plan

## Basic aliasing

```fig
let a = Box { value: 1 }
let b = a

let c = b.with(value = 2)

assert a.value == 1
assert c.value == 2
```

---

## Nested aliasing

```fig
let child = Child { value: 1 }
let parent = Parent { child }

let parent2 = parent.with(child.value = 2)

assert parent.child.value == 1
assert parent2.child.value == 2
```

---

## Extracted child

```fig
let parent = Parent {
    child: Child { value: 1 }
}

let child = parent.child
let child2 = child.with(value = 2)

assert parent.child.value == 1
assert child2.value == 2
```

---

## Function return child

```fig
fn getChild(parent: Parent) -> Child {
    parent.child
}

let parent = Parent {
    child: Child { value: 1 }
}

let child = getChild(parent)
let child2 = child.with(value = 2)

assert parent.child.value == 1
assert child2.value == 2
```

This catches the important `take_field` bug.

---

## Constructor duplicate

```fig
let child = Child { value: 1 }

let pair = Pair {
    left: child,
    right: child,
}

let pair2 = pair.with(left.value = 2)

assert pair.right.value == 1
assert pair2.left.value == 2
assert pair2.right.value == 1
```

---

## Array duplicate

```fig
let item = Item { value: 1 }
let xs = [item, item]

let ys = xs.set(0, item.with(value = 2))

assert xs[0].value == 1
assert xs[1].value == 1
assert ys[0].value == 2
assert ys[1].value == 1
```

---

## Read-only function

```fig
fn len(xs: Array[Int]) -> Int {
    xs.length
}

let xs = [1, 2, 3]

let n = len(xs)
let ys = xs.set(0, 9)

assert n == 3
assert xs[0] == 1
assert ys[0] == 9
```

Also assert through instrumentation that `len(xs)` did not branch `xs`.

---

## Differential fuzzing

During migration, run generated programs against:

```text
1. reference persistent interpreter
2. old Temporal Values runtime
3. new Branch-Bit runtime
```

Compare final structural results.

Generate cases involving:

```text
nested records
arrays
repeated fields
closures
function calls
control flow
field extraction
old value reuse
FFI boundaries
```

---

# 23. Performance counters

Add counters before deleting the temporal runtime.

Useful counters:

```text
branch_calls
branch_calls_on_immediates
branch_calls_on_already_branched
copy_for_update_count
in_place_update_count
copied_object_bytes
copied_array_chunk_bytes
read_only_call_count
unnecessary_branch_estimate
gc_freshened_objects
```

Key ratios:

```text
in_place_update_count / total_updates
copy_for_update_count / total_updates
copied_bytes / update
```

The branch-bit model is working well when:

```text
linear update chains mostly update in place
read-heavy code performs no branch calls
large array updates copy only chunks
```

---

# 24. Expected simplifications

After full migration, the runtime should no longer need:

```text
revisioned handles
historical field lookup
historical array lookup
undo log encoding
undo log decoding
revision-aware GC
stale-branch materialization
temporal context revision counter
```

The new implementation needs:

```text
branch bit
branch primitive
last-use branch insertion
copy-before-write
pointer-field layout metadata
normal tracing GC
```

So complexity moves from runtime history management into compiler liveness analysis.

That is usually a good trade:

```text
Temporal Values:
    simpler compiler
    complex runtime

Branch-Bit Values:
    slightly smarter compiler
    much simpler runtime
```

---

# 25. Final target spec

After migration, Figlang’s memory model should be:

```text
1. All source-level values are immutable.

2. Assignment, passing, storing, and returning are cheap.

3. The compiler inserts hidden branch(x) when one logical value becomes two.

4. branch(x) marks the physical object as branched but does not copy.

5. Updating an unbranched object mutates it in place.

6. Updating a branched object copies it first.

7. When copying an object, reused pointer children are branched.

8. Field extraction branches the child if the parent remains live or is already branched.

9. Large arrays use chunks so updates copy bounded-size nodes.

10. Reads are direct loads.

11. Memory is reclaimed by normal tracing GC.

12. GC may clear stale branch bits when it proves unique reachability.
```

In implementation terms, the upgrade is:

```text
Delete revision history.
Add branch marking.
Replace undo-log preservation with copy-before-write.
Replace revision-aware reads with direct reads.
Add compiler branch insertion.
```

The resulting model keeps the ergonomic surface of Temporal Values but is much simpler to compile to WASM efficiently.
