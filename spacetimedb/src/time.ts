import type { Timestamp } from 'spacetimedb';

/** A Timestamp at `micros`, using the prototype of a timestamp the host already built. */
export function timestampAt(sample: Timestamp, micros: bigint): Timestamp {
  const next = Object.create(Object.getPrototypeOf(sample)) as Timestamp;
  (next as Timestamp & { __timestamp_micros_since_unix_epoch__: bigint }).__timestamp_micros_since_unix_epoch__ =
    micros;
  return next;
}
