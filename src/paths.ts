import { homedir } from "node:os";
import { join } from "node:path";

export function tallyHome(): string {
  return process.env.TALLY_HOME || join(homedir(), ".tally");
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}
