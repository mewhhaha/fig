import { createDenoCliIo, runCli } from "./cli_app.ts";

if (import.meta.main) {
  Deno.exit(await runCli(Deno.args, createDenoCliIo()));
}
