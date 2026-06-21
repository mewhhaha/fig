export interface GeneratedProject {
  scenario: BenchmarkScenario;
  figDir: string;
  goDir: string;
  figLoc: number;
  goLoc: number;
  modules: number;
  kernelsPerModule: number;
  rootFig: string;
  leafFig: string;
  goRoot: string;
  goLeaf: string;
}

export type BenchmarkScenario = "kernels" | "abstractions";

interface FileOut {
  path: string;
  text: string;
}

export async function generateLargeCompileProject(options: {
  rootDir: string;
  targetLoc: number;
  modules: number;
  scenario?: BenchmarkScenario;
}): Promise<GeneratedProject> {
  const figDir = `${options.rootDir}/fig_project`;
  const goDir = `${options.rootDir}/go_project`;
  await Deno.mkdir(figDir, { recursive: true });
  await Deno.mkdir(goDir, { recursive: true });
  const scenario = options.scenario ?? "kernels";
  const kernelsPerModule = scenario === "abstractions"
    ? Math.max(8, Math.floor(options.targetLoc / options.modules / 5))
    : Math.max(8, Math.floor(options.targetLoc / options.modules / 6));
  const figFiles = scenario === "abstractions"
    ? figAbstractionProject(options.modules, kernelsPerModule)
    : figProject(options.modules, kernelsPerModule);
  for (const file of figFiles) {
    file.text = withFigPreludeOperators(file.text);
  }
  const goFiles = scenario === "abstractions"
    ? goAbstractionProject(options.modules, kernelsPerModule)
    : goProject(options.modules, kernelsPerModule);
  for (const file of figFiles) await writeFile(`${figDir}/${file.path}`, file.text);
  for (const file of goFiles) await writeFile(`${goDir}/${file.path}`, file.text);
  const leafFig = scenario === "abstractions" ? "transforms.fig" : "math.fig";
  const goLeaf = scenario === "abstractions" ? "transforms/transforms.go" : "mathx/mathx.go";
  return {
    scenario,
    figDir,
    goDir,
    figLoc: figFiles.reduce((sum, file) => sum + lineCount(file.text), 0),
    goLoc: goFiles.reduce((sum, file) => sum + lineCount(file.text), 0),
    modules: options.modules,
    kernelsPerModule,
    rootFig: `${figDir}/main.fig`,
    leafFig: `${figDir}/${leafFig}`,
    goRoot: `${goDir}/cmd/app/main.go`,
    goLeaf: `${goDir}/${goLeaf}`,
  };
}

async function writeFile(path: string, text: string) {
  await Deno.mkdir(new URL(".", new URL(`file://${path}`)).pathname, { recursive: true });
  await Deno.writeTextFile(path, text);
}

function withFigPreludeOperators(text: string): string {
  const publicText = text.replace(/^fn entry\(/gm, "pub fn entry(");
  return `const ops = @import("prelude.operators");\n${publicText}`;
}

function figProject(modules: number, kernels: number): FileOut[] {
  const files: FileOut[] = [
    { path: "types.fig", text: figTypes(kernels) },
    { path: "math.fig", text: figMath(kernels) },
    { path: "geometry.fig", text: figGeometry(kernels) },
    { path: "grid.fig", text: figGrid(kernels) },
    { path: "raycast.fig", text: figRaycast(kernels) },
    { path: "matrix.fig", text: figMatrix(kernels) },
    { path: "validation.fig", text: figValidation(kernels) },
    { path: "pipeline.fig", text: figPipeline(kernels) },
  ];
  for (let index = files.length; index < modules; index++) {
    files.push({ path: `feature_${index}.fig`, text: figFeature(index, kernels) });
  }
  files.push({ path: "main.fig", text: figMain(files.map((file) => file.path)) });
  return files;
}

function figTypes(kernels: number): string {
  const lines = [
    `type fn Vec2() -> type {`,
    `  let Vec2 = {x: i32, y: i32};`,
    `  struct(Vec2)`,
    `}`,
    ``,
    `type fn Box2() -> type {`,
    `  let Box2 = {x: i32, y: i32, w: i32, h: i32};`,
    `  struct(Box2)`,
    `}`,
    ``,
    `type fn Sample() -> type {`,
    `  let Sample = {a: i32, b: i32, c: i32, d: i32};`,
    `  struct(Sample)`,
    `}`,
    ``,
    `type fn Lane4I32() -> type {`,
    `  let Lane4I32 = {4*i32};`,
    `  struct(Lane4I32)`,
    `}`,
    ``,
    `fn vec2(x: i32, y: i32) -> Vec2 { Vec2 {x: x, y: y} }`,
    `fn box2(x: i32, y: i32, w: i32, h: i32) -> Box2 { Box2 {x: x, y: y, w: w, h: h} }`,
    `fn sample(a: i32, b: i32, c: i32, d: i32) -> Sample { Sample {a: a, b: b, c: c, d: d} }`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `type fn Payload${index}() -> type {`,
      `  let Payload${index} = {id: i32, x: i32, y: i32, score: i32};`,
      `  struct(Payload${index})`,
      `}`,
      ``,
    );
  }
  return `${lines.join("\n")}\n`;
}

function figMath(kernels: number): string {
  const lines = [
    `fn abs_i32(x: i32) -> i32 { match x < 0 { true => 0 - x, false => x } }`,
    `fn min_i32(a: i32, b: i32) -> i32 { match a < b { true => a, false => b } }`,
    `fn max_i32(a: i32, b: i32) -> i32 { match a > b { true => a, false => b } }`,
    `fn clamp_i32(x: i32, lo: i32, hi: i32) -> i32 { max_i32(lo, min_i32(x, hi)) }`,
    `fn mix_i32(a: i32, b: i32, t: i32) -> i32 { a + ((b - a) * t) / 100 }`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn math_kernel_${index}(seed: i32) -> i32 {`,
      `  let a = seed + ${index + 3};`,
      `  let b = abs_i32((a * ${index % 17 + 1}) - ${index * 3 + 11});`,
      `  let c = clamp_i32(b, ${index % 13}, ${index % 13 + 500});`,
      `  mix_i32(c, a + b, ${index % 100})`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets("math_kernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figGeometry(kernels: number): string {
  const lines = [
    `const types = @import("./types.fig");`,
    `const math = @import("./math.fig");`,
    ``,
    `fn intersects(a: types.Box2, b: types.Box2) -> bool {`,
    `  match a.x < b.x + b.w {`,
    `    true => match b.x < a.x + a.w {`,
    `      true => match a.y < b.y + b.h {`,
    `        true => b.y < a.y + a.h,`,
    `        false => false,`,
    `      },`,
    `      false => false,`,
    `    },`,
    `    false => false,`,
    `  }`,
    `}`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn geometry_kernel_${index}(seed: i32) -> i32 {`,
      `  let player = types.box2(15 + (seed % 3), 15, 20, 20);`,
      `  let candidate = types.box2((${index} % 8) * 10, (${index} / 8) * 10, 8, 8);`,
      `  match intersects(player, candidate) {`,
      `    true => math.math_kernel_${index}(seed) + ${index},`,
      `    false => math.abs_i32(seed - ${index}),`,
      `  }`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets("geometry_kernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figGrid(kernels: number): string {
  const lines = [
    `const math = @import("./math.fig");`,
    ``,
    `fn cell_score(i: i32) -> i32 {`,
    `  ((i % 16) + (i / 16)) \\score ->`,
    `    match score % 5 != 0 { true => score, false => 0 }`,
    `}`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn grid_kernel_${index}(seed: i32) -> i32 {`,
      `  let i = (seed + ${index}) % 256;`,
      `  cell_score(i) + math.clamp_i32(i, 0, 255)`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets("grid_kernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figRaycast(kernels: number): string {
  const lines = [
    `const grid = @import("./grid.fig");`,
    `const math = @import("./math.fig");`,
    ``,
    `fn wall_cell(x: i32, y: i32) -> bool {`,
    `  match x < 0 { true => true, false => match y < 0 { true => true, false => match x >= 16 { true => true, false => y >= 16 } } }`,
    `}`,
    ``,
    `fn cast_ray(step: i32, x: i32, y: i32, dx: i32, dy: i32) -> i32 {`,
    `  match step < 24 {`,
    `    true => match wall_cell(x, y) {`,
    `      true => step,`,
    `      false => cast_ray(step + 1, x + dx, y + dy, dx, dy),`,
    `    },`,
    `    false => 24,`,
    `  }`,
    `}`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn ray_kernel_${index}(seed: i32) -> i32 {`,
      `  let ray = (seed + ${index}) % 64;`,
      `  cast_ray(0, 5 + (seed % 2), 4 + (seed % 3), (ray % 5) - 2, (ray / 16) + 1) \\distance ->`,
      `    distance * (ray + 1) + grid.grid_kernel_${index}(seed) + math.abs_i32(ray)`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets("ray_kernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figMatrix(kernels: number): string {
  const lines = [`const types = @import("./types.fig");`, ``];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn matrix_kernel_${index}(seed: i32) -> i32 {`,
      `  let row: types.Lane4I32 = #[1 + seed - seed, 2, 3, 4];`,
      `  let col: types.Lane4I32 = #[${index % 7 + 1}, 5, 9, 13];`,
      `  row[0] * col[0] + row[1] * col[1] + row[2] * col[2] + row[3] * col[3]`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets("matrix_kernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figValidation(kernels: number): string {
  const lines = [
    `const types = @import("./types.fig");`,
    `const math = @import("./math.fig");`,
    ``,
    `fn normalize(sample: types.Sample) -> i32 {`,
    `  math.clamp_i32(sample.a + sample.b - sample.c + sample.d, 0, 1000000)`,
    `}`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn validation_kernel_${index}(seed: i32) -> i32 {`,
      `  let sample = types.sample(seed + ${index}, seed % 97, ${index % 41}, ${index % 29});`,
      `  normalize(sample)`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets("validation_kernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figPipeline(kernels: number): string {
  const lines = [
    `const geometry = @import("./geometry.fig");`,
    `const grid = @import("./grid.fig");`,
    `const raycast = @import("./raycast.fig");`,
    `const matrix = @import("./matrix.fig");`,
    `const validation = @import("./validation.fig");`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn pipeline_kernel_${index}(seed: i32) -> i32 {`,
      `  geometry.geometry_kernel_${index}(seed) \\a ->`,
      `    grid.grid_kernel_${index}(a) \\b ->`,
      `      raycast.ray_kernel_${index}(b) + matrix.matrix_kernel_${index}(seed) + validation.validation_kernel_${index}(seed)`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets("pipeline_kernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figFeature(moduleIndex: number, kernels: number): string {
  const lines = [
    `const pipeline = @import("./pipeline.fig");`,
    `const math = @import("./math.fig");`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn feature_${moduleIndex}_${index}(seed: i32) -> i32 {`,
      `  pipeline.pipeline_kernel_${index}(seed) + math.math_kernel_${index}(seed + ${moduleIndex})`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets(`feature_${moduleIndex}`, kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figMain(modulePaths: string[]): string {
  const imports = modulePaths
    .filter((path) => path !== "main.fig" && path !== "types.fig")
    .map((path, index) => `const m${index} = @import("./${path}");`);
  const body = imports.map((_, index) => `  let v${index} = m${index}.entry(seed + ${index});`);
  return `${imports.join("\n")}\n\npub fn main(seed: i32) -> i32 {\n${body.join("\n")}\n  ${
    imports.map((_, index) => `v${index}`).join(" + ")
  }\n}\n`;
}

function figAbstractionProject(modules: number, kernels: number): FileOut[] {
  const files: FileOut[] = [
    { path: "core.fig", text: figAbstractionCore(kernels) },
    { path: "transforms.fig", text: figAbstractionTransforms(kernels) },
    { path: "validation.fig", text: figAbstractionValidation(kernels) },
    { path: "pipeline.fig", text: figAbstractionPipeline(kernels) },
    { path: "folds.fig", text: figAbstractionFolds(kernels) },
    { path: "effects.fig", text: figAbstractionEffects(kernels) },
    { path: "arrays.fig", text: figAbstractionArrays(kernels) },
    { path: "operators.fig", text: figAbstractionOperators(kernels) },
  ];
  for (let index = files.length; index < modules; index++) {
    files.push({ path: `feature_${index}.fig`, text: figAbstractionFeature(index, kernels) });
  }
  files.push({ path: "main.fig", text: figMain(files.map((file) => file.path)) });
  return files;
}

function figAbstractionCore(kernels: number): string {
  const lines = [
    `type fn Id(a: type) -> type {`,
    `  a`,
    `}`,
    ``,
    `fn Id::map(const f: fn(x: a) -> b, value: Id(a)) -> Id(b) {`,
    `  f(value)`,
    `}`,
    ``,
    `fn Id::pure(value: a) -> Id(a) {`,
    `  value`,
    `}`,
    ``,
    `fn Id::apply(value: Id(fn(x: a) -> b), arg: Id(a)) -> Id(b) {`,
    `  value(arg)`,
    `}`,
    ``,
    `fn Id::bind(value: Id(a), const f: fn(x: a) -> Id(b)) -> Id(b) {`,
    `  f(value)`,
    `}`,
    ``,
    `type fn Box(a: type) -> type {`,
    `  let Box = {value: a};`,
    `  struct(Box)`,
    `}`,
    ``,
    `fn Box::map(const f: fn(x: a) -> b, value: Box(a)) -> Box(b) {`,
    `  Box {value: f(value.value)}`,
    `}`,
    ``,
    `fn Box::pure(value: a) -> Box(a) {`,
    `  Box {value: value}`,
    `}`,
    ``,
    `fn Box::apply(value: Box(fn(x: a) -> b), arg: Box(a)) -> Box(b) {`,
    `  Box {value: value.value(arg.value)}`,
    `}`,
    ``,
    `fn Box::bind(value: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) {`,
    `  f(value.value)`,
    `}`,
    ``,
    `type fn Pair(a: type, b: type) -> type {`,
    `  let Pair = {first: a, second: b};`,
    `  struct(Pair)`,
    `}`,
    ``,
    `type fn Accum() -> type {`,
    `  let Accum = {value: i32};`,
    `  struct(Accum)`,
    `}`,
    ``,
    `fn add_one(value: i32) -> i32 { value + 1 }`,
    `fn double(value: i32) -> i32 { value * 2 }`,
    `fn square(value: i32) -> i32 { value * value }`,
    `fn combine(left: i32, right: i32) -> i32 { left + right * 3 }`,
    `fn clamp_non_negative(value: i32) -> i32 { match value < 0 { true => 0, false => value } }`,
    `fn box_i32(value: i32) -> Box(i32) { Box {value: value} }`,
    `fn pair_i32(left: i32, right: i32) -> Pair(i32, i32) { Pair {first: left, second: right} }`,
    `fn accum(value: i32) -> Accum { Accum {value: value} }`,
    `fn append_accum(left: Accum, right: Accum) -> Accum { Accum {value: left.value + right.value} }`,
    `fn append_three(left: Accum, middle: Accum, right: Accum) -> Accum { append_accum(append_accum(left, middle), right) }`,
    `fn id_map_i32(const f: fn(x: i32) -> i32, value: Id(i32)) -> Id(i32) { Id::map(f, value) }`,
    `fn id_bind_i32(value: Id(i32), const f: fn(x: i32) -> Id(i32)) -> Id(i32) { Id::bind(value, f) }`,
    `fn box_map_i32(const f: fn(x: i32) -> i32, value: Box(i32)) -> Box(i32) { Box::map(f, value) }`,
    `fn box_bind_i32(value: Box(i32), const f: fn(x: i32) -> Box(i32)) -> Box(i32) { Box::bind(value, f) }`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn lift_${index}(value: i32) -> Box(i32) {`,
      `  box_map_i32(add_one, box_i32(value + ${index % 11}))`,
      `}`,
      ``,
      `fn accumulate_${index}(seed: i32) -> Accum {`,
      `  append_three(accum(seed), accum(${index}), accum(seed % ${index % 17 + 3}))`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, figSumFieldLets("accumulate", "value", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figAbstractionTransforms(kernels: number): string {
  const lines = [
    `const core = @import("./core.fig");`,
    ``,
    `fn double_transform(value: i32) -> i32 { value * 2 }`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn inc_${index}(seed: i32) -> i32 {`,
      `  seed + ${index + 3}`,
      `}`,
      ``,
      `fn wrap_${index}(seed: i32) -> core.Box(i32) {`,
      `  core.box_i32(inc_${index}(seed))`,
      `}`,
      ``,
      `fn map_${index}(seed: i32) -> core.Box(i32) {`,
      `  core.box_i32(double_transform(wrap_${index}(seed).value))`,
      `}`,
      ``,
      `fn pair_${index}(seed: i32) -> core.Pair(i32, i32) {`,
      `  map_${index}(seed) \\box ->`,
      `    core.pair_i32(box.value, inc_${index}(seed + ${index % 5}))`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, figSumFieldLets("map", "value", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figAbstractionValidation(kernels: number): string {
  const lines = [
    `const core = @import("./core.fig");`,
    `const transforms = @import("./transforms.fig");`,
    ``,
    `fn keep_even(value: i32) -> i32 {`,
    `  match value % 2 == 0 { true => value, false => value + 1 }`,
    `}`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn validate_${index}(seed: i32) -> i32 {`,
      `  let left = transforms.inc_${index}(seed);`,
      `  let right = transforms.inc_${index}(seed + ${index % 7});`,
      `  core.combine(left, right)`,
      `}`,
      ``,
      `fn checked_${index}(seed: i32) -> i32 {`,
      `  keep_even(validate_${index}(seed)) \\value ->`,
      `    core.clamp_non_negative(value - ${index % 19})`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets("checked", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figAbstractionPipeline(kernels: number): string {
  const lines = [
    `const core = @import("./core.fig");`,
    `const transforms = @import("./transforms.fig");`,
    `const validation = @import("./validation.fig");`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn continue_${index}(value: i32) -> core.Box(i32) {`,
      `  core.box_i32(validation.checked_${index}(value))`,
      `}`,
      ``,
      `fn pipeline_${index}(seed: i32) -> i32 {`,
      `  transforms.map_${index}(seed) \\box ->`,
      `    continue_${index}(box.value).value + validation.validate_${index}(seed)`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets("pipeline", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figAbstractionFolds(kernels: number): string {
  const lines = [
    `const core = @import("./core.fig");`,
    `const pipeline = @import("./pipeline.fig");`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn fold_${index}(seed: i32) -> core.Accum {`,
      `  let left = core.accum(pipeline.pipeline_${index}(seed));`,
      `  let right = core.accumulate_${index}(seed);`,
      `  core.append_three(left, right, core.accum(${index % 23}))`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, figSumFieldLets("fold", "value", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figAbstractionEffects(kernels: number): string {
  const lines = [
    `const core = @import("./core.fig");`,
    `const validation = @import("./validation.fig");`,
    ``,
    `fn add_one_id(value: i32) -> core.Id(i32) {`,
    `  core.add_one(value)`,
    `}`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn effect_${index}(seed: i32) -> core.Id(i32) {`,
      `  add_one_id(validation.checked_${index}(seed))`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets("effect", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figAbstractionArrays(kernels: number): string {
  const lines = [
    `const core = @import("./core.fig");`,
    `const transforms = @import("./transforms.fig");`,
    ``,
    `type fn Lane4I32() -> type {`,
    `  let Lane4I32 = {4*i32};`,
    `  struct(Lane4I32)`,
    `}`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn array_${index}(seed: i32) -> core.Box(i32) {`,
      `  let lane: Lane4I32 = #[seed, transforms.inc_${index}(seed), ${index % 31}, ${
        index % 17
      }];`,
      `  core.box_i32(lane[0] + lane[1] + lane[2] + lane[3])`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, figSumFieldLets("array", "value", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figAbstractionOperators(kernels: number): string {
  const lines = [
    `const core = @import("./core.fig");`,
    `const folds = @import("./folds.fig");`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn op_${index}(seed: i32) -> i32 {`,
      `  core.append_three(folds.fold_${index}(seed), core.accumulate_${index}(seed), core.accum(${index})).value`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets("op", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function figAbstractionFeature(moduleIndex: number, kernels: number): string {
  const lines = [
    `const arrays = @import("./arrays.fig");`,
    `const effects = @import("./effects.fig");`,
    `const operators = @import("./operators.fig");`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `fn feature_${moduleIndex}_${index}(seed: i32) -> i32 {`,
      `  arrays.array_${index}(seed).value + effects.effect_${index}(seed) + operators.op_${index}(seed + ${moduleIndex})`,
      `}`,
      ``,
    );
  }
  lines.push(`fn entry(seed: i32) -> i32 {`, sumLets(`feature_${moduleIndex}`, kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function sumLets(prefix: string, kernels: number): string {
  const lines: string[] = [];
  for (let index = 0; index < kernels; index++) {
    lines.push(`  let v${index} = ${prefix}_${index}(seed + ${index});`);
  }
  lines.push(`  ${Array.from({ length: kernels }, (_, index) => `v${index}`).join(" + ")}`);
  return lines.join("\n");
}

function figSumFieldLets(prefix: string, field: string, kernels: number): string {
  const lines: string[] = [];
  for (let index = 0; index < kernels; index++) {
    lines.push(`  let v${index} = ${prefix}_${index}(seed + ${index}).${field};`);
  }
  lines.push(`  ${Array.from({ length: kernels }, (_, index) => `v${index}`).join(" + ")}`);
  return lines.join("\n");
}

function goProject(modules: number, kernels: number): FileOut[] {
  const files: FileOut[] = [
    { path: "go.mod", text: "module largebench\n\ngo 1.26\n" },
    { path: "types/types.go", text: goTypes(kernels) },
    { path: "mathx/mathx.go", text: goMath(kernels) },
    { path: "geometry/geometry.go", text: goGeometry(kernels) },
    { path: "grid/grid.go", text: goGrid(kernels) },
    { path: "raycast/raycast.go", text: goRaycast(kernels) },
    { path: "matrix/matrix.go", text: goMatrix(kernels) },
    { path: "validation/validation.go", text: goValidation(kernels) },
    { path: "pipeline/pipeline.go", text: goPipeline(kernels) },
  ];
  for (let index = files.length - 1; index < modules; index++) {
    files.push({ path: `feature${index}/feature${index}.go`, text: goFeature(index, kernels) });
  }
  files.push({ path: "cmd/app/main.go", text: goMain(modules) });
  return files;
}

function goTypes(kernels: number): string {
  const lines = [
    `package types`,
    ``,
    `type Vec2 struct { X int32; Y int32 }`,
    `type Box2 struct { X int32; Y int32; W int32; H int32 }`,
    `type Sample struct { A int32; B int32; C int32; D int32 }`,
    `type Lane4I32 [4]int32`,
    ``,
    `func Vec2Of(x int32, y int32) Vec2 { return Vec2{X: x, Y: y} }`,
    `func Box2Of(x int32, y int32, w int32, h int32) Box2 { return Box2{X: x, Y: y, W: w, H: h} }`,
    `func SampleOf(a int32, b int32, c int32, d int32) Sample { return Sample{A: a, B: b, C: c, D: d} }`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(`type Payload${index} struct { Id int32; X int32; Y int32; Score int32 }`);
  }
  return `${lines.join("\n")}\n`;
}

function goMath(kernels: number): string {
  const lines = [
    `package mathx`,
    ``,
    `func AbsI32(x int32) int32 { if x < 0 { return -x }; return x }`,
    `func MinI32(a int32, b int32) int32 { if a < b { return a }; return b }`,
    `func MaxI32(a int32, b int32) int32 { if a > b { return a }; return b }`,
    `func ClampI32(x int32, lo int32, hi int32) int32 { return MaxI32(lo, MinI32(x, hi)) }`,
    `func MixI32(a int32, b int32, t int32) int32 { return a + ((b-a)*t)/100 }`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func MathKernel${index}(seed int32) int32 {`,
      `  a := seed + ${index + 3}`,
      `  b := AbsI32((a * ${index % 17 + 1}) - ${index * 3 + 11})`,
      `  c := ClampI32(b, ${index % 13}, ${index % 13 + 500})`,
      `  return MixI32(c, a+b, ${index % 100})`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumLets("MathKernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goGeometry(kernels: number): string {
  const lines = [
    `package geometry`,
    ``,
    `import (`,
    `  "largebench/mathx"`,
    `  "largebench/types"`,
    `)`,
    ``,
    `func Intersects(a types.Box2, b types.Box2) bool {`,
    `  return a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H`,
    `}`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func GeometryKernel${index}(seed int32) int32 {`,
      `  player := types.Box2Of(15+(seed%3), 15, 20, 20)`,
      `  candidate := types.Box2Of((${index}%8)*10, (${index}/8)*10, 8, 8)`,
      `  if Intersects(player, candidate) { return mathx.MathKernel${index}(seed) + ${index} }`,
      `  return mathx.AbsI32(seed - ${index})`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumLets("GeometryKernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goGrid(kernels: number): string {
  const lines = [
    `package grid`,
    ``,
    `import "largebench/mathx"`,
    ``,
    `func CellScore(i int32) int32 {`,
    `  score := (i % 16) + (i / 16)`,
    `  if score % 5 != 0 { return score }`,
    `  return 0`,
    `}`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func GridKernel${index}(seed int32) int32 {`,
      `  i := (seed + ${index}) % 256`,
      `  return CellScore(i) + mathx.ClampI32(i, 0, 255)`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumLets("GridKernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goRaycast(kernels: number): string {
  const lines = [
    `package raycast`,
    ``,
    `import (`,
    `  "largebench/grid"`,
    `  "largebench/mathx"`,
    `)`,
    ``,
    `func WallCell(x int32, y int32) bool { return x < 0 || y < 0 || x >= 16 || y >= 16 }`,
    `func CastRay(step int32, x int32, y int32, dx int32, dy int32) int32 {`,
    `  for step < 24 { if WallCell(x, y) { return step }; step += 1; x += dx; y += dy }`,
    `  return 24`,
    `}`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func RayKernel${index}(seed int32) int32 {`,
      `  ray := (seed + ${index}) % 64`,
      `  distance := CastRay(0, 5+(seed%2), 4+(seed%3), (ray%5)-2, (ray/16)+1)`,
      `  return distance*(ray+1) + grid.GridKernel${index}(seed) + mathx.AbsI32(ray)`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumLets("RayKernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goMatrix(kernels: number): string {
  const lines = [`package matrix`, ``, `import "largebench/types"`, ``];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func MatrixKernel${index}(seed int32) int32 {`,
      `  row := types.Lane4I32{1 + seed - seed, 2, 3, 4}`,
      `  col := types.Lane4I32{${index % 7 + 1}, 5, 9, 13}`,
      `  return row[0]*col[0] + row[1]*col[1] + row[2]*col[2] + row[3]*col[3]`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumLets("MatrixKernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goValidation(kernels: number): string {
  const lines = [
    `package validation`,
    ``,
    `import (`,
    `  "largebench/mathx"`,
    `  "largebench/types"`,
    `)`,
    ``,
    `func Normalize(sample types.Sample) int32 { return mathx.ClampI32(sample.A+sample.B-sample.C+sample.D, 0, 1000000) }`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func ValidationKernel${index}(seed int32) int32 {`,
      `  sample := types.SampleOf(seed+${index}, seed%97, ${index % 41}, ${index % 29})`,
      `  return Normalize(sample)`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumLets("ValidationKernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goPipeline(kernels: number): string {
  const lines = [
    `package pipeline`,
    ``,
    `import (`,
    `  "largebench/geometry"`,
    `  "largebench/grid"`,
    `  "largebench/matrix"`,
    `  "largebench/raycast"`,
    `  "largebench/validation"`,
    `)`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func PipelineKernel${index}(seed int32) int32 {`,
      `  a := geometry.GeometryKernel${index}(seed)`,
      `  b := grid.GridKernel${index}(a)`,
      `  return raycast.RayKernel${index}(b) + matrix.MatrixKernel${index}(seed) + validation.ValidationKernel${index}(seed)`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumLets("PipelineKernel", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goFeature(moduleIndex: number, kernels: number): string {
  const packageName = `feature${moduleIndex}`;
  const lines = [
    `package ${packageName}`,
    ``,
    `import (`,
    `  "largebench/mathx"`,
    `  "largebench/pipeline"`,
    `)`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func Feature${moduleIndex}_${index}(seed int32) int32 {`,
      `  return pipeline.PipelineKernel${index}(seed) + mathx.MathKernel${index}(seed+${moduleIndex})`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumLets(`Feature${moduleIndex}_`, kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goMain(modules: number): string {
  const imports = [
    `"largebench/types"`,
    `"largebench/mathx"`,
    `"largebench/geometry"`,
    `"largebench/grid"`,
    `"largebench/raycast"`,
    `"largebench/matrix"`,
    `"largebench/validation"`,
    `"largebench/pipeline"`,
  ];
  for (let index = 8; index < modules; index++) imports.push(`"largebench/feature${index}"`);
  const lines = [`package main`, ``, `import (`, ...imports.map((item) => `  ${item}`), `)`, ``];
  lines.push(`func MainValue(seed int32) int32 {`);
  lines.push(`  _ = types.Vec2Of(seed, seed+1)`);
  lines.push(`  v0 := mathx.Entry(seed)`);
  lines.push(`  v1 := geometry.Entry(seed+1)`);
  lines.push(`  v2 := grid.Entry(seed+2)`);
  lines.push(`  v3 := raycast.Entry(seed+3)`);
  lines.push(`  v4 := matrix.Entry(seed+4)`);
  lines.push(`  v5 := validation.Entry(seed+5)`);
  lines.push(`  v6 := pipeline.Entry(seed+6)`);
  const values = ["v0", "v1", "v2", "v3", "v4", "v5", "v6"];
  for (let index = 8; index < modules; index++) {
    const valueName = `v${index}`;
    values.push(valueName);
    lines.push(`  ${valueName} := feature${index}.Entry(seed+${index})`);
  }
  lines.push(`  return ${values.join(" + ")}`);
  lines.push(`}`, ``, `func main() { _ = MainValue(1) }`, ``);
  return lines.join("\n");
}

function goAbstractionProject(modules: number, kernels: number): FileOut[] {
  const files: FileOut[] = [
    { path: "go.mod", text: "module largebench\n\ngo 1.26\n" },
    { path: "core/core.go", text: goAbstractionCore(kernels) },
    { path: "transforms/transforms.go", text: goAbstractionTransforms(kernels) },
    { path: "validation/validation.go", text: goAbstractionValidation(kernels) },
    { path: "pipeline/pipeline.go", text: goAbstractionPipeline(kernels) },
    { path: "folds/folds.go", text: goAbstractionFolds(kernels) },
    { path: "effects/effects.go", text: goAbstractionEffects(kernels) },
    { path: "arrays/arrays.go", text: goAbstractionArrays(kernels) },
    { path: "operators/operators.go", text: goAbstractionOperators(kernels) },
  ];
  for (let index = files.length - 1; index < modules; index++) {
    files.push({
      path: `feature${index}/feature${index}.go`,
      text: goAbstractionFeature(index, kernels),
    });
  }
  files.push({ path: "cmd/app/main.go", text: goAbstractionMain(modules) });
  return files;
}

function goAbstractionCore(kernels: number): string {
  const lines = [
    `package core`,
    ``,
    `type Id[T any] struct { Value T }`,
    `type Box[T any] struct { Value T }`,
    `type Pair[A any, B any] struct { First A; Second B }`,
    `type Accum struct { Value int32 }`,
    ``,
    `func IdPure[T any](value T) Id[T] { return Id[T]{Value: value} }`,
    `func IdValue[T any](value Id[T]) T { return value.Value }`,
    `func IdMap[A any, B any](f func(A) B, value Id[A]) Id[B] { return IdPure(f(value.Value)) }`,
    `func IdApply[A any, B any](value Id[func(A) B], arg Id[A]) Id[B] { return IdPure(value.Value(arg.Value)) }`,
    `func IdBind[A any, B any](value Id[A], f func(A) Id[B]) Id[B] { return f(value.Value) }`,
    `func BoxPure[T any](value T) Box[T] { return Box[T]{Value: value} }`,
    `func BoxMap[A any, B any](f func(A) B, value Box[A]) Box[B] { return BoxPure(f(value.Value)) }`,
    `func BoxApply[A any, B any](value Box[func(A) B], arg Box[A]) Box[B] { return BoxPure(value.Value(arg.Value)) }`,
    `func BoxBind[A any, B any](value Box[A], f func(A) Box[B]) Box[B] { return f(value.Value) }`,
    `func PairI32(left int32, right int32) Pair[int32, int32] { return Pair[int32, int32]{First: left, Second: right} }`,
    `func AccumOf(value int32) Accum { return Accum{Value: value} }`,
    `func AppendAccum(left Accum, right Accum) Accum { return Accum{Value: left.Value + right.Value} }`,
    `func AppendThree(left Accum, middle Accum, right Accum) Accum { return AppendAccum(AppendAccum(left, middle), right) }`,
    `func AddOne(value int32) int32 { return value + 1 }`,
    `func Double(value int32) int32 { return value * 2 }`,
    `func Square(value int32) int32 { return value * value }`,
    `func Combine(left int32, right int32) int32 { return left + right * 3 }`,
    `func ClampNonNegative(value int32) int32 { if value < 0 { return 0 }; return value }`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func Lift${index}(value int32) Box[int32] {`,
      `  return BoxMap(AddOne, BoxPure(value + ${index % 11}))`,
      `}`,
      ``,
      `func Accumulate${index}(seed int32) Accum {`,
      `  return AppendThree(AccumOf(seed), AccumOf(${index}), AccumOf(seed % ${index % 17 + 3}))`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumFieldLets("Accumulate", "Value", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goAbstractionTransforms(kernels: number): string {
  const lines = [
    `package transforms`,
    ``,
    `import "largebench/core"`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func Inc${index}(seed int32) int32 {`,
      `  return seed + ${index + 3}`,
      `}`,
      ``,
      `func Wrap${index}(seed int32) core.Box[int32] {`,
      `  return core.BoxPure(Inc${index}(seed))`,
      `}`,
      ``,
      `func Map${index}(seed int32) core.Box[int32] {`,
      `  return core.BoxMap(core.Double, Wrap${index}(seed))`,
      `}`,
      ``,
      `func Pair${index}(seed int32) core.Pair[int32, int32] {`,
      `  box := Map${index}(seed)`,
      `  return core.PairI32(box.Value, Inc${index}(seed + ${index % 5}))`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumFieldLets("Map", "Value", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goAbstractionValidation(kernels: number): string {
  const lines = [
    `package validation`,
    ``,
    `import (`,
    `  "largebench/core"`,
    `  "largebench/transforms"`,
    `)`,
    ``,
    `func KeepEven(value int32) core.Id[int32] {`,
    `  if value % 2 == 0 { return core.IdPure(value) }`,
    `  return core.IdPure(value + 1)`,
    `}`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func Validate${index}(seed int32) core.Id[int32] {`,
      `  left := transforms.Inc${index}(seed)`,
      `  right := transforms.Inc${index}(seed + ${index % 7})`,
      `  return core.IdPure(core.Combine(left, right))`,
      `}`,
      ``,
      `func Checked${index}(seed int32) core.Id[int32] {`,
      `  value := core.IdValue(Validate${index}(seed))`,
      `  return core.IdBind(KeepEven(value), func(value int32) core.Id[int32] {`,
      `    return core.IdPure(core.ClampNonNegative(value - ${index % 19}))`,
      `  })`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumIdValueLets("Checked", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goAbstractionPipeline(kernels: number): string {
  const lines = [
    `package pipeline`,
    ``,
    `import (`,
    `  "largebench/core"`,
    `  "largebench/transforms"`,
    `  "largebench/validation"`,
    `)`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func Continue${index}(value int32) core.Box[int32] {`,
      `  return core.BoxPure(core.IdValue(validation.Checked${index}(value)))`,
      `}`,
      ``,
      `func Pipeline${index}(seed int32) int32 {`,
      `  box := transforms.Map${index}(seed)`,
      `  return core.BoxBind(box, Continue${index}).Value + core.IdValue(validation.Validate${index}(seed))`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumLets("Pipeline", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goAbstractionFolds(kernels: number): string {
  const lines = [
    `package folds`,
    ``,
    `import (`,
    `  "largebench/core"`,
    `  "largebench/pipeline"`,
    `)`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func Fold${index}(seed int32) core.Accum {`,
      `  left := core.AccumOf(pipeline.Pipeline${index}(seed))`,
      `  right := core.Accumulate${index}(seed)`,
      `  return core.AppendThree(left, right, core.AccumOf(${index % 23}))`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumFieldLets("Fold", "Value", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goAbstractionEffects(kernels: number): string {
  const lines = [
    `package effects`,
    ``,
    `import (`,
    `  "largebench/core"`,
    `  "largebench/validation"`,
    `)`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func Effect${index}(seed int32) core.Id[int32] {`,
      `  return core.IdBind(validation.Checked${index}(seed), func(value int32) core.Id[int32] {`,
      `    return core.IdPure(core.AddOne(value))`,
      `  })`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumIdValueLets("Effect", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goAbstractionArrays(kernels: number): string {
  const lines = [
    `package arrays`,
    ``,
    `import (`,
    `  "largebench/core"`,
    `  "largebench/transforms"`,
    `)`,
    ``,
    `type Lane4I32 [4]int32`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func Array${index}(seed int32) core.Box[int32] {`,
      `  lane := Lane4I32{seed, transforms.Inc${index}(seed), ${index % 31}, ${index % 17}}`,
      `  return core.BoxPure(lane[0] + lane[1] + lane[2] + lane[3])`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumFieldLets("Array", "Value", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goAbstractionOperators(kernels: number): string {
  const lines = [
    `package operators`,
    ``,
    `import (`,
    `  "largebench/core"`,
    `  "largebench/folds"`,
    `)`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func Op${index}(seed int32) int32 {`,
      `  return core.AppendThree(folds.Fold${index}(seed), core.Accumulate${index}(seed), core.AccumOf(${index})).Value`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumLets("Op", kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goAbstractionFeature(moduleIndex: number, kernels: number): string {
  const packageName = `feature${moduleIndex}`;
  const lines = [
    `package ${packageName}`,
    ``,
    `import (`,
    `  "largebench/arrays"`,
    `  "largebench/core"`,
    `  "largebench/effects"`,
    `  "largebench/operators"`,
    `)`,
    ``,
  ];
  for (let index = 0; index < kernels; index++) {
    lines.push(
      `func Feature${moduleIndex}_${index}(seed int32) int32 {`,
      `  return arrays.Array${index}(seed).Value + core.IdValue(effects.Effect${index}(seed)) + operators.Op${index}(seed+${moduleIndex})`,
      `}`,
      ``,
    );
  }
  lines.push(`func Entry(seed int32) int32 {`, goSumLets(`Feature${moduleIndex}_`, kernels), `}`);
  return `${lines.join("\n")}\n`;
}

function goAbstractionMain(modules: number): string {
  const imports = [
    `"largebench/arrays"`,
    `"largebench/core"`,
    `"largebench/effects"`,
    `"largebench/folds"`,
    `"largebench/operators"`,
    `"largebench/pipeline"`,
    `"largebench/transforms"`,
    `"largebench/validation"`,
  ];
  for (let index = 8; index < modules; index++) imports.push(`"largebench/feature${index}"`);
  const lines = [`package main`, ``, `import (`, ...imports.map((item) => `  ${item}`), `)`, ``];
  const values = ["v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"];
  lines.push(`func MainValue(seed int32) int32 {`);
  lines.push(`  _ = core.PairI32(seed, seed+1)`);
  lines.push(`  v0 := core.Entry(seed)`);
  lines.push(`  v1 := transforms.Entry(seed+1)`);
  lines.push(`  v2 := validation.Entry(seed+2)`);
  lines.push(`  v3 := pipeline.Entry(seed+3)`);
  lines.push(`  v4 := folds.Entry(seed+4)`);
  lines.push(`  v5 := effects.Entry(seed+5)`);
  lines.push(`  v6 := arrays.Entry(seed+6)`);
  lines.push(`  v7 := operators.Entry(seed+7)`);
  for (let index = 8; index < modules; index++) {
    const valueName = `v${index}`;
    values.push(valueName);
    lines.push(`  ${valueName} := feature${index}.Entry(seed+${index})`);
  }
  lines.push(`  return ${values.join(" + ")}`);
  lines.push(`}`, ``, `func main() { _ = MainValue(1) }`, ``);
  return lines.join("\n");
}

function goSumLets(prefix: string, kernels: number): string {
  const lines: string[] = [];
  for (let index = 0; index < kernels; index++) {
    lines.push(`  v${index} := ${prefix}${index}(seed + ${index})`);
  }
  lines.push(`  return ${Array.from({ length: kernels }, (_, index) => `v${index}`).join(" + ")}`);
  return lines.join("\n");
}

function goSumFieldLets(prefix: string, field: string, kernels: number): string {
  const lines: string[] = [];
  for (let index = 0; index < kernels; index++) {
    lines.push(`  v${index} := ${prefix}${index}(seed + ${index}).${field}`);
  }
  lines.push(`  return ${Array.from({ length: kernels }, (_, index) => `v${index}`).join(" + ")}`);
  return lines.join("\n");
}

function goSumIdValueLets(prefix: string, kernels: number): string {
  const lines: string[] = [];
  for (let index = 0; index < kernels; index++) {
    lines.push(`  v${index} := core.IdValue(${prefix}${index}(seed + ${index}))`);
  }
  lines.push(`  return ${Array.from({ length: kernels }, (_, index) => `v${index}`).join(" + ")}`);
  return lines.join("\n");
}

function lineCount(text: string): number {
  return text.split("\n").length;
}
