import { randomBytes } from "crypto";

export function randomId(): string {
  return randomBytes(4).toString("hex");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
