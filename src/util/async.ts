export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;
  settled = false;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = (v) => {
        this.settled = true;
        resolve(v);
      };
      this.reject = (r) => {
        this.settled = true;
        reject(r);
      };
    });
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Wait until `predicate` becomes true, re-checking whenever `subscribe`'s
 * callback fires. Resolves with the value the predicate returned.
 */
export function waitFor<T>(
  subscribe: (check: () => void) => () => void,
  predicate: () => T | undefined | null | false,
  timeoutMs: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const initial = predicate();
    if (initial) {
      resolve(initial);
      return;
    }
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`));
    }, timeoutMs);
    unsubscribe = subscribe(() => {
      const value = predicate();
      if (value) {
        clearTimeout(timer);
        unsubscribe?.();
        resolve(value);
      }
    });
  });
}
