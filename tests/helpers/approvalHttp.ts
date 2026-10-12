import { request } from "node:http";

/**
 * Raw HTTP against the loopback approval server. node:http instead of fetch:
 * the tests must set `Host` and `Origin` by hand (fetch forbids both), which is
 * exactly what an attacker page or a DNS-rebinding request would vary.
 */
export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): Record<string, unknown>;
}

export function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  const u = new URL(url);
  return new Promise((resolveReq, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? "GET",
        headers: { Host: u.host, ...(opts.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolveReq({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body) as Record<string, unknown>,
          });
        });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Pull the per-approval CSRF token out of the rendered page. */
export function csrfFromPage(html: string): string {
  const m = /var csrf=("[^"]+");/.exec(html);
  if (!m) throw new Error("no CSRF token in the page");
  return JSON.parse(m[1]!) as string;
}

/** Play the human: load the page, then POST the password with the right Origin + CSRF. */
export async function approveAsHuman(
  url: string,
  password: string,
  extra: { webdriver?: boolean; origin?: string } = {},
): Promise<RawResponse> {
  const page = await rawRequest(url);
  const csrf = csrfFromPage(page.body);
  const origin = extra.origin ?? new URL(url).origin;
  return rawRequest(`${url}/approve`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ csrf, password, webdriver: extra.webdriver ?? false }),
  });
}

export async function declineAsHuman(url: string): Promise<RawResponse> {
  const page = await rawRequest(url);
  const csrf = csrfFromPage(page.body);
  return rawRequest(`${url}/decline`, {
    method: "POST",
    headers: { Origin: new URL(url).origin, "Content-Type": "application/json" },
    body: JSON.stringify({ csrf }),
  });
}
