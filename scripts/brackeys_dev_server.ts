const root = new URL("../", import.meta.url);
const wasmPath = new URL("../examples/brackeys_platformer.wasm", import.meta.url);
const port = Number(Deno.args[0] ?? "8080");
const sockets = new Set<WebSocket>();

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ttf": "font/ttf",
};

function contentType(path: string): string {
  const index = path.lastIndexOf(".");
  return contentTypes[index >= 0 ? path.slice(index) : ""] ?? "application/octet-stream";
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

function safePath(pathname: string): URL | undefined {
  const decoded = decodeURIComponent(
    pathname === "/" ? "/examples/brackeys_platformer.html" : pathname,
  );
  if (decoded.includes("\0")) return undefined;
  const file = new URL(`.${decoded}`, root);
  if (!file.href.startsWith(root.href)) return undefined;
  return file;
}

async function serveFile(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const file = safePath(url.pathname);
  if (!file) return notFound();
  try {
    const info = await Deno.stat(file);
    if (!info.isFile) return notFound();
    const headers = new Headers({
      "cache-control": "no-store",
      "content-length": String(info.size),
      "content-type": contentType(file.pathname),
      "last-modified": info.mtime?.toUTCString() ?? new Date().toUTCString(),
    });
    if (request.method === "HEAD") return new Response(null, { headers });
    return new Response(await Deno.readFile(file), { headers });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return notFound();
    throw error;
  }
}

function serveSocket(request: Request): Response {
  const { response, socket } = Deno.upgradeWebSocket(request);
  sockets.add(socket);
  socket.onclose = () => sockets.delete(socket);
  socket.onerror = () => sockets.delete(socket);
  return response;
}

function broadcast(message: unknown) {
  const payload = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

async function watchWasm() {
  for await (const event of Deno.watchFs(wasmPath.pathname)) {
    if (event.kind === "modify" || event.kind === "create" || event.kind === "remove") {
      let stat: Deno.FileInfo | undefined;
      try {
        stat = await Deno.stat(wasmPath);
      } catch {
        stat = undefined;
      }
      broadcast({
        type: "wasm-changed",
        signature: [
          stat?.mtime?.toUTCString() ?? "",
          stat?.size ?? 0,
          Date.now(),
        ].join("|"),
      });
    }
  }
}

watchWasm();

console.log(`Brackeys dev server: http://127.0.0.1:${port}/examples/brackeys_platformer.html`);

Deno.serve({ hostname: "127.0.0.1", port }, (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/__fig_hmr") return serveSocket(request);
  return serveFile(request);
});
