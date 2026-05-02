import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout } from "../src/lib/http.js";
import { REQUEST_TIMEOUT_MS } from "../src/lib/types.js";

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("defaults provider requests to a 5 second timeout", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(5000);
  });

  it("uses an explicit timeout when provided", async () => {
    vi.useFakeTimers();

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, options?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = options?.signal;
          signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      }),
    );

    const request = fetchWithTimeout("https://example.test/quota", {}, 12000);
    const assertion = expect(request).rejects.toThrow("Request timeout after 12s");

    await vi.advanceTimersByTimeAsync(12000);
    await assertion;
  });

  it("reports the default timeout in seconds", async () => {
    vi.useFakeTimers();

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, options?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = options?.signal;
          signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      }),
    );

    const request = fetchWithTimeout("https://example.test/quota", {});
    const assertion = expect(request).rejects.toThrow("Request timeout after 5s");

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
  });
});
