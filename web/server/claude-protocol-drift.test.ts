import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

function extractCaseMethods(
  source: string,
  start: string,
  end: string,
): Set<string> {
  const startIdx = source.indexOf(start);
  if (startIdx < 0) return new Set();
  const afterStart = source.slice(startIdx + start.length);
  const endIdx = afterStart.indexOf(end);
  const block = endIdx >= 0 ? afterStart.slice(0, endIdx) : afterStart;
  return new Set([...block.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
}

function extractTypeLiterals(tsSource: string): Set<string> {
  return new Set([...tsSource.matchAll(/type:\s*'([^']+)'/g)].map((m) => m[1]));
}

describe("Claude ws-bridge method drift vs upstream Agent SDK snapshot", () => {
  it("keeps handled CLI message types aligned with upstream (or explicit local allowlist)", () => {
    const bridge = readFile("server/ws-bridge.ts");
    const sdk = readFile("server/protocol/claude-upstream/sdk.d.ts.txt");

    const handledFromCLI = extractCaseMethods(
      bridge,
      "private routeCLIMessage(",
      "private handleSystemMessage(",
    );
    expect(handledFromCLI.size).toBeGreaterThan(0);

    const upstreamMessageTypes = extractTypeLiterals(sdk);

    // Messages we intentionally support in raw CLI transport but are not part of SDKMessage union.
    const localRawTransportTypes = new Set(["control_request", "keep_alive"]);

    for (const method of handledFromCLI) {
      expect(
        upstreamMessageTypes.has(method) || localRawTransportTypes.has(method),
        `Unhandled by upstream snapshot (CLI message type): ${method}`,
      ).toBe(true);
    }
  });

  it("keeps system subtypes handled by ws-bridge aligned with upstream", () => {
    const bridge = readFile("server/ws-bridge.ts");
    const sdk = readFile("server/protocol/claude-upstream/sdk.d.ts.txt");

    const upstreamInit =
      sdk.includes("export declare type SDKSystemMessage = {") &&
      sdk.includes("subtype: 'init';");
    const upstreamStatus =
      sdk.includes("export declare type SDKStatusMessage = {") &&
      sdk.includes("subtype: 'status';");

    expect(upstreamInit).toBe(true);
    expect(upstreamStatus).toBe(true);

    expect(bridge).toContain('if (msg.subtype === "init")');
    expect(bridge).toContain('} else if (msg.subtype === "status")');
  });
});
