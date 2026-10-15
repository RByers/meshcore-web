/** A promise together with its resolve/reject functions. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T | PromiseLike<T>) => void;
  #reject!: (reason?: unknown) => void;
  #settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  /** True once `resolve` or `reject` has been called. */
  get settled(): boolean {
    return this.#settled;
  }

  resolve(value: T | PromiseLike<T>): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(value);
  }

  reject(reason?: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(reason);
  }
}
