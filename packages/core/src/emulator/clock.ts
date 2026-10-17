/**
 * The emulator's time source is the shared core {@link Clock}: wall-clock milliseconds plus the
 * timers that drive deferred device behaviour (ACKs, remote responses, contact streaming).
 */
import type { Clock } from '../util/clock.js';

export type { TimerHandle } from '../util/clock.js';
export { ManualClock, systemClock } from '../util/clock.js';

/** @deprecated alias kept for existing imports; use {@link Clock}. */
export type EmulatorClock = Clock;
