import type { Span } from "./diagnostics.ts";

export interface AstNodeMeta {
  span?: Span;
  nameSpan?: Span;
}

export interface Program {
  moduleName?: string;
  imports: CapabilityImport[];
  sourceImports?: SourceImport[];
  declarations: Declaration[];
}

export type Declaration = FnDecl | LetDecl | ConstDecl | TypeDecl;

export interface CapabilityImport extends AstNodeMeta {
  kind: "import";
  name: string;
  type: string;
  effects: string[];
}

export interface SourceImport extends AstNodeMeta {
  kind: "source_import";
  module: string;
  alias?: string;
  bindings?: SourceImportBinding[];
}

export interface SourceImportBinding extends AstNodeMeta {
  name: string;
}

export interface FnDecl extends AstNodeMeta {
  kind: "fn";
  doc?: string;
  public: boolean;
  name: string;
  memberOf?: {
    owner: string;
    member: string;
    span?: Span;
    nameSpan?: Span;
  };
  params: Param[];
  locals?: Param[];
  returnType?: string;
  effects: string[];
  body: BlockExpr;
  generated?: boolean;
  generatedInlineable?: boolean;
  primitiveId?: string;
}

export interface LetDecl extends AstNodeMeta {
  kind: "let";
  doc?: string;
  name: string;
  type?: string;
  value: Expr;
}

export interface ConstDecl extends AstNodeMeta {
  kind: "const";
  doc?: string;
  name: string;
  type?: string;
  value: Expr;
}

export interface DestructureLetDecl extends AstNodeMeta {
  kind: "destructure_let";
  names: string[];
  nameSpans?: Record<string, Span>;
  nameDocs?: Record<string, string>;
  value: Expr;
  slotTypes?: string[];
}

export interface ProofConstDecl extends AstNodeMeta {
  kind: "proof_const";
  doc?: string;
  name: string;
  value: TypeExpr;
}

export interface TypeDecl extends AstNodeMeta {
  kind: "type";
  doc?: string;
  name: string;
  params: TypeParam[];
  resultKind: TypeResultKind;
  paramPatterns?: ParamPattern[];
  body: TypeBlock;
  normalized?: TypeBody;
  paramKinds?: Record<string, TypeParamKind>;
  clauses?: TypeDecl[];
}

export type TypeResultKind = "type" | "struct" | "union" | "operator";

export type TypeParamKind =
  | "type"
  | "count"
  | "bool"
  | "i32"
  | "numeric"
  | "string"
  | "char"
  | "multiline"
  | "literal"
  | string;

export interface TypeParam extends AstNodeMeta {
  doc?: string;
  name: string;
  kind: TypeParamKind;
}

export interface TypeBlock extends AstNodeMeta {
  kind: "type_block";
  statements: TypeLetDecl[];
  expr?: TypeExpr;
}

export interface TypeLetDecl extends AstNodeMeta {
  kind: "type_let";
  doc?: string;
  name: string;
  value: TypeExpr;
}

export type TypeBody =
  | { kind: "alias"; type: string }
  | { kind: "product"; name: string; constructor: string; shape: ShapeType; members?: TypeMember[] }
  | { kind: "sum"; variants: TypeVariant[]; members?: TypeMember[] }
  | { kind: "operator"; descriptor: OperatorDescriptor };

export interface OperatorDescriptor {
  fixity: "#prefix" | "#postfix" | "#infixl" | "#infixr" | "#infix" | "#nullary";
  precedence: number;
  symbol: string;
  target: string;
}

export interface TypeMember extends AstNodeMeta {
  doc?: string;
  name: string;
  type: string;
  target: string;
}

export interface TypeVariant extends AstNodeMeta {
  doc?: string;
  name: string;
  shape?: ShapeType;
}

export interface ShapeType extends AstNodeMeta {
  slots: ShapeTypeSlot[];
}

export interface ShapeTypeSlot extends AstNodeMeta {
  doc?: string;
  label?: string;
  position?: number;
  type: string;
  repeat?: string;
}

export type TypeExpr =
  | ({ kind: "type_ref"; name: string } & AstNodeMeta)
  | ({ kind: "type_call"; callee: TypeExpr; args: TypeExpr[] } & AstNodeMeta)
  | ({ kind: "type_static_ref"; name: string } & AstNodeMeta)
  | ({ kind: "type_fn"; source: string } & AstNodeMeta)
  | ({ kind: "type_shape"; shape: TypeShape } & AstNodeMeta)
  | ({ kind: "type_match"; value: TypeExpr; arms: TypeMatchArm[] } & AstNodeMeta)
  | ({ kind: "type_operator"; descriptor: OperatorDescriptor } & AstNodeMeta)
  | ({ kind: "type_binary"; op: "==" | "!=" | "|"; left: TypeExpr; right: TypeExpr } & AstNodeMeta)
  | ({ kind: "type_bool"; value: boolean } & AstNodeMeta)
  | ({ kind: "type_number"; value: string } & AstNodeMeta)
  | ({ kind: "type_char"; value: string } & AstNodeMeta)
  | ({ kind: "type_string"; value: string } & AstNodeMeta)
  | ({ kind: "type_literal"; value: string } & AstNodeMeta);

export interface TypeMatchArm extends AstNodeMeta {
  pattern: TypePattern;
  value: TypeExpr;
}

export type TypePattern =
  | ({ kind: "wildcard" } & AstNodeMeta)
  | ({ kind: "bool"; value: boolean } & AstNodeMeta)
  | ({ kind: "literal"; value: string } & AstNodeMeta)
  | ({ kind: "string"; value: string } & AstNodeMeta)
  | ({ kind: "char"; value: string } & AstNodeMeta)
  | ({ kind: "number"; value: string } & AstNodeMeta)
  | ({ kind: "type"; name: string } & AstNodeMeta);

export interface TypeShape extends AstNodeMeta {
  slots: TypeShapeSlot[];
  members?: TypeMemberExpr[];
}

export interface TypeShapeSlot extends AstNodeMeta {
  doc?: string;
  label?: string;
  position?: number;
  type: TypeExpr;
  repeat?: TypeCountExpr;
}

export interface TypeMemberExpr extends AstNodeMeta {
  doc?: string;
  name: string;
  type: string;
  target: string;
  inlineFn?: FnDecl;
}

export interface TypeVariantExpr extends AstNodeMeta {
  doc?: string;
  name: string;
  shape?: TypeShape;
}

export type TypeCountExpr =
  | ({ kind: "count_literal"; value: number; source: string } & AstNodeMeta)
  | ({ kind: "count_ref"; name: string } & AstNodeMeta)
  | ({ kind: "count_mul"; left: TypeCountExpr; right: TypeCountExpr } & AstNodeMeta);

export interface Param extends AstNodeMeta {
  doc?: string;
  name: string;
  type: string;
  const?: boolean;
  inferStaticType?: boolean;
  pattern?: ParamPattern;
}

export type ParamPattern =
  | ({ kind: "binding"; name: string } & AstNodeMeta)
  | ({ kind: "wildcard" } & AstNodeMeta)
  | (
    & {
      kind: "literal";
      value: string;
      literalKind: "number" | "bool" | "string" | "char" | "literalType";
    }
    & AstNodeMeta
  )
  | ({ kind: "tuple"; items: ParamPattern[] } & AstNodeMeta)
  | ({ kind: "constructor"; name: string; args: ParamPattern[] } & AstNodeMeta)
  | ({ kind: "type"; name: string } & AstNodeMeta);

export interface BlockExpr extends AstNodeMeta {
  kind: "block";
  statements: Statement[];
  expr?: Expr;
}

export type Statement = LetDecl | DestructureLetDecl | ProofConstDecl;

export type StaticForSource =
  | { kind: "range"; start: Expr; end: Expr }
  | { kind: "shape"; shape: Expr };

export type Expr =
  | ({
    kind: "literal";
    value: string;
    literalKind: "number" | "bool" | "string" | "char" | "multiline" | "literalType";
    inferredType?: string;
  } & AstNodeMeta)
  | ({ kind: "var"; name: string } & AstNodeMeta)
  | ({ kind: "placeholder" } & AstNodeMeta)
  | ({ kind: "pipe_bind"; value: Expr; name: string; doc?: string; body: Expr } & AstNodeMeta)
  | ({ kind: "call"; callee: Expr; args: Expr[] } & AstNodeMeta)
  | ({ kind: "index"; target: Expr; index: Expr } & AstNodeMeta)
  | ({ kind: "binary"; op: string; left: Expr; right: Expr } & AstNodeMeta)
  | (
    & { kind: "match"; value: Expr; arms: ({ pattern: ParamPattern; value: Expr } & AstNodeMeta)[] }
    & AstNodeMeta
  )
  | (
    & {
      kind: "shape";
      syntax?: "record" | "collection";
      slots: (
        & {
          doc?: string;
          label?: string;
          position?: number;
          value: Expr;
          spread?: boolean;
          repeat?: TypeCountExpr;
        }
        & AstNodeMeta
      )[];
    }
    & AstNodeMeta
  )
  | ({
    kind: "static_for_slots";
    iterator: string;
    iteratorDoc?: string;
    valueIterator?: string;
    valueIteratorDoc?: string;
    source: StaticForSource;
    labeled: boolean;
    value: Expr;
  } & AstNodeMeta)
  | ({ kind: "field"; value: Expr; key: Expr } & AstNodeMeta)
  | ({
    kind: "product_constructor";
    constructor: string;
    slots: (
      & {
        doc?: string;
        label?: string;
        position?: number;
        value: Expr;
        spread?: boolean;
        repeat?: TypeCountExpr;
      }
      & AstNodeMeta
    )[];
  } & AstNodeMeta)
  | ({ kind: "range"; start: Expr; end: Expr } & AstNodeMeta)
  | BlockExpr;
