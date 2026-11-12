// Runs one suite and reports its cases. Shared by the worker (demo pacing) and the tests (pace = no-op).
//
// report(msg) receives:
//   { type: 'suite', id, status: 'running' }
//   { type: 'progress', id, text }
//   { type: 'case', id, name, ok, detail }
//   { type: 'summary', id, text }
//   { type: 'markers', id, addresses, txHashes }   things the fork created (the main thread checks they never leak)
//   { type: 'suiteEnd', id, status: 'pass' | 'fail' }
const PROGRESS_MIN_MS = 90;
const CASE_PACE_BASE_MS = 120;
const CASE_PACE_JITTER_MS = 130;

export async function runSuite(suite, { report = () => {}, rng, pace = async () => {}, options = {} } = {}) {
  const id = suite.id;
  const cases = [];
  let summary = '';
  let lastProgressAt = 0;
  let pendingProgress = null;

  const flushProgress = () => {
    if (pendingProgress === null) return;
    report({ type: 'progress', id, text: pendingProgress });
    pendingProgress = null;
    lastProgressAt = Date.now();
  };

  const ctx = {
    id, rng, options,
    pace: async (ms) => { await pace(ms); },
    // Progress text like "vector 7/22". At most ~10 updates per second; the last one is always flushed.
    progress(text) {
      pendingProgress = text;
      if (Date.now() - lastProgressAt >= PROGRESS_MIN_MS) flushProgress();
    },
    // Records one case and waits a little so the audience can follow. Returns ok.
    async check(name, ok, detail = '') {
      flushProgress();
      const entry = { name, ok: !!ok, detail: String(detail) };
      cases.push(entry);
      report({ type: 'case', id, ...entry });
      await pace(CASE_PACE_BASE_MS + ((cases.length * 53) % CASE_PACE_JITTER_MS));
      return entry.ok;
    },
    summary(text) { summary = text; },
    mark({ addresses = [], txHashes = [] } = {}) { report({ type: 'markers', id, addresses, txHashes }); },
  };

  report({ type: 'suite', id, status: 'running' });
  try {
    const returned = await suite.run(ctx);
    if (typeof returned === 'string') summary = returned;
  } catch (err) {
    cases.push({ name: 'Error inesperado', ok: false, detail: String(err?.message ?? err) });
    report({ type: 'case', id, ...cases[cases.length - 1] });
    if (!summary) summary = `Error inesperado: ${err?.message ?? err}`;
  }
  flushProgress();
  if (summary) report({ type: 'summary', id, text: summary });
  const status = cases.length > 0 && cases.every((c) => c.ok) ? 'pass' : 'fail';
  report({ type: 'suiteEnd', id, status });
  return { id, status, cases, summary };
}
