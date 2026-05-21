interface ReleaseTarget {
  target: string;
  binary: string;
  archive: "tar.gz" | "zip";
}

const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  { target: "x86_64-unknown-linux-gnu", binary: "fig", archive: "tar.gz" },
  { target: "aarch64-unknown-linux-gnu", binary: "fig", archive: "tar.gz" },
  { target: "x86_64-pc-windows-msvc", binary: "fig.exe", archive: "zip" },
  { target: "x86_64-apple-darwin", binary: "fig", archive: "tar.gz" },
  { target: "aarch64-apple-darwin", binary: "fig", archive: "tar.gz" },
] as const;

const NATIVE_TARGET = `${Deno.build.arch}-${
  Deno.build.os === "windows"
    ? "pc-windows-msvc"
    : Deno.build.os === "darwin"
    ? "apple-darwin"
    : "unknown-linux-gnu"
}`;

export interface BuildReleaseBinariesOptions {
  tag: string;
  outDir: string;
  nativeOnly?: boolean;
}

export async function buildReleaseBinaries(options: BuildReleaseBinariesOptions): Promise<void> {
  await Deno.mkdir(options.outDir, { recursive: true });
  const targets = options.nativeOnly
    ? RELEASE_TARGETS.filter((item) => item.target === NATIVE_TARGET)
    : RELEASE_TARGETS;
  if (targets.length === 0) throw new Error(`unsupported native release target ${NATIVE_TARGET}`);

  const archives: string[] = [];
  for (const target of targets) {
    const packageName = `fig-${options.tag}-${target.target}`;
    const packageDir = `${options.outDir}/${packageName}`;
    await Deno.mkdir(packageDir, { recursive: true });
    await runChecked([
      Deno.execPath(),
      "compile",
      "--target",
      target.target,
      "--output",
      `${packageDir}/${target.binary}`,
      "--allow-read",
      "--allow-write",
      "--include",
      "prelude",
      "--include",
      "web",
      "--include",
      "engine",
      "src/cli.ts",
    ], "compile release binary");

    if (target.target === NATIVE_TARGET) {
      await runChecked(
        [`${packageDir}/${target.binary}`, "run", "examples/hello.fig"],
        "run hello",
      );
      await runChecked(
        [`${packageDir}/${target.binary}`, "check", "examples/prelude_std.fig"],
        "check prelude import",
      );
    }

    const archivePath = target.archive === "zip"
      ? `${options.outDir}/${packageName}.zip`
      : `${options.outDir}/${packageName}.tar.gz`;
    if (target.archive === "zip") {
      await runChecked(["zip", "-qr", `${packageName}.zip`, packageName], "archive zip", {
        cwd: options.outDir,
      });
    } else {
      await runChecked(
        ["tar", "-czf", archivePath, "-C", options.outDir, packageName],
        "archive tar",
      );
    }
    archives.push(archivePath);
    await Deno.remove(packageDir, { recursive: true });
  }

  await writeSha256Sums(options.outDir, archives);
}

async function writeSha256Sums(outDir: string, paths: string[]) {
  const rows: string[] = [];
  for (const path of paths.toSorted()) {
    const bytes = await Deno.readFile(path);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    rows.push(`${hex(new Uint8Array(hash))}  ${basename(path)}`);
  }
  await Deno.writeTextFile(`${outDir}/SHA256SUMS`, `${rows.join("\n")}\n`);
}

async function runChecked(
  args: string[],
  label: string,
  options: { cwd?: string } = {},
): Promise<void> {
  const [command, ...commandArgs] = args;
  const output = await new Deno.Command(command, {
    args: commandArgs,
    cwd: options.cwd
      ? new URL(`${options.cwd.replace(/\/$/, "")}/`, `file://${Deno.cwd()}/`)
      : undefined,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`${label} failed\n${stdout}${stderr}`);
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function stringArg(name: string): string | undefined {
  const eq = Deno.args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

if (import.meta.main) {
  await buildReleaseBinaries({
    tag: stringArg("--tag") ?? Deno.env.get("RELEASE_TAG") ?? "dev",
    outDir: stringArg("--out") ?? "dist",
    nativeOnly: Deno.args.includes("--native-only"),
  });
}
