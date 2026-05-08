export interface Span {
  start: number;
  end: number;
  line: number;
  column: number;
  sourceId?: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  span?: Span;
}

export class CompileError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join("\n"));
  }
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const where = diagnostic.span ? `${diagnostic.span.line}:${diagnostic.span.column}: ` : "";
  return `${where}${diagnostic.code}: ${diagnostic.message}`;
}

export function fail(code: string, message: string, span?: Span): never {
  throw new CompileError([{ code, message, span }]);
}
