import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { parse as parseSyntax, type ParseNode } from "../generated/baba-workbench/parser.ts";
import { lex, type Token } from "../generated/baba-workbench/tokenizer.ts";
import { CompileError, formatSource, isFormatted, parse } from "../src/mod.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const MAX_FORMAT_LINE_WIDTH = 100;

const formatCases: { name: string; input: string; expected: string }[] = [
  {
    name: "function spacing and final newline",
    input: "fn  main( ) -> i32 {let x=1+2; x}\r\n",
    expected: "fn main() -> i32 {\n  let x = 1 + 2;\n  x\n}\n",
  },
  {
    name: "leading and trailing comments",
    input: `/// docs
// plain
fn main()->i32{let x=1;// keep
// inside
x}
`,
    expected: "/// docs\n// plain\nfn main() -> i32 {\n  let x = 1; // keep\n  // inside\n  x\n}\n",
  },
  {
    name: "imports capabilities consts and effect rows",
    input: `/// import docs
const std=@import("prelude.std");
/// capability docs
const clock:fn()->i32!{time}=@capability("clock");
pub fn main()->i32!{time}{clock()}`,
    expected:
      '/// import docs\nconst std = @import("prelude.std");\n/// capability docs\nconst clock: fn() -> i32 !{time} = @capability("clock");\n\npub fn main() -> i32 !{time} {\n  clock()\n}\n',
  },
  {
    name: "destructured source imports",
    input: `const{map4_i32,lane4_add_i32}=@import("prelude.array_static");`,
    expected: 'const { map4_i32, lane4_add_i32 } = @import("prelude.array_static");\n',
  },
  {
    name: "const group before type function",
    input:
      `const std=@import("prelude.std");const limit=4;type fn sized(A:type)->struct{let Row={value:A};struct(Row)}`,
    expected:
      'const std = @import("prelude.std");\nconst limit = 4;\n\ntype fn sized(A: type) -> struct {\n  let Row = {\n    value: A\n  };\n  struct(Row)\n}\n',
  },
  {
    name: "empty and multi item effect rows",
    input: "fn pure()->i32!{}{1} fn work()->i32!{ time ,gpu }{2}",
    expected: "fn pure() -> i32 !{} {\n  1\n}\n\nfn work() -> i32 !{time, gpu} {\n  2\n}\n",
  },
  {
    name: "type function block with optional final semicolon",
    input: "type fn option(A:type)->union{let None={};let Some={value:A};union(None,Some);}",
    expected:
      "type fn option(A: type) -> union {\n  let None = {};\n  let Some = {\n    value: A\n  };\n  union(None, Some);\n}\n",
  },
  {
    name: "fields calls shapes matches and pipe bind",
    input: "fn main()->i32{let point={x:1,y:2};match point.x{1=>2,// arm\n_=>3}\\value->value}",
    expected:
      "fn main() -> i32 {\n  let point = {\n    x: 1, y: 2\n  };\n  match point.x {\n    1 => 2, // arm\n    _ => 3\n  } \\value -> value\n}\n",
  },
  {
    name: "operators fields indexing and literal tags",
    input: "fn main()->i32{let xs=[1,2,3];let tag=#Widget;xs[0] + 1 * 2 == 3 && tag == #Widget}",
    expected:
      "fn main() -> i32 {\n  let xs = [1, 2, 3];\n  let tag = #Widget;\n  xs[0] + 1 * 2 == 3 && tag == #Widget\n}\n",
  },
  {
    name: "long arrays verticalize every item",
    input:
      "fn main()->i32{let xs=[first_long_value_name,second_long_value_name,third_long_value_name,fourth_long_value_name,fifth_long_value_name];0}",
    expected:
      "fn main() -> i32 {\n  let xs = [\n    first_long_value_name,\n    second_long_value_name,\n    third_long_value_name,\n    fourth_long_value_name,\n    fifth_long_value_name\n  ];\n  0\n}\n",
  },
  {
    name: "wrapped collections verticalize every item",
    input:
      "fn defaults()->world{{velocities:[default_velocity(),default_velocity(),default_velocity()]}}",
    expected:
      "fn defaults() -> world {\n  {\n    velocities: [\n      default_velocity(),\n      default_velocity(),\n      default_velocity()\n    ]\n  }\n}\n",
  },
  {
    name: "nested blocks matches and shapes",
    input: "fn main()->i32{let box={value:match 1{0=>{x:1},_=>{x:2}}};box.value.x}",
    expected:
      "fn main() -> i32 {\n  let box = {\n    value: match 1 {\n      0 => {\n        x: 1\n      },\n      _ => {\n        x: 2\n      }\n    }\n  };\n  box.value.x\n}\n",
  },
  {
    name: "type repeat prefixes",
    input:
      "type fn fixed(N:count,A:type)->struct{let Fixed={N*A};let Mixed={header:i32,3*bool,tail:A};struct(Mixed)}",
    expected:
      "type fn fixed(N: count, A: type) -> struct {\n  let Fixed = {\n    N*A\n  };\n  let Mixed = {\n    header: i32, 3*bool, tail: A\n  };\n  struct(Mixed)\n}\n",
  },
  {
    name: "collection literals stay bracketed",
    input: "fn main()->i32{let xs=[0,1,2];let rows=[{value:0},{value:1}];rows[1].value + xs[2]}",
    expected:
      "fn main() -> i32 {\n  let xs = [0, 1, 2];\n  let rows = [{\n    value: 0\n  }, {\n    value: 1\n  }];\n  rows[1].value + xs[2]\n}\n",
  },
  {
    name: "shape and type reflection helpers",
    input:
      'type fn shaped()->type{let Base={x:i32,y:bool,z:i32};let Picked=@shape_pick(Base,{x:true,y:true});let Out=@shape_concat(Picked,{count:@shape_count(Picked)});@require(@shape_has_slot(Out,#count),"count");struct(Out)}',
    expected:
      'type fn shaped() -> type {\n  let Base = {\n    x: i32, y: bool, z: i32\n  };\n  let Picked = @shape_pick(Base, {\n    x: true, y: true\n  });\n  let Out = @shape_concat(\n    Picked,\n    {\n      count: @shape_count(Picked)\n    }\n  );\n  @require(@shape_has_slot(Out, #count), "count");\n  struct(Out)\n}\n',
  },
  {
    name: "shape index call and constructor ambiguity",
    input:
      "fn main(xs:{3*i32})->i32{let box=Box {x:1};let y=xs [ 0 ];let z=f( { x:1 } );let shape=@shape_concat(Base,{x:A});y + box.x + z.x}",
    expected:
      "fn main(xs: {\n  3*i32\n}) -> i32 {\n  let box = Box {\n    x: 1\n  };\n  let y = xs[0];\n  let z = f({\n    x: 1\n  });\n  let shape = @shape_concat(Base, {\n    x: A\n  });\n  y + box.x + z.x\n}\n",
  },
  {
    name: "record and collection fields",
    input: "fn make()->world{World { component_next:{next:0},entities:[default_entity]}}",
    expected:
      "fn make() -> world {\n  World {\n    component_next: {\n      next: 0\n    }, entities: [default_entity]\n  }\n}\n",
  },
  {
    name: "inline one line nested match expressions",
    input:
      "fn both(a:bool,b:bool)->bool{match a{true=>match b{true=>false,false=>true},false=>false}}",
    expected:
      "fn both(a: bool, b: bool) -> bool {\n  match a {\n    true => match b {\n      true => false,\n      false => true\n    },\n    false => false\n  }\n}\n",
  },
  {
    name: "multiline nested match expressions",
    input:
      "fn both(a:bool,b:bool)->bool{match a{true=>match b{true=>false,\nfalse=>true},\nfalse=>match b{true=>true,false=>false}}}",
    expected:
      "fn both(a: bool, b: bool) -> bool {\n  match a {\n    true => match b {\n      true => false,\n      false => true\n    },\n    false => match b {\n      true => true,\n      false => false\n    }\n  }\n}\n",
  },
  {
    name: "comments around punctuation sensitive contexts",
    input: `/// import docs
const std=@import("prelude.std"); // import tail
/// type docs
type fn row(A:type)->struct{
// slot docs
let Row={x:A, // x tail
};
struct(Row) // final expr tail
}
fn make()->world{World {defaults:@field(default_components,#key) // tail
}}
fn classify(x:i32)->i32{match x{
0=>1, // zero
_=>2 // fallback
}}`,
    expected:
      '/// import docs\nconst std = @import("prelude.std"); // import tail\n/// type docs\ntype fn row(A: type) -> struct {\n  // slot docs\n  let Row = {\n    x: A, // x tail\n  };\n  struct(Row) // final expr tail\n}\n\nfn make() -> world {\n  World {\n    defaults: @field(default_components, #key) // tail\n  }\n}\n\nfn classify(x: i32) -> i32 {\n  match x {\n    0 => 1, // zero\n    _ => 2 // fallback\n  }\n}\n',
  },
  {
    name: "function clauses and custom operators",
    input:
      "fn choose(0)->i32{0} fn choose(_)->i32{1} fn box.append(a:box,b:box)->box{Box {value:a.value <> b.value}}",
    expected:
      "fn choose(0) -> i32 {\n  0\n}\nfn choose(_) -> i32 {\n  1\n}\n\nfn box.append(a: box, b: box) -> box {\n  Box {\n    value: a.value <> b.value\n  }\n}\n",
  },
  {
    name: "dotted function clauses stay grouped",
    input: "fn box.append(0)->i32{0} fn box.append(_)->i32{1} fn box.clear()->i32{0}",
    expected:
      "fn box.append(0) -> i32 {\n  0\n}\nfn box.append(_) -> i32 {\n  1\n}\n\nfn box.clear() -> i32 {\n  0\n}\n",
  },
  {
    name: "strings chars fenced text and comment markers inside literals",
    input:
      "fn main()->string{let url=\"https://example.test/a//b\";let ch='/';let text=```line // not comment\nnext```;url}",
    expected:
      "fn main() -> string {\n  let url = \"https://example.test/a//b\";\n  let ch = '/';\n  let text = ```line // not comment\nnext```;\n  url\n}\n",
  },
  {
    name: "collapses repeated blank lines",
    input: "fn one()->i32{1}\n\n\n\nfn two()->i32{2}",
    expected: "fn one() -> i32 {\n  1\n}\n\nfn two() -> i32 {\n  2\n}\n",
  },
  {
    name: "wgsl fenced text helpers",
    input:
      'const canvas=@import("web.canvas");const shader:string=```wgsl\n@group(0) @binding(1) var<uniform> camera: mat4x4<f32>;\n```;pub fn main()->i32!{gpu}{canvas.gpu_create_shader(canvas.shader_id(shader))}',
    expected:
      'const canvas = @import("web.canvas");\nconst shader: string = ```wgsl\n@group(0) @binding(1) var<uniform> camera: mat4x4<f32>;\n```;\n\npub fn main() -> i32 !{gpu} {\n  canvas.gpu_create_shader(canvas.shader_id(shader))\n}\n',
  },
  {
    name: "fork destructuring and local proof consts",
    input:
      "fn main(x:i32)->i32{let left,right=fork(x);let a,b=fork(left);const Proof=semigroup(i32);append(i32,Proof,a,b)+right}",
    expected:
      "fn main(x: i32) -> i32 {\n  let left, right = fork(x);\n  let a, b = fork(left);\n  const Proof = semigroup(i32);\n  append(i32, Proof, a, b) + right\n}\n",
  },
  {
    name: "pipe placeholder and fluent chains",
    input:
      "fn main()->i32{inline_array.iter([1,2,3,4])\\$->$.map(double).filter(keep).fold(0,add)}",
    expected:
      "fn main() -> i32 {\n  inline_array.iter([1, 2, 3, 4])\n    \\$ -> $.map(double)\n    .filter(keep)\n    .fold(0, add)\n}\n",
  },
  {
    name: "wrapped fluent call chains verticalize every call",
    input:
      "fn main()->i32{source.make_first_value(alpha,beta).then_apply(second_transform).finish_with(third_transform,fourth_transform)}",
    expected:
      "fn main() -> i32 {\n  source\n    .make_first_value(alpha, beta)\n    .then_apply(second_transform)\n    .finish_with(third_transform, fourth_transform)\n}\n",
  },
  {
    name: "wrapped pipe chains verticalize every segment",
    input:
      "fn main()->i32{source_value_with_a_long_name()\\x->first_transform_with_long_name(x)\\y->second_transform_with_long_name(y)\\z->third_transform_with_long_name(z)}",
    expected:
      "fn main() -> i32 {\n  source_value_with_a_long_name()\n    \\x -> first_transform_with_long_name(x)\n    \\y -> second_transform_with_long_name(y)\n    \\z -> third_transform_with_long_name(z)\n}\n",
  },
  {
    name: "wrapped operators indent continuations",
    input:
      "fn total()->i32{very_long_value_name + another_long_value_name + third_long_value_name + fourth_long_value_name + fifth_long_value_name}",
    expected:
      "fn total() -> i32 {\n  very_long_value_name\n    + another_long_value_name\n    + third_long_value_name\n    + fourth_long_value_name\n    + fifth_long_value_name\n}\n",
  },
  {
    name: "wrapped operators preserve member chains",
    input:
      "fn vertex_sum(geometry:geometry)->i32{geometry.vertex_count + geometry.vertices[0].x + geometry.vertices[0].y + geometry.vertices[0].rgba}",
    expected:
      "fn vertex_sum(geometry: geometry) -> i32 {\n  geometry.vertex_count\n    + geometry.vertices[0].x\n    + geometry.vertices[0].y\n    + geometry.vertices[0].rgba\n}\n",
  },
  {
    name: "operator descriptors",
    input:
      'type fn op_add(T:type)->operator{operator(#infixl,60,"+",T.add)} type fn op_bind(T:type)->operator{operator(#infixl,10,">>=",T.bind)}',
    expected:
      'type fn op_add(T: type) -> operator {\n  operator(#infixl, 60, "+", T.add)\n}\n\ntype fn op_bind(T: type) -> operator {\n  operator(#infixl, 10, ">>=", T.bind)\n}\n',
  },
  {
    name: "type reflection helper surface",
    input:
      "type fn reflected()->type{let Slots=@type_slots(point);let Variants=@type_variants(option(i32));let SomeSlots=@type_variant_slots(option(i32),#Some);let Renamed=@shape_rename(Slots,{x:#left});let Mapped=@shape_map(Renamed,wrap);let WithKey=@shape_map_with_key(Mapped,relabel);let Filtered=@shape_filter(WithKey,keep);struct(@shape_concat(Filtered,{tag:@shape_slot(Variants,#Some),value:@shape_slot(SomeSlots,#value)}))}",
    expected:
      "type fn reflected() -> type {\n  let Slots = @type_slots(point);\n  let Variants = @type_variants(option(i32));\n  let SomeSlots = @type_variant_slots(\n    option(i32),\n    #Some\n  );\n  let Renamed = @shape_rename(Slots, {\n    x: #left\n  });\n  let Mapped = @shape_map(Renamed, wrap);\n  let WithKey = @shape_map_with_key(Mapped, relabel);\n  let Filtered = @shape_filter(WithKey, keep);\n  struct(@shape_concat(\n    Filtered,\n    {\n      tag: @shape_slot(Variants, #Some), value: @shape_slot(\n        SomeSlots,\n        #value\n      )\n    }\n  ))\n}\n",
  },
  {
    name: "union constructors and payload match arms",
    input:
      "type fn option(A:type)->union{let None=[];let Some={value:A};union(None,Some)} fn unwrap(value:option(i32))->i32{match value{Some(inner)=>inner,None=>0}}",
    expected:
      "type fn option(A: type) -> union {\n  let None = [];\n  let Some = {\n    value: A\n  };\n  union(None, Some)\n}\n\nfn unwrap(value: option(i32)) -> i32 {\n  match value {\n    Some(inner) => inner,\n    None => 0\n  }\n}\n",
  },
  {
    name: "docs on params slots and explicit records",
    input: `type fn row(
/// param docs
A:type
)->struct{
/// slot docs
let Row={value:A};
struct(Row)
}
fn make()->world{World {
defaults:@field(defaults,#key)
}}`,
    expected:
      "type fn row(\n/// param docs\nA: type) -> struct {\n  /// slot docs\n  let Row = {\n    value: A\n  };\n  struct(Row)\n}\n\nfn make() -> world {\n  World {\n    defaults: @field(defaults, #key)\n  }\n}\n",
  },
  {
    name: "const dictionaries and typeclass helper contracts",
    input:
      "type fn eq(T:type){let Eq={eql:fn(a:T,b:T)->bool,neq:fn(a:T,b:T)->bool};struct(Eq)} fn eql_point(a:point,b:point)->bool{a.x==b.x} fn neq_point(a:point,b:point)->bool{a.x!=b.x} const point_eq:eq(point)={eql:eql_point,neq:neq_point};",
    expected:
      "type fn eq(T: type) {\n  let Eq = {\n    eql: fn(a: T, b: T) -> bool, neq: fn(a: T, b: T) -> bool\n  };\n  struct(Eq)\n}\n\nfn eql_point(a: point, b: point) -> bool {\n  a.x == b.x\n}\n\nfn neq_point(a: point, b: point) -> bool {\n  a.x != b.x\n}\n\nconst point_eq: eq(point) = {\n  eql: eql_point, neq: neq_point\n};\n",
  },
  {
    name: "constructor pattern parameters and attached members",
    input:
      "fn choose(Some(value))->i32{value} fn choose(None)->i32{0} fn world.tick(world:world,dt_ms:i32)->world{world.step(dt_ms)} fn world.render(world:world)->geometry{geometry.empty()}",
    expected:
      "fn choose(Some(value)) -> i32 {\n  value\n}\nfn choose(None) -> i32 {\n  0\n}\n\nfn world.tick(world: world, dt_ms: i32) -> world {\n  world.step(dt_ms)\n}\n\nfn world.render(world: world) -> geometry {\n  geometry.empty()\n}\n",
  },
  {
    name: "newline separated const declarations without semicolons",
    input:
      "const movement_query_token: ecs.query(game_world, movement_query) = {}\nconst render_query_token: ecs.query(game_world, render_query) = {}\nfn default_components() -> i32 {\n  0\n}\n",
    expected:
      "const movement_query_token: ecs\n  .query(game_world, movement_query) = {}\nconst render_query_token: ecs\n  .query(game_world, render_query) = {}\n\nfn default_components() -> i32 {\n  0\n}\n",
  },
  {
    name: "ecs style static shapes and field helpers",
    input:
      "fn add_entity(world:world2d(EC,Components,E),const selected,values:component_values(selected))->world2d(EC,Components,E){{next_entity_id:world.next_entity_id+1,component_next:{transforms:world.component_next.transforms+1,velocities:world.component_next.velocities+1,sprites:world.component_next.sprites+1},entities:entity_store_set(world.entities,world.next_entity_id,entity_for_store),transforms:transform_store_set(world.transforms,world.component_next.transforms,values.transforms)}}",
    expected:
      "fn add_entity(\n  world: world2d(EC, Components, E),\n  const selected,\n  values: component_values(selected)\n) -> world2d(EC, Components, E) {\n  {\n    next_entity_id: world.next_entity_id + 1,\n    component_next: {\n      transforms: world.component_next.transforms + 1,\n      velocities: world.component_next.velocities + 1,\n      sprites: world.component_next.sprites + 1\n    },\n    entities: entity_store_set(\n      world.entities,\n      world.next_entity_id,\n      entity_for_store\n    ),\n    transforms: transform_store_set(\n      world.transforms,\n      world.component_next.transforms,\n      values.transforms\n    )\n  }\n}\n",
  },
  {
    name: "comments around type params and const static params",
    input: `type fn pair(
/// left type
A:type,
/// right type
B:type
)->struct{let Pair={left:A,right:B};struct(Pair)}
fn map(
/// dictionary
const Dict:eq(point),
/// value
value:point
)->point{Dict.map(value)}`,
    expected:
      "type fn pair(\n/// left type\nA: type,\n/// right type\nB: type) -> struct {\n  let Pair = {\n    left: A, right: B\n  };\n  struct(Pair)\n}\n\nfn map(\n/// dictionary\nconst Dict: eq(point),\n/// value\nvalue: point) -> point {\n  Dict.map(value)\n}\n",
  },
];

for (const testCase of formatCases) {
  Deno.test(`formatter ${testCase.name}`, async () => {
    await assertFormats(testCase.input, testCase.expected);
  });
}

Deno.test("formatter removes destructured import trailing comma", () => {
  assertEquals(
    formatSource('const { map4_i32, lane4_add_i32, } = @import("prelude.array_static");'),
    'const { map4_i32, lane4_add_i32 } = @import("prelude.array_static");\n',
  );
});

Deno.test("formatter is safe for representative valid syntax", async () => {
  for (const testCase of formatCases) await assertSafeFormat(testCase.input);
});

Deno.test("formatter corpus parses and is idempotent", async () => {
  for await (const path of validFigCorpus()) {
    const source = await Deno.readTextFile(path);
    await assertSafeFormat(source, path);
  }
});

Deno.test("formatter preserves syntax for messy whitespace snippets", async () => {
  const snippets = [
    "fn main( ) -> i32 !{ time } { let point = { x : 1 , y : 2 } ; point . x }",
    "fn main(xs:{3*i32} )->i32{ xs [ 0 ] + f ( { x : 1 } ) . x }",
    "type fn shaped( A : type ) -> type { let Out = @shape_concat ( Base , { x : A } ) ; struct ( Out ) }",
    "fn make()->world{World { component_next : { next : 0 } , defaults : @field ( defaults , #key ) }}",
    "fn both(a:bool,b:bool)->bool{ match a { true => match b { true => false , false => true } , false => false } }",
    "fn last()->i32{ let x = 1 ; x // keep final expression comment\n}",
  ];
  for (const snippet of snippets) await assertSafeFormat(snippet);
});

Deno.test("formatter preserves syntax for generated whitespace and comment variants", async () => {
  const snippets = [
    "fn main() -> i32 { let point = {x: 1, y: 2}; point.x }",
    "fn choose(x: i32) -> i32 { match x { 0 => 1, _ => 2 } }",
    "type fn row(A: type, B: type) -> struct { let Row = {left: A, right: B}; struct(Row) }",
    "fn make() -> world { World {defaults: @field(defaults, #key)} }",
    "fn work() -> i32 !{time, gpu} { clock() + 1 }",
  ];

  for (const snippet of snippets) {
    for (const variant of whitespaceVariants(snippet)) {
      await assertSafeFormat(variant, variant);
    }
  }
});

Deno.test("formatter preserves comments in punctuation-sensitive locations", async () => {
  const snippets = [
    "type fn row(A: type) -> struct { let Row = {value: A // slot tail\n}; struct(Row) }",
    "fn classify(x: i32) -> i32 { match x { 0 => 1, // zero\n_ => 2 // fallback\n} }",
    "fn main() -> i32 { let x = 1; x // final expression tail\n}",
    "type fn pair(/// left type\nA: type, /// right type\nB: type) -> struct { let Pair = {left: A, right: B}; struct(Pair) }",
    "fn make() -> world { World {defaults: @field(defaults, #key) // tail\n} }",
    "fn main() -> i32 { let x = 1; // statement tail\nx }",
  ];

  for (const snippet of snippets) await assertSafeFormat(snippet);
});

Deno.test("formatter preserves literals in syntax-sensitive locations", async () => {
  const snippets = [
    'fn main() -> string { let url = "https://example.test/a//b"; url }',
    "fn main() -> char { let slash = '/'; slash }",
    "fn main() -> string { let text = ```line // not comment\nnext```; text }",
    "fn main() -> literal { let tag = #Widget; tag }",
    "fn main() -> f64 { let a = 1; let b = 2.5f64; a + b }",
    "fn work() -> i32 !{time, gpu} { 1 }",
  ];

  for (const snippet of snippets) await assertSafeFormat(snippet);
});

Deno.test("formatter wraps long lines at safe syntax boundaries", async () => {
  const snippets = [
    "fn compute_really_long_signature(alpha_value:i32,beta_value:i32,gamma_value:i32,delta_value:i32,epsilon_value:i32)->result(i32,string){alpha_value+beta_value+gamma_value+delta_value+epsilon_value}",
    "fn call()->i32{combine(first_argument_name,second_argument_name,third_argument_name,fourth_argument_name,fifth_argument_name,sixth_argument_name)}",
    "type fn row(A:type,B:type,C:type,D:type,E:type)->struct{let Row={first:A,second:B,third:C,fourth:D,fifth:E};struct(Row)}",
    "fn classify(x:i32)->i32{match x{0=>very_long_name + another_long_name + third_long_name + fourth_long_name,_=>fallback_value + other_fallback_value}}",
    "fn pipe()->i32{load_extremely_long_input_name()\\value->value.map(first_transform).filter(second_transform).fold(third_transform,fourth_transform)}",
  ];

  for (const snippet of snippets) await assertSafeFormat(snippet);
});

Deno.test("formatter width policy exempts comments and literal content", async () => {
  await assertSafeFormat(
    "fn main() -> string { let text = ```this literal line intentionally exceeds the formatter width because fenced content is indivisible and must not be rewritten```; text }",
  );
  await assertSafeFormat(
    "fn main() -> i32 { 1 // this comment intentionally exceeds the formatter width because comments are indivisible formatter content\n}",
  );
});

Deno.test("formatter literal scanners ignore comment markers inside fenced templates", () => {
  const source = "```template\nhello ${name} // not comment\n``` // real comment\n";
  assertEquals(literalTexts(source), ["```template\nhello ${name} // not comment\n```"]);
  assertEquals(commentTexts(source), ["// real comment"]);
});

Deno.test("CLI fmt --write rewrites only when output differs", async () => {
  const path = await Deno.makeTempFile({ suffix: ".fig" });
  try {
    await Deno.writeTextFile(path, "fn main()->i32{1}");
    const write = await runFigFmt(["--write", path], { allowWrite: true });
    assertEquals(write.success, true);
    assertEquals(await Deno.readTextFile(path), "fn main() -> i32 {\n  1\n}\n");

    const before = await Deno.stat(path);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const writeAgain = await runFigFmt(["--write", path], { allowWrite: true });
    const after = await Deno.stat(path);
    assertEquals(writeAgain.success, true);
    assertEquals(after.mtime?.getTime(), before.mtime?.getTime());
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("CLI fmt --write on invalid Fig leaves file byte-for-byte unchanged", async () => {
  const path = await Deno.makeTempFile({ suffix: ".fig" });
  const original = textEncoder.encode("fn main( -> i32 {\r\n  1\r\n}\r\n");
  try {
    await Deno.writeFile(path, original);
    const output = await runFigFmt(["--write", path], { allowWrite: true });
    assertEquals(output.success, false);
    assertEquals(output.code, 1);
    assertEquals(await Deno.readFile(path), original);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("CLI fmt --check reports status without writing", async () => {
  const path = await Deno.makeTempFile({ suffix: ".fig" });
  try {
    await Deno.writeTextFile(path, "fn main()->i32{1}");
    const checkBad = await runFigFmt(["--check", path]);
    assertEquals(checkBad.code, 1);
    assertStringIncludes(textDecoder.decode(checkBad.stderr), "is not formatted");
    assertEquals(await Deno.readTextFile(path), "fn main()->i32{1}");

    await Deno.writeTextFile(path, formatSource(await Deno.readTextFile(path)));
    const checkGood = await runFigFmt(["--check", path]);
    assertEquals(checkGood.success, true);
    assertEquals(await Deno.readTextFile(path), "fn main() -> i32 {\n  1\n}\n");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("CLI fmt --check reports every unformatted file without writing", async () => {
  const first = await Deno.makeTempFile({ suffix: ".fig" });
  const second = await Deno.makeTempFile({ suffix: ".fig" });
  const third = await Deno.makeTempFile({ suffix: ".fig" });
  try {
    await Deno.writeTextFile(first, "fn first()->i32{1}");
    await Deno.writeTextFile(second, "fn second() -> i32 {\n  2\n}\n");
    await Deno.writeTextFile(third, "fn third()->i32{3}");

    const check = await runFigFmt(["--check", first, second, third]);
    const stderr = textDecoder.decode(check.stderr);
    assertEquals(check.code, 1);
    assertStringIncludes(stderr, `${first} is not formatted`);
    assertStringIncludes(stderr, `${third} is not formatted`);
    assert(!stderr.includes(`${second} is not formatted`));
    assertEquals(await Deno.readTextFile(first), "fn first()->i32{1}");
    assertEquals(await Deno.readTextFile(third), "fn third()->i32{3}");
  } finally {
    await Deno.remove(first);
    await Deno.remove(second);
    await Deno.remove(third);
  }
});

Deno.test("CLI fmt --write accepts multiple files", async () => {
  const first = await Deno.makeTempFile({ suffix: ".fig" });
  const second = await Deno.makeTempFile({ suffix: ".fig" });
  try {
    await Deno.writeTextFile(first, "fn first()->i32{1}");
    await Deno.writeTextFile(second, "fn second()->i32{2}");

    const output = await runFigFmt(["--write", first, second], { allowWrite: true });
    assertEquals(output.success, true);
    assertEquals(await Deno.readTextFile(first), "fn first() -> i32 {\n  1\n}\n");
    assertEquals(await Deno.readTextFile(second), "fn second() -> i32 {\n  2\n}\n");
  } finally {
    await Deno.remove(first);
    await Deno.remove(second);
  }
});

Deno.test("CLI fmt reports nonexistent files", async () => {
  const output = await runFigFmt(["missing-format-input.fig"]);
  assertEquals(output.success, false);
  assertEquals(output.code, 1);
  assertStringIncludes(textDecoder.decode(output.stderr), "missing-format-input.fig");
});

Deno.test("CLI fmt stdin writes only stdout and rejects write/check modes", async () => {
  const output = await runFigFmt(["-"], { stdin: "fn main()->i32{1}" });
  assertEquals(output.success, true);
  assertEquals(textDecoder.decode(output.stdout), "fn main() -> i32 {\n  1\n}\n");

  const write = await runFigFmt(["--write", "-"], { stdin: "fn main()->i32{1}" });
  assertEquals(write.code, 2);
  const check = await runFigFmt(["--check", "-"], { stdin: "fn main()->i32{1}" });
  assertEquals(check.code, 2);
});

Deno.test("formatSource reports parse syntax diagnostics", () => {
  try {
    formatSource("fn main( -> i32 { 1 }");
  } catch (error) {
    assert(error instanceof CompileError);
    assertEquals(error.diagnostics[0]?.code, "parse.syntax");
    assertEquals(error.diagnostics[0]?.span?.line, 1);
    assert(error.diagnostics[0]?.span?.column);
    return;
  }
  throw new Error("expected parse.syntax diagnostic");
});

async function assertFormats(input: string, expected: string): Promise<void> {
  const formatted = formatSource(input);
  assertEquals(formatted, expected);
  await assertSafeFormat(input);
}

async function assertSafeFormat(source: string, label = "source"): Promise<void> {
  const formatted = formatSource(source);
  await parse(formatted);
  assertSyntaxPreserved(source, formatted, label);
  assertEquals(formatSource(formatted), formatted, label);
  assertEquals(isFormatted(formatted), true, label);
  assertCommentsPreserved(source, formatted, label);
  assertLiteralsPreserved(source, formatted, label);
  assertEquals(formatted.includes("\r"), false, label);
  assertEquals(formatted.endsWith("\n"), true, label);
  assertEquals(formatted.endsWith("\n\n"), false, label);
  assertEquals(/[ \t]$/m.test(formatted), false, label);
  assertWidthPolicy(formatted, label);
}

function assertSyntaxPreserved(input: string, formatted: string, label: string): void {
  assertEquals(syntaxSignature(formatted), syntaxSignature(input.replace(/\r\n?/g, "\n")), label);
}

function syntaxSignature(source: string): SyntaxSignature {
  const result = parseSyntax(source);
  assert(result.ok && result.tree, result.diagnostics[0]?.message ?? "syntax error");
  return signatureFor(result.tree);
}

type SyntaxSignature = [kind: "rule", name: string, children: SyntaxSignature[]] | [
  kind: "token" | "literal",
  name: string,
  text: string,
];

function signatureFor(node: ParseNode): SyntaxSignature {
  if (node.kind === "rule") {
    return ["rule", node.name, node.children.map((child) => signatureFor(child))];
  }
  return [node.kind, node.kind === "token" ? node.name : node.value, terminalText(node)];
}

function terminalText(node: Exclude<ParseNode, { kind: "rule" }>): string {
  if (node.kind === "token" && (node.name.endsWith("Repeat") || node.name === "TypeRepeatPrefix")) {
    return node.text.replace(/\s+/g, "");
  }
  return node.text;
}

function assertCommentsPreserved(input: string, formatted: string, label: string): void {
  assertEquals(commentTexts(formatted), commentTexts(input), label);
}

function assertLiteralsPreserved(input: string, formatted: string, label: string): void {
  assertEquals(literalTexts(formatted), literalTexts(input), label);
}

function assertWidthPolicy(formatted: string, label: string): void {
  for (const [index, line] of formatted.split("\n").entries()) {
    assert(
      line.length <= MAX_FORMAT_LINE_WIDTH || isWidthExempt(line),
      `${label}:${index + 1} exceeds ${MAX_FORMAT_LINE_WIDTH} columns: ${line.length}`,
    );
  }
}

function isWidthExempt(line: string): boolean {
  if (line.includes("//") || line.includes("```")) return true;
  return /\S{101,}/.test(line);
}

function commentTexts(source: string): string[] {
  const tokens = lex(source).filter((token) => token.kind !== "eof");
  const comments: string[] = [];
  for (const match of source.matchAll(/\/\/[^\n]*/g)) {
    const start = match.index ?? 0;
    if (!insideLiteral(tokens, start)) comments.push(match[0]);
  }
  return comments;
}

function literalTexts(source: string): string[] {
  return lex(source)
    .filter((token) => literalKinds.has(token.kind))
    .map((token) => token.text);
}

const literalKinds = new Set([
  "String",
  "Char",
  "Int",
  "Float",
  "string",
  "char",
  "integer",
  "float",
  "literal_tag",
  "fenced_text",
  "fenced_template",
]);

function insideLiteral(tokens: Token[], offset: number): boolean {
  return tokens.some((token) =>
    literalKinds.has(token.kind) && token.span.start < offset && offset < token.span.end
  );
}

function whitespaceVariants(source: string): string[] {
  return [
    source,
    source.replaceAll(" ", "  ").replaceAll("\n", "\r\n"),
    source
      .replaceAll("(", " ( ")
      .replaceAll(")", " ) ")
      .replaceAll("[", " [ ")
      .replaceAll("]", " ] ")
      .replaceAll("{", " {\n")
      .replaceAll("}", "\n} ")
      .replaceAll(",", " ,\n")
      .replaceAll(":", " : ")
      .replaceAll(";", " ;\n")
      .replaceAll("=>", " => ")
      .replaceAll("->", " -> "),
    `// leading variant\n${source}\n// trailing variant\n`,
  ];
}

async function* validFigCorpus(): AsyncGenerator<string> {
  for (const root of ["examples", "prelude", "engine", "web", "tests/fixtures/language/good"]) {
    yield* walkFigFiles(root);
  }
}

async function* walkFigFiles(root: string): AsyncGenerator<string> {
  try {
    for await (const entry of Deno.readDir(root)) {
      const path = `${root}/${entry.name}`;
      if (entry.isFile && entry.name.endsWith(".fig")) yield path;
      else if (entry.isDirectory) yield* walkFigFiles(path);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function runFigFmt(
  args: string[],
  options: { allowWrite?: boolean; stdin?: string } = {},
): Promise<Deno.CommandOutput> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      ...(options.allowWrite ? ["--allow-write"] : []),
      "src/cli.ts",
      "fmt",
      ...args,
    ],
    stdin: options.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  });
  if (options.stdin === undefined) return await command.output();
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(textEncoder.encode(options.stdin));
  await writer.close();
  return await child.output();
}
