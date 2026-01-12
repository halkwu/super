import { chromium, BrowserContext, Page } from "playwright";

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

	const memberSelectors = [
		'span[data-se="o-form-input-username"] input',
		'input#okta-signin-username',
		'input[name="memberNumber"]',
		'input[name="username"]',
		'input[id*="member"]',
		'input[placeholder*="Member"]',
		'input[type="text"]',
	];
	const filledMember = await tryFill(page, memberSelectors, id ?? '', 3000);
	if (!filledMember) console.warn("Member input not found — you may need to adjust selectors.");

	const passwordSelectors = [
		'span[data-se="o-form-input-password"] input',
		'input#okta-signin-password',
		'input[type="password"]',
		'input[name="password"]',
		'input[id*="password"]',
	];

	const filledPassword = await tryFill(page, passwordSelectors, pin ?? '', 3000);
	if (!filledPassword) console.warn("Password input not found — you may need to adjust selectors.");

	const submitted = await tryClick(page, [
		'input#okta-signin-submit',
		'div.o-form-button-bar input[type="submit"]',
		'button[type="submit"]',
		'button:has-text("Sign in")',
		'button:has-text("Log in")',
		'button:has-text("Login")',
		'input[type="submit"]',
	], 4000);

	if (!submitted) console.log("Submit button not found — attempted to press Enter instead.");

	try {
		await page.keyboard.press("Enter");
	} catch (e) {
		console.log("Error pressing Enter key:", e.message ?? e);
	}

	try {
		await page.waitForLoadState("networkidle");
	} catch (e) {
		const url = page.url();
		if (!url.includes("login")) {
			console.log("Login may have succeeded (URL changed):", url);
		} else {
			throw new Error("Login did not complete — check selectors or credentials.");
		}
	}
}

async function navigateToBalance(page: Page): Promise<boolean> {
	try {
		const clickedSuper = await tryClick(page, ['button:has-text("Super")', 'a:has-text("Super")'], 5000);
		if (clickedSuper) {
			await page.waitForFunction(() => {
				const els = Array.from(document.querySelectorAll('button, a'));
				const el = els.find(e => (e.textContent || '').trim().includes('Super'));
				return !!el && typeof el.className === 'string' && el.className.includes('navItemActive');
			}, {}, { timeout: 5000 }).catch(() => {});
		} else {
			console.log('Post-login: Super nav item not found/clickable');
		}

		const clickedBalance = await tryClick(page, ['a:has-text("Balance quote")', 'a[href*="balance-quote"]'], 5000);
		if (clickedBalance) {
			await page.waitForSelector('[data-testid="balance-quote-amount"]', { timeout: 10000 }).catch(() => {});
			return true;
		}
		console.log('Balance quote link not found after login.');
		return false;
	} catch (e) {
		console.log('Post-login navigation error:', e);
		return false;
	}
}

export async function queryBalance(id?: string, pin?: string, headless?: boolean): Promise<{ id?: string; name?: string; balance?: number; currency?: string } | null> {
	const browser = await chromium.launch({ headless });
	const { context } = await CreateContext(browser);
	const page = await context.newPage();
	try {
		await getLoginPage(page);
		await performLogin(page, id, pin);
		const ok = await navigateToBalance(page);
		if (!ok) return null;
		const info = await extractAccountInfo(page);
		return info;
	} catch (extractErr) {
		console.log('Error extracting account info:', extractErr);
		return null;
	} finally {
		await browser.close().catch(() => {});
	}
}

async function CreateContext(browser: any): Promise<{ context: BrowserContext; reused: boolean }> {
	const context = await browser.newContext();
	return { context, reused: false };
}

async function main() {
	const [, , id, pin, headlessArg] = process.argv;
	try {
		const info = await queryBalance(id, pin, headlessArg !== 'false');
		console.log(JSON.stringify(info, null, 2));
	} catch (err) {
		console.error("queryBalance failed:", err);
	}
}

if (require.main === module) {
	main();
}

