import { describe, expect, test } from "bun:test";

// app.ts reads the environment when it is imported, so each case runs it in a fresh process.
const appUrl = new URL("./app.ts", import.meta.url).href;
const script = `
  const { default: app } = await import(${JSON.stringify(appUrl)});
  const server = app.listen(0);
  const res = await fetch("http://127.0.0.1:" + server.address().port + "/auth/dev/login", { redirect: "manual" });
  console.log("STATUS " + res.status + " COOKIE " + res.headers.has("set-cookie"));
  server.close();
`;

async function run(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "--no-env-file", "-e", script], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe("real app wiring", () => {
  test("the dev login route is absent by default", async () => {
    const r = await run({ SESSION_SECRET: "x" });
    expect(r.stdout).toContain("STATUS 404 COOKIE false");
  });

  test("the app refuses to start with DEV_LOGIN=true in production", async () => {
    const r = await run({ SESSION_SECRET: "x", DEV_LOGIN: "true", NODE_ENV: "production" });
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain("STATUS");
    expect(r.stderr).toContain("Refusing to start");
  });

  test("with DEV_LOGIN=true outside production it signs in", async () => {
    const r = await run({ SESSION_SECRET: "x", DEV_LOGIN: "true", NODE_ENV: "development" });
    expect(r.stdout).toContain("STATUS 302 COOKIE true");
  });
});
