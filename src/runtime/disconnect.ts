import type * as http from "node:http";

/**
 * Cancels in-flight agent work when the caller goes away.
 *
 * This has to hang off the *response*, not the request: `req` emits "close" as
 * soon as its body has been received, which always happens before a handler
 * runs, so a listener added there can never observe a disconnect. `res` tracks
 * the socket, but it also closes on a normal finish — hence the guard.
 */
export function abortOnClientDisconnect(
  res: http.ServerResponse,
  controller: AbortController,
): void {
  if (res.writableEnded || res.destroyed) {
    controller.abort();
    return;
  }
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });
}
