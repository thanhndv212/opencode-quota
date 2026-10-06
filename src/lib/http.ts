/**
 * HTTP utilities for provider API calls.
 */

import { REQUEST_TIMEOUT_MS } from "./types.js";

/**
 * Fetch a complete finite response within one timeout using AbortController.
 *
 * @param url - The URL to fetch
 * @param options - Fetch options (headers, method, body, etc.)
 * @param timeoutMs - Timeout in milliseconds (defaults to REQUEST_TIMEOUT_MS)
 * @returns The fetch Response
 * @throws Error with message "Request timeout after Xs" if request times out
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutMessage = `Request timeout after ${Math.round(timeoutMs / 1000)}s`;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const transaction = (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      // Provider payloads and pricing snapshots are finite documents. Buffer them
      // before releasing the deadline, preserving the existing Response API.
      const body = await response.arrayBuffer();
      const buffered = new Response(response.body === null ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      for (const property of ["url", "redirected", "type"] as const) {
        Object.defineProperty(buffered, property, { value: response[property] });
      }
      return buffered;
    })();
    return await Promise.race([transaction, timeout]);
  } catch (error) {
    if (timedOut) throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
