import type { Express } from "express";
import { request as httpRequest, type Server } from "node:http";

// node:http rather than fetch: the test preload installs happy-dom's browser-style fetch.
export type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

export async function serve(app: Express): Promise<{ base: string; close: () => void }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

export function send(
  base: string,
  path: string,
  { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const setCookies = (r: Reply) => ([] as string[]).concat(r.headers["set-cookie"] ?? []);
