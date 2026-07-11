type TestEnvironment = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TEST_DATABASE_TOKEN = /(?:^|_)test(?:_|$)/u;

function invalid(reason: string): Error {
  return new Error(`KCW_TEST_POSTGRES_URL ${reason}`);
}

/**
 * Return the one explicitly approved integration-test URL.
 *
 * This boundary deliberately never reads DATABASE_URL. A caller must opt in
 * with KCW_TEST_POSTGRES_URL, target loopback (or the fixed GitHub Actions
 * service name), and use a database whose name has a standalone `test` token.
 */
export function requireEphemeralPostgresUrl(
  environment: TestEnvironment = process.env,
): string {
  const raw = environment.KCW_TEST_POSTGRES_URL?.trim();
  if (!raw) throw invalid('is required; DATABASE_URL is never used');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid('must be a valid PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw invalid('must use the postgres or postgresql protocol');
  }
  if (parsed.search || parsed.hash) {
    throw invalid('must not contain query parameters or fragments');
  }

  const host = parsed.hostname.toLowerCase();
  const githubService = host === 'postgres'
    && environment.CI === 'true'
    && environment.GITHUB_ACTIONS === 'true';
  if (!LOOPBACK_HOSTS.has(host) && !githubService) {
    throw invalid('must target a loopback host or the GitHub Actions postgres service');
  }

  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw invalid('contains an invalid database name');
  }
  if (
    !database
    || database.includes('/')
    || !/^[a-z0-9_]+$/u.test(database)
    || !TEST_DATABASE_TOKEN.test(database)
  ) {
    throw invalid('must name an explicit lowercase test database');
  }
  return raw;
}
