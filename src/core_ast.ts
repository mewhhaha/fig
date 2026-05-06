export interface Program {
  moduleName?: string;
  imports: CapabilityImport[];
  declarations: Declaration[];
}

export type Declaration = FnDecl | LetDecl | ConstDecl | TypeDecl;

export interface CapabilityImport {
  kind: "import";
  name: string;
  type: string;
  effects: string[];
}

export interface FnDecl {
  kind: "fn";
  public: boolean;
  name: string;
  memberOf?: {
    owner: string;
    member: string;
  };
  params: Param[];
  returnType?: string;
  effects: string[];
  body: BlockExpr;
  generated?: boolean;
}

export interface LetDecl {
  kind: "let";
  name: string;
  type?: string;
  value: Expr;
}

export interface ConstDecl {
  kind: "const";
  name: string;
  type?: string;
  value: Expr;
}

export interface ForkLetDecl {
  kind: "fork_let";
  source: string;
  left: string;
  right: string;
}

export interface ProofConstDecl {
  kind: "proof_const";
  name: string;
  value: TypeExpr;
}

export interface TypeDecl {
  kind: "type";
  name: string;
  params: TypeParam[];
  paramPatterns?: ParamPattern[];
  body: TypeBlock;
  normalized?: TypeBody;
  paramKinds?: Record<string, TypeParamKind>;
  clauses?: TypeDecl[];
}

export type TypeParamKind = "type" | "count" | string;

export interface TypeParam {
  name: string;
  kind: TypeParamKind;
}

export interface TypeBlock {
  kind: "type_block";
  statements: TypeLetDecl[];
  expr?: TypeExpr;
}

export interface TypeLetDecl {
  kind: "type_let";
  name: string;
  value: TypeExpr;
}

export type TypeBody =
  | { kind: "alias"; type: string }
  | { kind: "product"; name: string; constructor: string; shape: ShapeType; members?: TypeMember[] }
  | { kind: "sum"; variants: TypeVariant[]; members?: TypeMember[] };

export interface TypeMember {
  name: string;
  type: string;
  target: string;
}

export interface TypeVariant {
  name: string;
  shape?: ShapeType;
}

export interface ShapeType {
  slots: ShapeTypeSlot[];
}

export interface ShapeTypeSlot {
  label?: string;
  type: string;
  repeat?: string;
}

export type TypeExpr =
  | { kind: "type_ref"; name: string }
  | { kind: "type_call"; callee: TypeExpr; args: TypeExpr[] }
  | { kind: "type_static_ref"; name: string }
  | { kind: "type_fn"; source: string }
  | { kind: "type_shape"; shape: TypeShape }
  | { kind: "type_match"; value: TypeExpr; arms: TypeMatchArm[] }
  | { kind: "type_binary"; op: string; left: TypeExpr; right: TypeExpr }
  | { kind: "type_bool"; value: boolean }
  | { kind: "type_number"; value: string }
  | { kind: "type_string"; value: string }
  | { kind: "type_literal"; value: string };

export interface TypeMatchArm {
  pattern: TypePattern;
  value: TypeExpr;
}

export type TypePattern =
  | { kind: "wildcard" }
  | { kind: "bool"; value: boolean }
  | { kind: "literal"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: string }
  | { kind: "type"; name: string };

export interface TypeShape {
  slots: TypeShapeSlot[];
  members?: TypeMemberExpr[];
}

export interface TypeShapeSlot {
  label?: string;
  type: TypeExpr;
  repeat?: TypeCountExpr;
}

export interface TypeMemberExpr {
  name: string;
  type: string;
  target: string;
  inlineFn?: FnDecl;
}

export interface TypeVariantExpr {
  name: string;
  shape?: TypeShape;
}

export type TypeCountExpr =
  | { kind: "count_literal"; value: number; source: string }
  | { kind: "count_ref"; name: string }
  | { kind: "count_mul"; left: TypeCountExpr; right: TypeCountExpr };

export interface Param {
  name: string;
  type: string;
  const?: boolean;
  pattern?: ParamPattern;
}

export type ParamPattern =
  | { kind: "binding"; name: string }
  | { kind: "wildcard" }
  | { kind: "literal"; value: string; literalKind: "number" | "bool" | "string" | "literalType" }
  | { kind: "constructor"; name: string; args: ParamPattern[] }
  | { kind: "type"; name: string };

export interface BlockExpr {
  kind: "block";
  statements: Statement[];
  expr?: Expr;
}

export type Statement = LetDecl | ForkLetDecl | ProofConstDecl;

export type Expr =
  | {
    kind: "literal";
    value: string;
    literalKind: "number" | "bool" | "string" | "char" | "multiline" | "literalType";
    inferredType?: string;
  }
  | { kind: "var"; name: string }
  | { kind: "call"; callee: Expr; args: Expr[] }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "match"; value: Expr; arms: { pattern: string; value: Expr }[] }
  | { kind: "shape"; slots: { label?: string; value: Expr }[] }
  | { kind: "product_constructor"; constructor: string; slots: { label?: string; value: Expr }[] }
  | { kind: "range"; start: Expr; end: Expr }
  | BlockExpr;
