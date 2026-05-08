import {
  AnalysisCache,
  codeActions,
  completionsAt,
  definitionAt,
  documentSymbols,
  hoverAt,
  prepareRenameAt,
  referencesAt,
  renameAt,
  SEMANTIC_TOKEN_TYPES,
  semanticTokens,
  signatureHelpAt,
  workspaceSymbols,
} from "./analysis.ts";
import { formatSource } from "../format.ts";
import { CompileError } from "../diagnostics.ts";

type RpcId = string | number | null;

interface RpcMessage {
  jsonrpc: "2.0";
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class FigLanguageServer {
  readonly analysis = new AnalysisCache();
  private publish: (params: unknown) => void;

  constructor(publishDiagnostics: (params: unknown) => void = () => {}) {
    this.publish = publishDiagnostics;
  }

  async handle(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          capabilities: {
            textDocumentSync: 1,
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: { prepareProvider: true },
            completionProvider: { triggerCharacters: [".", "@", '"'], resolveProvider: false },
            signatureHelpProvider: { triggerCharacters: ["(", ","] },
            semanticTokensProvider: {
              legend: { tokenTypes: SEMANTIC_TOKEN_TYPES, tokenModifiers: [] },
              full: true,
            },
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            codeActionProvider: true,
            documentFormattingProvider: true,
          },
          serverInfo: { name: "fig-lsp", version: "0.1.0" },
        };
      case "initialized":
        return null;
      case "shutdown":
        return null;
      case "textDocument/didOpen": {
        const doc = params.textDocument;
        this.analysis.open(doc.uri, doc.version ?? 0, doc.text);
        await this.publishFor(doc.uri);
        return null;
      }
      case "textDocument/didChange": {
        const uri = params.textDocument.uri;
        const version = params.textDocument.version ?? 0;
        const text = params.contentChanges?.at(-1)?.text ?? "";
        this.analysis.change(uri, version, text);
        await this.publishAffected(uri);
        return null;
      }
      case "textDocument/didClose":
        this.analysis.close(params.textDocument.uri);
        this.publish({ uri: params.textDocument.uri, diagnostics: [] });
        return null;
      case "textDocument/hover": {
        const result = this.analysis.get(params.textDocument.uri) ??
          await this.analysis.reanalyze(params.textDocument.uri);
        return result ? hoverAt(result, params.position) ?? null : null;
      }
      case "textDocument/definition": {
        const result = this.analysis.get(params.textDocument.uri) ??
          await this.analysis.reanalyze(params.textDocument.uri);
        return result ? definitionAt(result, params.position) : [];
      }
      case "textDocument/completion": {
        const result = this.analysis.get(params.textDocument.uri) ??
          await this.analysis.reanalyze(params.textDocument.uri);
        return result ? { isIncomplete: false, items: completionsAt(result, params.position) } : [];
      }
      case "textDocument/documentSymbol": {
        const result = this.analysis.get(params.textDocument.uri) ??
          await this.analysis.reanalyze(params.textDocument.uri);
        return result ? documentSymbols(result) : [];
      }
      case "textDocument/references": {
        const result = this.analysis.get(params.textDocument.uri) ??
          await this.analysis.reanalyze(params.textDocument.uri);
        return result ? referencesAt(result, params.position) : [];
      }
      case "textDocument/prepareRename": {
        const result = this.analysis.get(params.textDocument.uri) ??
          await this.analysis.reanalyze(params.textDocument.uri);
        return result ? prepareRenameAt(result, params.position) : null;
      }
      case "textDocument/rename": {
        const result = this.analysis.get(params.textDocument.uri) ??
          await this.analysis.reanalyze(params.textDocument.uri);
        return result ? renameAt(result, params.position, params.newName) : null;
      }
      case "textDocument/signatureHelp": {
        const result = this.analysis.get(params.textDocument.uri) ??
          await this.analysis.reanalyze(params.textDocument.uri);
        return result ? signatureHelpAt(result, params.position) : null;
      }
      case "textDocument/semanticTokens/full": {
        const result = this.analysis.get(params.textDocument.uri) ??
          await this.analysis.reanalyze(params.textDocument.uri);
        return result ? semanticTokens(result) : { data: [] };
      }
      case "workspace/symbol": {
        return workspaceSymbols(this.analysis.allResults(), params.query ?? "");
      }
      case "textDocument/codeAction": {
        const result = this.analysis.get(params.textDocument.uri) ??
          await this.analysis.reanalyze(params.textDocument.uri);
        return result ? codeActions(result, params.range) : [];
      }
      case "textDocument/formatting": {
        const result = this.analysis.get(params.textDocument.uri) ??
          await this.analysis.reanalyze(params.textDocument.uri);
        if (!result) return [];
        let formatted: string;
        try {
          formatted = formatSource(result.document.text);
        } catch (error) {
          if (error instanceof CompileError) return [];
          throw error;
        }
        if (formatted === result.document.text) return [];
        return [{
          range: result.mapper.range(0, result.document.text.length),
          newText: formatted,
        }];
      }
      default:
        return null;
    }
  }

  private async publishFor(uri: string) {
    const result = await this.analysis.reanalyze(uri);
    this.publishDiagnostics(result, uri);
  }

  private async publishAffected(uri: string) {
    const results = await this.analysis.reanalyzeAffected(uri);
    for (const result of results) this.publishDiagnostics(result, result.document.uri);
  }

  private publishDiagnostics(result: Awaited<ReturnType<AnalysisCache["reanalyze"]>>, fallbackUri: string) {
    if (!result) {
      this.publish({ uri: fallbackUri, diagnostics: [] });
      return;
    }
    const byUri = result.diagnosticsByUri ?? { [result.document.uri]: result.diagnostics };
    for (const [uri, diagnostics] of Object.entries(byUri)) this.publish({ uri, diagnostics });
  }
}

export async function runStdioServer() {
  const writer = Deno.stdout.writable.getWriter();
  const server = new FigLanguageServer((params) => {
    void writeMessage(writer, {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params,
    });
  });
  const reader = Deno.stdin.readable.getReader();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer = concatBytes(buffer, value);
    while (true) {
      const parsed = takeMessage(buffer);
      if (!parsed) break;
      buffer = parsed.rest;
      await handleRpcMessage(server, writer, parsed.message);
    }
  }
}

async function handleRpcMessage(
  server: FigLanguageServer,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  message: RpcMessage,
) {
  if (!message.method) return;
  try {
    const result = await server.handle(message.method, message.params);
    if (message.id !== undefined) {
      await writeMessage(writer, { jsonrpc: "2.0", id: message.id, result });
    }
  } catch (error) {
    if (message.id !== undefined) {
      await writeMessage(writer, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

function takeMessage(
  buffer: Uint8Array<ArrayBufferLike>,
): { message: RpcMessage; rest: Uint8Array<ArrayBufferLike> } | undefined {
  const headerEnd = indexOfHeaderEnd(buffer);
  if (headerEnd < 0) return undefined;
  const header = new TextDecoder().decode(buffer.slice(0, headerEnd));
  const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
  if (!lengthMatch) throw new Error("missing Content-Length header");
  const length = Number(lengthMatch[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.byteLength < bodyEnd) return undefined;
  const body = new TextDecoder().decode(buffer.slice(bodyStart, bodyEnd));
  return { message: JSON.parse(body), rest: buffer.slice(bodyEnd) };
}

async function writeMessage(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  message: RpcMessage,
) {
  const body = JSON.stringify(message);
  const payload = `Content-Length: ${new TextEncoder().encode(body).length}\r\n\r\n${body}`;
  await writer.write(new TextEncoder().encode(payload));
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function indexOfHeaderEnd(buffer: Uint8Array<ArrayBufferLike>): number {
  for (let i = 0; i <= buffer.byteLength - 4; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

if (import.meta.main) await runStdioServer();
