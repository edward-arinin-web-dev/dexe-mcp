/**
 * Read an HTTP response body with a byte ceiling.
 *
 * `await res.arrayBuffer()` / `res.json()` / `res.text()` buffer whatever the
 * server sends. For an upstream the caller picks — an IPFS CID is any file
 * anyone ever pinned — that is an unbounded allocation per call: three
 * parallel 600 MB fetches took a test server to 3.2 GB RSS. This reads the
 * stream chunk by chunk and stops (cancelling the body, which closes the
 * connection) as soon as the ceiling is passed, so at most `maxBytes` plus one
 * chunk is ever held.
 */

/** The body was larger than the ceiling. Nothing past the ceiling was read. */
export class BodyTooLargeError extends Error {
  constructor(
    /** The ceiling that was hit. */
    readonly limit: number,
    /** `Content-Length`, when the server declared one. */
    readonly declared?: number,
  ) {
    super(
      declared !== undefined
        ? `response body is ${declared} bytes, over the ${limit}-byte limit`
        : `response body exceeded the ${limit}-byte limit`,
    );
    this.name = "BodyTooLargeError";
  }
}

/** Drop an unread body so the connection is released. Never throws. */
export async function discardBody(res: Response): Promise<void> {
  const body = (res as { body?: unknown }).body as { cancel?: () => Promise<void> } | null | undefined;
  if (body && typeof body.cancel === "function") await body.cancel().catch(() => undefined);
}

/** Read `res`'s body, refusing more than `maxBytes`. */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const header = typeof res.headers?.get === "function" ? res.headers.get("content-length") : null;
  const declared = header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : undefined;
  if (declared !== undefined && declared > maxBytes) {
    await discardBody(res);
    throw new BodyTooLargeError(maxBytes, declared);
  }
  const body = (res as { body?: unknown }).body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    // No stream to read incrementally — a test double, typically. Take what it
    // offers and enforce the ceiling afterwards.
    let bytes: Uint8Array;
    if (typeof res.arrayBuffer === "function") bytes = new Uint8Array(await res.arrayBuffer());
    else if (typeof res.text === "function") bytes = new TextEncoder().encode(await res.text());
    else if (typeof res.json === "function") bytes = new TextEncoder().encode(JSON.stringify(await res.json()));
    else bytes = new Uint8Array(0);
    if (bytes.byteLength > maxBytes) throw new BodyTooLargeError(maxBytes, declared);
    return bytes;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes, declared);
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * The first `n` bytes of `res`'s body, then the rest is cancelled. For a
 * sniff that only needs a header, from a server that may ignore `Range`.
 */
export async function readBodyHead(res: Response, n: number): Promise<Uint8Array> {
  const body = (res as { body?: unknown }).body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    const all = await readBodyCapped(res, Number.MAX_SAFE_INTEGER);
    return all.subarray(0, n);
  }
  const reader = body.getReader();
  const out = new Uint8Array(n);
  let at = 0;
  while (at < n) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, n - at);
    out.set(value.subarray(0, take), at);
    at += take;
  }
  await reader.cancel().catch(() => undefined);
  return out.subarray(0, at);
}

/** `readBodyCapped` + UTF-8 decode. */
export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBodyCapped(res, maxBytes));
}

/** `readBodyCapped` + `JSON.parse`. A parse failure throws a SyntaxError, like `res.json()`. */
export async function readJsonCapped<T>(res: Response, maxBytes: number): Promise<T> {
  const body = (res as { body?: unknown }).body as { getReader?: unknown } | null | undefined;
  if ((!body || typeof body.getReader !== "function") && typeof res.json === "function") {
    // No stream (a test double): it can only hand over the parsed value.
    const value = (await res.json()) as T;
    const size = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    if (size > maxBytes) throw new BodyTooLargeError(maxBytes);
    return value;
  }
  return JSON.parse(await readTextCapped(res, maxBytes)) as T;
}

/**
 * Ceiling for JSON from the operator-configured upstreams (subgraph gateway,
 * DeXe backend). Those are trusted to be sane, and every real page is well
 * under 1 MB; this only stops a misbehaving or compromised upstream, or a
 * `dexe_graph_query` document that asks for far more than any answer can use,
 * from exhausting memory.
 */
export const UPSTREAM_JSON_MAX_BYTES = 16 * 1024 * 1024;

/** `n` bytes as a short human string: 512 B, 2 KB, 2 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round((n / 1024) * 10) / 10} KB`;
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}
