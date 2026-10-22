/** Same-site absolute paths only ("/search"), never "//host", "/\host" or full URLs. */
export function safeNextPath(value: unknown, fallback = "/search"): string {
  return typeof value === "string" && /^\/(?![/\\])[\x21-\x7e]*$/.test(value) ? value : fallback;
}
