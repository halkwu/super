import { chromium, BrowserContext, Page, Browser } from "playwright";
import { randomBytes } from "crypto";

// --- Shared browser/session management ---
let browserInstance: Browser | null = null;
const sessionStore = new Map<string, { context: BrowserContext; page: Page; verified?: boolean }>();

async function ensureBrowser(headless = true): Promise<Browser> {
	if (!browserInstance) {
		browserInstance = await chromium.launch({ headless });
		process.on('exit', async () => {
			try { await browserInstance?.close(); } catch (_) {}
		});
	}
	return browserInstance;
}

async function tryClick(page: Page, selectors: string[], timeout = 4000): Promise<boolean> {
	for (const s of selectors) {
		try {
			const locator = page.locator(s).first();
			const exists = await locator.count().catch(() => 0);
			if (!exists) {
				console.log(`tryClick: not found: ${s}`);
				continue;
			}
			const visible = await locator.isVisible().catch(() => false);
			try {
				if (visible) {
					await locator.click({ timeout });
				} else {
					await locator.click({ force: true, timeout });
				}
				return true;
			} catch (clickErr) {
				console.log(`tryClick: click failed for ${s}:`, clickErr.message ?? clickErr);
			}
		} catch (e) {
			console.log(`tryClick: error testing selector ${s}:`, e.message ?? e);
		}
	}
	return false;
}

async function tryFill(page: Page, selectors: string[], value: string, timeout = 4000): Promise<boolean> {
	for (const s of selectors) {
		try {
			const locator = page.locator(s).first();
			const exists = (await locator.count().catch(() => 0)) > 0;
			if (!exists) {
				console.log(`tryFill: not found: ${s}`);
				continue;
			}
			try {
				await locator.fill(value, { timeout });
				return true;
			} catch (fillErr) {
				console.log(`tryFill: fill failed for ${s}:`, fillErr.message ?? fillErr);
			}
		} catch (e) {
			console.log(`tryFill: error testing selector ${s}:`, e.message ?? e);
		}
	}
	return false;
}

async function getLoginPage(page: Page): Promise<void> {
	console.log("Navigating to cbussuper site...");
	await page.goto("https://www.cbussuper.com.au/");

	const MEMBER_MENU_SELECTORS = [
		'li[data-section="members"] a:has-text("Member login")',
		'li[data-section="members"] a',
		'li[data-section="members"]',
	];

	const opened = await tryClick(page, MEMBER_MENU_SELECTORS, 3000);

	if (!opened) return;

	try {
		await page.waitForSelector('li[data-section="members"].open, .subnav.members', { timeout: 3000 }).catch(() => {});

		const clickedLinkButton = await tryClick(page, ['div.link-button a.dtm-member-login'], 3000);
		if (clickedLinkButton) await page.waitForLoadState('networkidle').catch(() => {});

		const memberAnchor = page.locator('.subnav.members a.dtm-member-login, a.dtm-member-login').first();
		if (await memberAnchor.count() > 0) {
			const href = await memberAnchor.getAttribute('href');
			if (href) {
				try {
					await page.goto(href);
				} catch (e) {
					console.log('Navigation to dtm-member-login href failed, attempting click fallback');
					await memberAnchor.click().catch(() => {});
				}
			} else {
				await memberAnchor.click().catch(() => {});
			}
		}
	} catch (e) {
		console.log('Error while handling member subnav:', e.message ?? e);
	}
}

async function performLogin(page: Page, id?: string, pin?: string): Promise<void> {
	await page.waitForLoadState("networkidle");

	const memberSelectors = ['input[type="text"]'];
	const filledMember = await tryFill(page, memberSelectors, id ?? '', 3000);
	if (!filledMember) console.warn("Member input not found — you may need to adjust selectors.");

	const passwordSelectors = ['input[type="password"]'];
	const filledPassword = await tryFill(page, passwordSelectors, pin ?? '', 3000);
	if (!filledPassword) console.warn("Password input not found — you may need to adjust selectors.");

	const submitSelectors = [
		'div.o-form-button-bar input[type="submit"]',
		'button[type="submit"]',
		'button:has-text("Sign in")',
		'button:has-text("Log in")',
		'button:has-text("Login")',
		'input[type="submit"]',
	];

	// Try a direct locator click with a concurrent navigation wait for each candidate.
	let clicked = false;
	for (const s of submitSelectors) {
		try {
			const locator = page.locator(s).first();
			const exists = (await locator.count().catch(() => 0)) > 0;
			if (!exists) continue;

			const visible = await locator.isVisible().catch(() => false);
			const navWait = page.waitForNavigation({ waitUntil: 'networkidle', timeout: 3000 }).catch(() => null);
			if (visible) await Promise.all([locator.click({ timeout: 4000 }), navWait]);
			else await Promise.all([locator.click({ force: true, timeout: 4000 }), navWait]);

			await page.waitForLoadState('networkidle').catch(() => {});
			clicked = true;
			break;
		} catch (e) {
			console.log(`performLogin: click failed for ${s}:`, e.message ?? e);
		}
	}

	// Fallbacks: best-effort tryClick, then Enter key as last resort. Each ensures we wait for networkidle afterwards.
	if (!clicked) {
		const tried = await tryClick(page, submitSelectors, 4000);
		if (tried) {
			await page.waitForLoadState('networkidle').catch(() => {});
			clicked = true;
		}
	}
}

async function navigateToBalance(page: Page): Promise<boolean> {
	try {
		// Prefer clicking the Balance quote link inside the secondary links container
		const preferredSelectors = [
			'a.cta:has-text("Balance quote")',
			'a:has-text("Balance quote")',
			'a[href*="/super-account/balance-quote"]',
			'a[href*="balance-quote"]',
		];

		const clickedPreferred = await tryClick(page, preferredSelectors, 5000);
		if (clickedPreferred) {
			await page.waitForLoadState('networkidle').catch(() => {});
			await page.waitForSelector('[data-testid="balance-quote-amount"]', { timeout: 10000 }).catch(() => {});
			return true;
		}

		// Fallback: ensure Super nav is expanded then retry preferred selectors
		const clickedSuper = await tryClick(page, ['button:has-text("Super")', 'a:has-text("Super")'], 5000);
		if (clickedSuper) {
			await page.waitForFunction(() => {
				const els = Array.from(document.querySelectorAll('button, a'));
				const el = els.find(e => (e.textContent || '').trim().includes('Super'));
				return !!el && typeof el.className === 'string' && el.className.includes('navItemActive');
			}, {}, { timeout: 5000 }).catch(() => {});

			const clickedAfterSuper = await tryClick(page, preferredSelectors, 5000);
			if (clickedAfterSuper) {
				await page.waitForSelector('[data-testid="balance-quote-amount"]', { timeout: 10000 }).catch(() => {});
				return true;
			}
		} else {
			console.log('Post-login: Super nav item not found/clickable');
		}

		console.log('Balance quote link not found after login.');
		return false;
	} catch (e) {
		console.log('Post-login navigation error:', e);
		return false;
	}
}

async function extractAccountInfo(page: Page): Promise<{ id?: string; name?: string; balance?: number; currency?: string}> {
	return await page.evaluate(() => {
		const result: any = {};
		const headers = Array.from(document.querySelectorAll('h3'));
		const personalHeader = headers.find(h => (h.textContent || '').trim() === 'Personal details');
		let dl: Element | null = null;
		if (personalHeader) {
			if (personalHeader.nextElementSibling && personalHeader.nextElementSibling.tagName.toLowerCase() === 'dl') {
				dl = personalHeader.nextElementSibling;
			} else if (personalHeader.parentElement) {
				dl = personalHeader.parentElement.querySelector('dl');
			}
		}

		if (dl) {
			const divs = Array.from(dl.querySelectorAll('div'));
			for (const div of divs) {
				const dt = div.querySelector('dt');
				const dd = div.querySelector('dd');
				if (!dt || !dd) continue;
				const key = (dt.textContent || '').trim().toLowerCase();
				const val = (dd.textContent || '').trim();
				if (key.includes('member number')) result.id = val;
				if (key === 'name') result.name = val;
			}
		}

		let bal = document.querySelector('dt._balanceRolloverLabel_zchqw_5 + dd[data-testid="balance-quote-amount"]') || document.querySelector('[data-testid="balance-quote-amount"]');
		if (bal) {
			const txt = (bal.textContent || '').trim();
			// Try to extract currency symbol or 3-letter code
			let currency: string | undefined;
			const codeMatch = txt.match(/[A-Z]{3}/);
			if (codeMatch) {
				currency = codeMatch[0];
			} else {
				const symMatch = txt.match(/[^0-9.,\-\s]+/);
				if (symMatch) currency = symMatch[0].trim();
			}

			// Extract numeric portion, remove thousand separators
			const numStr = txt.replace(/[^0-9.,\-]/g, '').replace(/,/g, '');
			const balance = parseFloat(numStr);
			if (!Number.isNaN(balance)) result.balance = balance;
			if (currency) result.currency = currency;
		}
		return {
			id: result.id,
			name: result.name,
			balance: result.balance,
			currency:'AUD'
		};
	});
}

export async function requestSession(id?: string, pin?: string, headless = false): Promise<{ identifier: string | null; storageState?: any; response?: string }> {
		const browser = await ensureBrowser(headless);
		const context = await browser.newContext();
		const page = await context.newPage();
		try {
			await getLoginPage(page);
			await performLogin(page, id, pin);
			// Give the page a moment to settle after submit and any redirects
			
			try {
				try {
					const pwdCount = await page.locator('input[type="password"]').count().catch(() => 0);
					if (pwdCount > 0) {
						const pwdVisible = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
						if (pwdVisible) {
							await context.close().catch(() => {});
							return { identifier: null, storageState: null, response: 'fail' };
						}
					}
				} catch (_) {}
			const storageState = await context.storageState();
			const identifier = randomBytes(4).toString('hex');
			sessionStore.set(identifier, { context, page, verified: true });
			return { 
				identifier, 
				storageState, 
				response: 'success' };
		} catch (e) {
			await context.close().catch(() => {});
			return { identifier: null, storageState: null, response: 'fail' };
		}
	} catch (e) {
		return { identifier: null, response: 'fail' };
	}
}

export async function queryWithSession(storageIdentifier: any): Promise<{ id?: string; name?: string; balance?: number; currency?: string } | null> {
	try {
		// Expect `storageIdentifier` to be either the object returned by `requestSession` or the identifier string.
		if (!storageIdentifier) return null;

		let identifier: string | undefined;
		if (typeof storageIdentifier === 'string') {
			identifier = storageIdentifier;
		} else if (typeof storageIdentifier === 'object' && storageIdentifier !== null && typeof storageIdentifier.identifier === 'string') {
			identifier = storageIdentifier.identifier;
		} else {
			return null;
		}

		if (!identifier || !sessionStore.has(identifier)) return null;
		const stored = sessionStore.get(identifier) as any;
		if (!stored || stored.verified !== true) return null;
		try {
			const page = stored.page;
			await page.bringToFront?.().catch(() => {});
			try {
				// Navigate to Home first to ensure consistent nav state, then go to Balance quote
				const homeSelectors = [
					'a:has-text("Home")',
					'a._navItem_1b0ub_55:has-text("Home")',
					'a._navItem_1b0ub_55._buttonReset_1b0ub_11:has-text("Home")',
					'a[href="/"]',
					'a[href*="?acc=super"]',
				];
				try {
					const homeClicked = await tryClick(page, homeSelectors, 3000);
					if (homeClicked) await page.waitForLoadState('networkidle').catch(() => {});
				} catch (clickErr) {
					console.log('queryWithSession: home click failed:', clickErr);
				}

				// Ensure the page is showing the balance/personal details before extracting
				const ok = await navigateToBalance(page);
				if (!ok) console.log('queryWithSession: navigateToBalance returned false; extraction may miss data');
			} catch (navErr) {
				console.log('queryWithSession: navigateToBalance threw:', navErr && (navErr as any).message ? (navErr as any).message : navErr);
			}
			// Extract information, then clean up the Playwright context and remove the stored session
			const result = await extractAccountInfo(page);
			try {
				await stored.context.close().catch(() => {});
			} catch (_) {}
			try {
				sessionStore.delete(identifier);
			} catch (_) {}
			return result;
		} catch (e) {
			console.log('queryWithSession failed for stored session:', e);
			return null;
		}
	} catch (e) {
		console.log('queryWithSession failed:', e && (e as any).message ? (e as any).message : e);
		return null;
	}
}
