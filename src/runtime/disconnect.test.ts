import { describe, expect, it } from "vitest";

import { abortOnClientDisconnect } from "./disconnect.js";

describe("abortOnClientDisconnect", () => {
  it("aborts when the response closes without writableEnded", () => {
    const res = createFakeResponse();
    const controller = new AbortController();
    abortOnClientDisconnect(res as never, controller);
    expect(controller.signal.aborted).toBe(false);
    res.emit("close");
    expect(controller.signal.aborted).toBe(true);
  });

  it("does not abort on a normal finished response close", () => {
    const res = createFakeResponse();
    const controller = new AbortController();
    abortOnClientDisconnect(res as never, controller);
    res.writableEnded = true;
    res.emit("close");
    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts immediately when the response is already destroyed", () => {
    const res = createFakeResponse({ destroyed: true });
    const controller = new AbortController();
    abortOnClientDisconnect(res as never, controller);
    expect(controller.signal.aborted).toBe(true);
  });
});

function createFakeResponse(opts: { destroyed?: boolean } = {}) {
  const listeners = new Map<string, Array<() => void>>();
  const res = {
    writableEnded: false,
    destroyed: !!opts.destroyed,
    once(event: string, cb: () => void) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return res;
    },
    emit(event: string) {
      for (const cb of listeners.get(event) ?? []) cb();
    },
  };
  return res;
}
