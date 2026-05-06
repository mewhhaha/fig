import { lex } from "../tokenizer.ts";

Deno.test("tokenizer smoke", () => {
  const tokens = lex("example");
  if (tokens.at(-1)?.kind !== "eof") {
    throw new Error("Expected eof token");
  }
});
