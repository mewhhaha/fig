set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    just --list

codegen:
    deno task codegen

check:
    deno task check

test:
    deno task test

helix:
    deno task helix

install: codegen
    deno run --allow-read --allow-write --allow-run scripts/build_helix_parser.ts
    deno install --global --force --config deno.json --name shovel --allow-read --allow-write src/cli.ts
    deno run --allow-read --allow-write --allow-env scripts/install_helix.ts
    hx --health shovel
