/**
 * Direct SQL against the dev database, for fixtures no page can create.
 *
 * Most e2e setup goes through the app (`formAction`, `request`), which keeps
 * the test honest about what a user can do. Some records have no such path, a
 * scraped job being the usual one: jobs arrive from the scraper, and the only
 * hand-made kind comes bundled with an application. A test that needs one
 * inserts it here and deletes it when it is done, rather than pointing at an
 * id in somebody's database, which the next restore or prune takes away.
 *
 * Runs psql inside the compose `database` service, the same way `browser.ts`
 * reaches the `chrome` one, so it needs the Docker CLI on the host.
 */

import { execFileSync } from 'child_process';

const COMPOSE_DIR = process.env.SJS_CLOUD_DIR || `${process.cwd()}/..`;

/**
 * Run SQL and return its rows, each an array of column values as text.
 *
 * The statement goes in on stdin, so nothing in it needs shell quoting; values
 * still need SQL quoting, which is what `literal` is for. A failing statement
 * throws (`ON_ERROR_STOP`), so a fixture that did not insert stops the suite
 * instead of leaving it to time out on a page that 404s.
 */
export function sql(query: string): string[][] {
	const out = execFileSync(
		'docker',
		[
			'compose',
			'exec',
			'-T',
			'database',
			'sh',
			'-c',
			// Expanded inside the container, where the image sets both.
			'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqz'
		],
		{ cwd: COMPOSE_DIR, input: query, encoding: 'utf-8' }
	);
	// -z separates fields with a NUL; records stay newline-separated.
	return out
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => line.split('\0'));
}

/** A value as an SQL string literal. */
export function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
