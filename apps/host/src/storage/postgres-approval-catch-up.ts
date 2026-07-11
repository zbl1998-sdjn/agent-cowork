type CatchUpOptions<Entry> = {
  snapshot: () => Array<[string, Entry]>;
  reconcile: (id: string, entry: Entry) => Promise<void>;
  onError: () => void;
};

export function createPostgresApprovalCatchUp<Entry>(
  options: CatchUpOptions<Entry>,
): () => void {
  let running = false;
  let queued = false;
  const report = (): void => {
    try { options.onError(); } catch { /* reporting cannot break catch-up */ }
  };
  const run = async (): Promise<void> => {
    do {
      queued = false;
      for (const [id, entry] of options.snapshot()) {
        try { await options.reconcile(id, entry); } catch { report(); }
      }
    } while (queued);
  };
  const start = (): void => {
    if (running) { queued = true; return; }
    running = true;
    void run().catch(report).finally(() => {
      running = false;
      if (queued) start();
    });
  };
  return start;
}
