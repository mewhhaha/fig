export function normalizeTypeSourceForParsing(source: string): string {
  let result = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  const trimResultWhitespace = () => {
    result = result.replace(/\s+$/, "");
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      result += char;
      continue;
    }
    if (source.startsWith("::", index)) {
      trimResultWhitespace();
      result += "::";
      index += 1;
      while (/\s/.test(source[index + 1] ?? "")) index += 1;
      continue;
    }
    if (char === ".") {
      trimResultWhitespace();
      result += ".";
      while (/\s/.test(source[index + 1] ?? "")) index += 1;
      continue;
    }
    result += char;
  }
  return result;
}
