import type { Position, Range } from "./protocol.ts";

export class PositionMapper {
  readonly lineStarts: number[];

  constructor(readonly source: string) {
    this.lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\n") this.lineStarts.push(i + 1);
    }
  }

  offsetAt(position: Position): number {
    const line = Math.max(0, Math.min(position.line, this.lineStarts.length - 1));
    const lineStart = this.lineStarts[line];
    const lineEnd = this.lineStarts[line + 1] ?? this.source.length;
    let offset = lineStart;
    let utf16 = 0;
    while (offset < lineEnd && utf16 < position.character) {
      const codePoint = this.source.codePointAt(offset) ?? 0;
      const width = codePoint > 0xffff ? 2 : 1;
      if (utf16 + width > position.character) break;
      utf16 += width;
      offset += codePoint > 0xffff ? 2 : 1;
    }
    return offset;
  }

  positionAt(offset: number): Position {
    const safeOffset = Math.max(0, Math.min(offset, this.source.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.lineStarts[mid] <= safeOffset) low = mid + 1;
      else high = mid - 1;
    }
    const line = Math.max(0, low - 1);
    const lineStart = this.lineStarts[line];
    let character = 0;
    for (let i = lineStart; i < safeOffset;) {
      const codePoint = this.source.codePointAt(i) ?? 0;
      character += codePoint > 0xffff ? 2 : 1;
      i += codePoint > 0xffff ? 2 : 1;
    }
    return { line, character };
  }

  range(start: number, end: number): Range {
    return { start: this.positionAt(start), end: this.positionAt(Math.max(start, end)) };
  }
}
