/**
 * Browser utilities for Playwright
 * Provides Chrome detection and browser context creation
 *
 * Uses persistent browser sessions that look like a normal browser
 * to anti-bot systems.
 */

import { existsSync } from 'fs';
import { type BrowserContext, chromium } from 'patchright';
import { config } from '#lib/server/config.ts';

// Chrome installation paths to check (Linux)
const CHROME_PATHS = [
	'/usr/bin/google-chrome-stable',
	'/usr/bin/google-chrome',
	'/opt/google/chrome/chrome',
	'/usr/bin/chromium-browser',
	'/usr/bin/chromium'
];

export interface BrowserLaunchOptions {
	headless?: boolean;
	args?: string[];
	viewport?: { width: number; height: number } | null;
}

/**
 * Find Google Chrome executable path
 * Priority: ENV var > known paths > undefined (fallback to Playwright's bundled Chromium)
 */
export function findChromeExecutable(): string | undefined {
	// 1. Check config override
	if (config.chromePath) {
		if (existsSync(config.chromePath)) {
			console.log(`✅ Using Chrome from config: ${config.chromePath}`);
			return config.chromePath;
		} else {
			console.warn(`⚠️  SJS_CHROME_PATH not found: ${config.chromePath}`);
		}
	}

	// 2. Check known Chrome installation paths
	for (const path of CHROME_PATHS) {
		if (existsSync(path)) {
			console.log(`✅ Using Chrome: ${path}`);
			return path;
		}
	}

	// 3. Not found - fallback to bundled Chromium
	console.warn('⚠️  Google Chrome not found. Using Playwright bundled Chromium.');
	console.warn('   For better compatibility, install Chrome:');
	console.warn('   Ubuntu/Debian: sudo apt install google-chrome-stable');
	console.warn('   Or set: export SJS_CHROME_PATH=/path/to/chrome');
	return undefined;
}

/**
 * Launch a browser and return a fresh context in it.
 *
 * The browser belongs to the context: closing the context closes the browser
 * too. Callers only ever see the context, so without this nothing could close
 * the browser, and every CV print, page-fit check and banner left its Chrome
 * running until the container restarted (20 of them, about 1 GB, on dev).
 */
export async function launchBrowser(options: BrowserLaunchOptions = {}): Promise<BrowserContext> {
	const executablePath = findChromeExecutable();

	console.log(`🚀 Launching browser...`);

	const viewport = options.headless ? { width: 1920, height: 1080 } : null;

	const browser = await chromium.launch({
		executablePath,
		headless: !!options.headless,
		args: options.args
	});

	let context: BrowserContext;
	try {
		context = await browser.newContext({ viewport });
	} catch (err) {
		await browser.close().catch(() => {});
		throw err;
	}

	// Await the browser inside close() itself, so a caller's
	// `await context.close()` returns once Chrome is gone.
	const closeContext = context.close.bind(context);
	context.close = async (closeOptions) => {
		try {
			await closeContext(closeOptions);
		} finally {
			await browser.close().catch(() => {});
		}
	};

	console.log('✅ Browser context created successfully');
	return context;
}
