import { createHash, randomUUID } from "node:crypto";
import type * as http from "node:http";

import type {
  AcpToolSession,
  ToolTurnEvent,
  ToolTurnResult,
} from "./tool-turn.js";
import { extractBearerToken } from "../gateway/http.js";
import type { ClientToolOutput } from "../protocols/tools.js";

export type ToolApi = "chat" | "responses" | "anthropic";
const DEFAULT_MAX_GLOBAL_TOOL_SESSIONS = 16;
const DEFAULT_MAX_OWNER_TOOL_SESSIONS = 4;

class Mutex {
  #tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export type ToolSessionRecord = {
  id: string;
  api: ToolApi;
  ownerKey: string;
  model: string;
  configDir?: string;
  session: AcpToolSession;
  mutex: Mutex;
  responseIds: Set<string>;
  createdAt: number;
  lastUsed: number;
};

export type ToolSessionReservation = {
  id: string;
  ownerKey: string;
  createdAt: number;
};

export class ToolSessionError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code = "tool_session_error",
  ) {
    super(message);
  }
}

export function toolSessionOwnerKey(
  req: http.IncomingMessage,
  remoteAddress: string,
): string {
  const bearer = extractBearerToken(req);
  return createHash("sha256")
    .update(bearer ? `bearer:${bearer}` : `remote:${remoteAddress}`)
    .digest("hex");
}

export class ToolSessionRegistry {
  readonly #maxGlobal: number;
  readonly #maxPerOwner: number;
  readonly #records = new Set<ToolSessionRecord>();
  readonly #reservations = new Set<ToolSessionReservation>();
  readonly #byResponseId = new Map<string, ToolSessionRecord>();
  #closePromise?: Promise<void>;

  constructor(opts: { maxGlobal?: number; maxPerOwner?: number } = {}) {
    this.#maxGlobal = Math.max(1, opts.maxGlobal ?? DEFAULT_MAX_GLOBAL_TOOL_SESSIONS);
    this.#maxPerOwner = Math.max(1, opts.maxPerOwner ?? DEFAULT_MAX_OWNER_TOOL_SESSIONS);
  }

  reserve(ownerKey: string): ToolSessionReservation {
    this.#sweep();
    const ownerRecords = [...this.#records].filter(
      (record) => record.ownerKey === ownerKey,
    ).length;
    const ownerReservations = [...this.#reservations].filter(
      (reservation) => reservation.ownerKey === ownerKey,
    ).length;
    if (
      this.#records.size + this.#reservations.size >= this.#maxGlobal ||
      ownerRecords + ownerReservations >= this.#maxPerOwner
    ) {
      throw new ToolSessionError(
        "Too many parked tool sessions; finish or cancel an existing turn",
        429,
        "tool_session_limit",
      );
    }
    const reservation: ToolSessionReservation = {
      id: `toolres_${randomUUID().replace(/-/g, "")}`,
      ownerKey,
      createdAt: Date.now(),
    };
    this.#reservations.add(reservation);
    return reservation;
  }

  releaseReservation(reservation: ToolSessionReservation): void {
    this.#reservations.delete(reservation);
  }

  createRecord(opts: {
    api: ToolApi;
    ownerKey: string;
    model: string;
    configDir?: string;
    session: AcpToolSession;
    reservation?: ToolSessionReservation;
  }): ToolSessionRecord {
    this.#sweep();
    if (opts.reservation) {
      const valid =
        this.#reservations.has(opts.reservation) &&
        opts.reservation.ownerKey === opts.ownerKey;
      if (!valid) {
        void opts.session.close();
        throw new ToolSessionError(
          "Tool session reservation is missing or invalid",
          409,
          "tool_session_reservation_invalid",
        );
      }
      this.#reservations.delete(opts.reservation);
    } else {
      const ownerCount = [...this.#records].filter(
        (record) => record.ownerKey === opts.ownerKey,
      ).length;
      if (
        this.#records.size + this.#reservations.size >= this.#maxGlobal ||
        ownerCount >= this.#maxPerOwner
      ) {
        void opts.session.close();
        throw new ToolSessionError(
          "Too many parked tool sessions; finish or cancel an existing turn",
          429,
          "tool_session_limit",
        );
      }
    }
    const record: ToolSessionRecord = {
      id: `toolsess_${randomUUID().replace(/-/g, "")}`,
      api: opts.api,
      ownerKey: opts.ownerKey,
      model: opts.model,
      configDir: opts.configDir,
      session: opts.session,
      mutex: new Mutex(),
      responseIds: new Set(),
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };
    this.#records.add(record);
    return record;
  }

  aliasResponse(record: ToolSessionRecord, responseId: string): void {
    record.responseIds.add(responseId);
    this.#byResponseId.set(responseId, record);
  }

  findByCallIds(
    api: ToolApi,
    ownerKey: string,
    callIds: readonly string[],
  ): ToolSessionRecord | undefined {
    this.#sweep();
    if (callIds.length === 0) return undefined;
    return [...this.#records].find(
      (record) =>
        record.api === api &&
        record.ownerKey === ownerKey &&
        !record.session.closed &&
        callIds.every((callId) => record.session.hasCall(callId)),
    );
  }

  findByResponseId(
    ownerKey: string,
    responseId: string,
  ): ToolSessionRecord | undefined {
    this.#sweep();
    const record = this.#byResponseId.get(responseId);
    return record &&
      record.ownerKey === ownerKey &&
      !record.session.closed
      ? record
      : undefined;
  }

  async collect(
    record: ToolSessionRecord,
    listener?: (event: ToolTurnEvent) => void,
  ): Promise<ToolTurnResult> {
    return record.mutex.run(async () => {
      record.lastUsed = Date.now();
      try {
        return await record.session.collect(listener);
      } finally {
        if (record.session.closed || record.session.terminal) {
          this.remove(record);
        }
      }
    });
  }

  async resume(
    record: ToolSessionRecord,
    outputs: readonly ClientToolOutput[],
    listener?: (event: ToolTurnEvent) => void,
  ): Promise<ToolTurnResult> {
    return record.mutex.run(async () => {
      if (
        record.session.closed ||
        outputs.some((output) => !record.session.hasCall(output.callId))
      ) {
        throw new ToolSessionError(
          "Tool call is already resolved, unknown, or expired",
          409,
          "tool_session_expired",
        );
      }
      record.lastUsed = Date.now();
      try {
        return await record.session.resume(outputs, listener);
      } finally {
        if (record.session.closed || record.session.terminal) {
          this.remove(record);
        }
      }
    });
  }

  remove(record: ToolSessionRecord): void {
    this.#records.delete(record);
    for (const responseId of record.responseIds) {
      if (this.#byResponseId.get(responseId) === record) {
        this.#byResponseId.delete(responseId);
      }
    }
  }

  async closeAll(): Promise<void> {
    if (!this.#closePromise) {
      const records = [...this.#records];
      this.#records.clear();
      this.#reservations.clear();
      this.#byResponseId.clear();
      this.#closePromise = Promise.all(
        records.map((record) => record.session.close().catch(() => undefined)),
      ).then(() => undefined);
    }
    await this.#closePromise;
  }

  get size(): number {
    this.#sweep();
    return this.#records.size;
  }

  get reservedSize(): number {
    return this.#reservations.size;
  }

  #sweep(): void {
    for (const record of this.#records) {
      if (record.session.closed) this.remove(record);
    }
  }
}
