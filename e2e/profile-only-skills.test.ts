/**
 * Browser E2E — the add-skill popover on a job's unmatched skill pills.
 *
 * This covers the one layer SSR and API assertions can't reach: that the
 * popover actually opens on click, that "Show on CV" defaults to off, and that
 * it dismisses on an outside click. The dismissal case is the reason this file
 * exists — a click-outside handler is easy to get wrong in exactly one
 * direction, where the same click that opens the popover immediately closes it
 * again, and nothing but a real browser will tell you.
 *
 * Leaves the profile alone: it never completes an add, and the requests that
 * would write are intercepted, so the suite is repeatable. The write paths are
 * covered by unit tests and were exercised directly against the API. The one
 * write is the job it reads, which it inserts first and deletes afterwards.
 *
 * Prerequisites: dev stack running, test user seeded (see browser.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginViaUI, useBrowser } from './browser';
import { literal, sql } from './db';

/**
 * Skills no profile has. Invented, so they stay unmatched whatever the test
 * profile holds, and every one is the interactive "I have this" kind.
 */
const UNHELD_SKILLS = ['Quillmark', 'Fernwave CI', 'Tessellate DB'];

/** Only unmatched pills carry this title, which is what makes them clickable. */
const ADD_PILL = 'button[title*="add it to my profile"]';

/** Any pill for a skill the profile has — these open the editor, not the add form. */
const KNOWN_PILL = 'button[title^="In your profile"]';

describe('profile-only skills popover', () => {
	const b = useBrowser();

	// Once per suite: the context is shared, and loginViaUI navigates to /login,
	// which redirects away once authenticated — leaving it waiting on an #email
	// field that never appears.
	/**
	 * One job made for the suite and deleted after it. It requires the unheld
	 * skills above and a few the selected profile does hold, and it has no
	 * stored match at all, so the page has to tell the two apart from profile
	 * data alone: the matcher's view and the profile's disagree all the time,
	 * because the matcher ran once, at a moment, and it is an LLM.
	 *
	 * The suite used to point at two scraped jobs by id, and went red the day
	 * a prune removed them from the dev database.
	 */
	let jobId: number | null = null;

	beforeAll(async () => {
		await loginViaUI(b.page);

		// The profile the app selected at sign-in is the one the job page reads.
		const cookie = (await b.page.context().cookies()).find((c) => c.name === 'selected_profile_id');
		const profileId = Number(cookie?.value);
		if (!Number.isInteger(profileId)) {
			throw new Error('No selected_profile_id cookie after sign-in');
		}

		// Held skills that print on documents, so the editor opens with "Show on
		// CV" on. A name with any negated tag on any of its rows is left out:
		// the page resolves a duplicate name to its first row.
		const held = sql(`
			SELECT min(s.name)
			FROM tech_skills s
			JOIN tech_skill_categories c ON c.id = s.category_id
			WHERE c.profile_id = ${profileId} AND trim(coalesce(s.name, '')) <> ''
			GROUP BY lower(trim(s.name))
			HAVING bool_and(coalesce(s.tags::text, '') NOT LIKE '%"!%')
			ORDER BY 1
			LIMIT 3
		`).map(([name]) => name);
		if (held.length === 0) {
			throw new Error(`Profile ${profileId} has no skill shown on documents to test with`);
		}

		const required = [held[0], UNHELD_SKILLS[0], ...held.slice(1), ...UNHELD_SKILLS.slice(1)];
		const [[id]] = sql(`
			INSERT INTO jobs (status, title, company, job_description, skills_required, date_created)
			VALUES ('hiring', 'E2E skill pills', 'Acme Corp',
				'A job made by profile-only-skills.test.ts and deleted after it.',
				${literal(JSON.stringify(required))}::json, now())
			RETURNING id
		`);
		jobId = Number(id);
	});

	afterAll(() => {
		// Matches and statuses the visit may have left cascade with it.
		if (jobId !== null) sql(`DELETE FROM jobs WHERE id = ${jobId}`);
	});

	async function openJob() {
		await b.page.goto(`/jobs/${jobId}`);
		await b.page.waitForLoadState('networkidle');
	}

	async function openFirstPopover() {
		await openJob();
		const pill = b.page.locator(ADD_PILL).first();
		await pill.waitFor({ state: 'visible', timeout: 15000 });
		await pill.click();
		return pill;
	}

	it('renders unmatched required skills as clickable add buttons', async () => {
		await openJob();
		expect(await b.page.locator(ADD_PILL).count()).toBeGreaterThan(0);
	});

	it('opens the popover with Show on CV defaulted off', async () => {
		await openFirstPopover();

		const toggle = b.page.getByRole('button', { name: 'Show on CV' });
		await toggle.waitFor({ state: 'visible', timeout: 10000 });

		// Off by default: the skill starts counting for matching without landing
		// on any document until the applicant says so.
		expect(await toggle.getAttribute('aria-pressed')).toBe('false');
		expect(
			await b.page
				.getByText(/Stays off your resume/i)
				.first()
				.isVisible()
		).toBe(true);

		// Still there a beat later. The popover used to open and then vanish on
		// its own, because a request fired on click could resolve into a state
		// that swapped the whole pill out — taking the open popover with it.
		await b.page.waitForTimeout(1500);
		expect(await toggle.isVisible()).toBe(true);
	});

	it("can file the skill under a category the profile doesn't have yet", async () => {
		// Skills arrive in whatever order jobs do, so the category you want is
		// regularly one that doesn't exist — and leaving to create it first loses
		// the job you were reading. The request is intercepted so the profile is
		// left alone; that the server then creates and reuses the category is
		// covered by the API's own tests.
		let posted: string | null = null;
		await b.page.route('**/api/profile-skills', async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			posted = route.request().postData();
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ success: true, id: 0, name: '' })
			});
		});

		await openFirstPopover();
		const select = b.page.getByLabel('Category', { exact: true });
		await select.waitFor({ state: 'visible', timeout: 10000 });

		const options = await select.locator('option').allTextContents();
		expect(options.at(-1)).toContain('New category');

		const name = b.page.getByLabel('New category name');
		expect(await name.count()).toBe(0);
		await select.selectOption('new');
		await name.waitFor({ state: 'visible', timeout: 5000 });

		// An unnamed new category is refused rather than quietly filed elsewhere.
		await b.page.getByRole('button', { name: 'Add' }).click();
		await b.page.waitForTimeout(500);
		expect(posted).toBe(null);
		expect(await b.page.getByText('Name the new category.').isVisible()).toBe(true);

		await name.fill('  Data & ML  ');
		await b.page.getByRole('button', { name: 'Add' }).click();
		await b.page.waitForTimeout(800);
		expect(posted).toContain('"category_name":"Data & ML"');
		expect(posted).toContain('"category_id":null');

		await b.page.unroute('**/api/profile-skills');
	});

	it('never offers to add a skill the profile already has', async () => {
		// The pill has to decide from data the page already holds. Asking the
		// server only once the popover is open means the answer lands mid-click,
		// which is what made the popover appear to close itself.
		await b.page.goto(`/jobs/${jobId}`);
		await b.page.waitForLoadState('networkidle');
		await b.page.locator(KNOWN_PILL).first().waitFor({ timeout: 15000 });

		const known = await b.page.locator(KNOWN_PILL).allTextContents();
		expect(known.length).toBeGreaterThan(0);

		const offered = await b.page.locator(ADD_PILL).allTextContents();
		const overlap = offered.filter((o) => known.some((k) => k.trim() === o.trim()));
		expect(overlap).toEqual([]);
	});

	it('opens a skill the profile already has for editing, prefilled', async () => {
		// "Add it" and "change it" are the same thought a moment apart, so the
		// pill for an owned skill opens the same form showing what is true.
		let patched: string | null = null;
		await b.page.route('**/api/profile-skills', async (route) => {
			if (route.request().method() !== 'PATCH') return route.continue();
			patched = route.request().postData();
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ success: true, tags: null })
			});
		});

		await b.page.goto(`/jobs/${jobId}`);
		await b.page.waitForLoadState('networkidle');
		const pill = b.page.locator(KNOWN_PILL).first();
		await pill.waitFor({ state: 'visible', timeout: 15000 });
		await pill.click();

		// Prefilled from the profile row, not from a blank form's defaults.
		const category = b.page.getByLabel('Category', { exact: true });
		await category.waitFor({ state: 'visible', timeout: 10000 });
		expect(await category.inputValue()).not.toBe('new');
		expect(
			await b.page.getByRole('button', { name: 'Show on CV' }).getAttribute('aria-pressed')
		).toBe('true');

		// It saves, rather than adding a second copy of a skill you already have.
		// Scoped to the popover — the page has its own "Save job" button.
		await b.page.locator('div.z-50').getByRole('button', { name: 'Save' }).click();
		await b.page.waitForTimeout(800);
		expect(patched).toContain('"id":');
		expect(patched).toContain('"profile_only":false');

		await b.page.unroute('**/api/profile-skills');
	});

	it('closes on an outside click without having added anything', async () => {
		await openFirstPopover();

		const toggle = b.page.getByRole('button', { name: 'Show on CV' });
		await toggle.waitFor({ state: 'visible', timeout: 10000 });

		// Somewhere neutral, well away from the popover.
		await b.page.locator('body').click({ position: { x: 5, y: 5 } });
		await toggle.waitFor({ state: 'hidden', timeout: 5000 });
		expect(await toggle.isVisible()).toBe(false);

		// The pill is still the "add" kind — nothing was written.
		expect(await b.page.locator(ADD_PILL).count()).toBeGreaterThan(0);
	});

	it('reopens after being dismissed', async () => {
		// Guards the failure mode where the click-outside listener is armed
		// permanently and swallows every subsequent open.
		await openFirstPopover();
		await b.page.locator('body').click({ position: { x: 5, y: 5 } });

		const toggle = b.page.getByRole('button', { name: 'Show on CV' });
		await b.page.locator(ADD_PILL).first().click();
		await toggle.waitFor({ state: 'visible', timeout: 10000 });
		expect(await toggle.isVisible()).toBe(true);
	});
});
