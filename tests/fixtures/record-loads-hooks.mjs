// Loader hooks for ./record-loads.mjs: log every loaded module URL.
import { appendFileSync } from "node:fs";

let out;

export function initialize(data) {
  out = data?.out;
}

export async function load(url, context, nextLoad) {
  if (out) appendFileSync(out, `${url}\n`);
  return nextLoad(url, context);
}
