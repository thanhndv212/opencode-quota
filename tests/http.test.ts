import { createServer } from "node:http";
import { once } from "node:events";
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

  it("enforces the deadline even when fetch ignores its abort signal", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const assertion = expect(
      fetchWithTimeout("https://example.test/quota", {}, 1000),
    ).rejects.toThrow("Request timeout after 1s");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
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

describe("real HTTP response deadlines", () => {
  async function fixture(
    test: (url: string) => Promise<void>,
    mode: "stall" | "json" | "empty" | "slow" | "malformed" = "stall",
  ) {
    const server = createServer((_request, response) => {
      response.writeHead(mode === "empty" ? 204 : 200, {
        "Content-Type": "application/json",
        "X-Quota-Fixture": "yes",
      });
      if (mode === "empty") response.end();
      else if (mode === "malformed") response.end("{invalid-json");
      else if (mode === "slow") {
        response.flushHeaders();
        const chunks = ['{"remaining":', "42", "}"];
        const timer = setInterval(() => {
          response.write(chunks.shift());
          if (!chunks.length) {
            clearInterval(timer);
            response.end();
          }
        }, 60);
        response.on("close", () => clearInterval(timer));
      } else if (mode === "json") response.end('{"remaining":42}');
      else {
        response.flushHeaders();
        response.write('{"remaining":');
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP fixture address");
    try {
      await test(`http://127.0.0.1:${address.port}/quota`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("times out after headers when the response body stalls", async () => {
    await fixture(async (url) => {
      await expect((async () => (await fetchWithTimeout(url, {}, 100)).json())()).rejects.toThrow(
        "Request timeout after 0s",
      );
    });
  }, 1500);

  it("uses one deadline across slowly arriving chunks", async () => {
    await fixture(async (url) => {
      await expect(fetchWithTimeout(url, {}, 100)).rejects.toThrow("Request timeout after 0s");
    }, "slow");
  });

  it("leaves malformed JSON visible to the consumer", async () => {
    await fixture(async (url) => {
      const response = await fetchWithTimeout(url, {}, 1000);
      await expect(response.json()).rejects.toBeInstanceOf(SyntaxError);
    }, "malformed");
  });

  it("keeps status, headers, URL, and ordinary body readers", async () => {
    await fixture(async (url) => {
      const response = await fetchWithTimeout(url, {}, 1000);
      expect(response.status).toBe(200);
      expect(response.url).toBe(url);
      expect(response.headers.get("x-quota-fixture")).toBe("yes");
      expect(await response.clone().text()).toBe('{"remaining":42}');
      expect(await response.json()).toEqual({ remaining: 42 });
    }, "json");
  });

  it("preserves caller cancellation without misreporting a timeout", async () => {
    await fixture(async (url) => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        fetchWithTimeout(url, { signal: controller.signal }, 1000),
      ).rejects.toMatchObject({ name: "AbortError" });
    });
  });

  it("preserves responses that cannot have a body", async () => {
    await fixture(async (url) => {
      const response = await fetchWithTimeout(url, {}, 1000);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    }, "empty");
  });
});
