/** Starting a run must survive a lost response (deploy, proxy timeout) without starting it twice.
 * The client names the run (UUID v4) before posting; a retry first asks whether that run exists. */
export type SubmitError = Error & { status?: number };
export type SubmitOptions<T> = {
  /** POST the run with the chosen id. */
  post: () => Promise<T>;
  /** GET the run by that id; null when the server does not know it (404). */
  find: () => Promise<T | null>;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};
/** Network failures and gateway errors are retried; everything else is the user's answer. */
export function isTransient(error: unknown) {
  const status = (error as SubmitError)?.status;
  if (status === undefined) return error instanceof TypeError || /fetch|network|indispon/i.test(String((error as Error)?.message || ""));
  return status === 0 || status === 502 || status === 503 || status === 504;
}
export async function submitRun<T>({ post, find, attempts = 4, delayMs = 1500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: SubmitOptions<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await post(); }
    catch (error) {
      // 409: the first request did land (the run or its job already exists); adopt it.
      if ((error as SubmitError)?.status === 409) {
        const existing = await find().catch(() => null);
        if (existing) return existing;
        throw error;
      }
      if (!isTransient(error) || attempt >= attempts - 1) throw error;
      await sleep(delayMs * 2 ** attempt);
      const existing = await find().catch(() => null);
      if (existing) return existing;
    }
  }
}
