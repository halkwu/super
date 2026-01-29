import { randomBytes } from "crypto";
import { chromium, Page, BrowserContext, Browser, Locator } from "playwright";
import { launchChrome } from './launch_chrome';
const cp = require('child_process');

let browserInstance: Browser | null = null;

interface SessionEntry {
    browser?: Browser | any;
    context: BrowserContext | null;
    page?: Page | null;
    storageState?: any;
    verified?: boolean;
    otp_required?: boolean;
    otpAttempts?: number;
    launchedPid?: number | null;
}

const sessionStore = new Map<string, SessionEntry>();

async function safeCloseBrowser(browser: Browser | any) {
    try {
        if (!browser) return;
        if (browser.disconnect) await browser.disconnect().catch(() => {});
        else await browser.close().catch(() => {});
    } catch (_) {}
}

async function closeSession(sessionOrKey?: string | SessionEntry, opts?: { preserveBrowser?: boolean }): Promise<void> {
    const preserveBrowser = opts?.preserveBrowser === true;
    try {
        if (!sessionOrKey) return;
        let s: SessionEntry | null = null;
        let keyToDelete: string | null = null;
        if (typeof sessionOrKey === 'string') {
            keyToDelete = sessionOrKey;
            s = sessionStore.get(sessionOrKey) || null;
        } else {
            s = sessionOrKey;
        }
        if (!s) return;

        try {
            const page = s.page as Page | undefined;
            const context = s.context as BrowserContext | undefined;
            if (page) {
                try { await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} }); } catch (_) {}
            }

            if (context && typeof (context as any).clearCookies === 'function') {
                try { await (context as any).clearCookies(); } catch (_) {}
            } else if (page && typeof page.context === 'function') {
                try {
                    const client = await page.context().newCDPSession(page as any);
                    await client.send('Network.clearBrowserCookies');
                    try {
                        await client.send('Storage.clearDataForOrigin', { origin: 'https://portal.australiansuper.com', storageTypes: 'all' });
                    } catch (_) {}
                } catch (_) {}
            }
        } catch (_) {}

        try { if (s.page) await s.page.close().catch(() => {}); } catch (_) {}
        try { if (s.context) await s.context.close().catch(() => {}); } catch (_) {}

        try {
            const shouldCloseBrowser = !preserveBrowser;
            if (s.browser && shouldCloseBrowser) {
                if (s.browser.disconnect) await s.browser.disconnect().catch(() => {});
                else await s.browser.close().catch(() => {});
            } else if (s.browser && !shouldCloseBrowser) {
                try { if (s.browser.disconnect) await s.browser.disconnect().catch(() => {}); } catch (_) {}
            }
        } catch (_) {}

        try {
            const pid = (s && s.launchedPid) || null;
            if (pid && !preserveBrowser) {
                try { cp.execSync(`taskkill /PID ${pid} /T /F`); } catch (_) {}
            }
        } catch (_) {}

        if (keyToDelete) {
            try { sessionStore.delete(keyToDelete); } catch (_) {}
        } else {
            for (const [k, v] of sessionStore.entries()) {
                if (v === s) { try { sessionStore.delete(k); } catch (_) {} ; break; }
            }
        }
    } catch (_) {}
}

async function launchBrowserForSession(headless = false, userDataDir?: string): Promise<{ browser: Browser | null; context: BrowserContext | null; launchedPid: number | null; reusedPage?: Page | null; profile?: string }> {
  // Pick a random port in a high range to avoid collisions with default 9222
  const min = 9300;
  const max = 9999;
  const port = Math.floor(Math.random() * (max - min + 1)) + min;
  const profile = userDataDir;
  let launchedPid: number | null = null;
  try {
    launchedPid = launchChrome(process.env.CHROME_PATH, profile, port);
    if (launchedPid) console.log(`Launched per-session Chrome (pid=${launchedPid}) on port ${port}`);
  } catch (e) {
    console.error('Error launching per-session Chrome:', e);
  }

  const start = Date.now();
  const timeout = 10000;
  let browser: Browser | null = null;
  while (Date.now() - start < timeout) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  if (!browser) {
    // Failed to connect; try to kill launched pid
    if (launchedPid) {
      try { cp.execSync(`taskkill /PID ${launchedPid} /T /F`); } catch (_) {}
    }
    return { browser: null, context: null, launchedPid: null, reusedPage: null, profile };
  }

  try {
    const existingContexts = typeof (browser as Browser).contexts === 'function' ? (browser as Browser).contexts() : [];
    if (!existingContexts || !existingContexts.length) {
      try { await safeCloseBrowser(browser); } catch (_) {}
      if (launchedPid) { try { cp.execSync(`taskkill /PID ${launchedPid} /T /F`); } catch (_) {} }
      return { browser: null, context: null, launchedPid: null, reusedPage: null, profile };
    }
    const context = existingContexts[0];
    let reusedPage: Page | null = null;
    try {
      const pages = (typeof context.pages === 'function' ? context.pages() : (context.pages || [])) as Page[];
      if (pages && pages.length) reusedPage = pages[0];
    } catch (_) {}
    return { browser, context, launchedPid, reusedPage, profile };
  } catch (e) {
    await safeCloseBrowser(browser);
    if (launchedPid) { try { cp.execSync(`taskkill /PID ${launchedPid} /T /F`); } catch (_) {} }
    return { browser: null, context: null, launchedPid: null, reusedPage: null, profile };
  }
}

async function findAndFill(page: Page, selectors: string[], value: string) {
   async function Fill(locator: Locator) {
        const strategies = [
            async (loc: Locator) => {
                try {
                    await loc.evaluate((el: any) => {
                        try {
                            el.setAttribute && el.setAttribute('autocomplete', 'off');
                            el.autocomplete = 'off';
                            if (typeof (el as HTMLInputElement).value !== 'undefined') (el as HTMLInputElement).value = '';
                        } catch (_) {}
                    });
                } catch (_) {}

                try {
                    await loc.type(value, { delay: 20 });
                } catch (err) {
                    const msg = err && (((err as Error).message) || String(err)) || 'unknown error';
                    console.error(`Fill.failed.fill — ${msg}`);
                    throw err;
                }

                try {
                    const actual = await loc.inputValue();
                    if (actual === value || actual.includes(value)) {
                        return true;
                    }
                    console.warn(`value mismatch after fill. Expected "${value}", got "${actual}"`);
                } catch (err) {
                    console.error(`Fill.failed.verify — ${(err as Error).message}`);
                }

                return false;
            },
        ];

        for (const strat of strategies) {
            try {
                const ok = await strat(locator);
                if (ok) return true;
            } catch (err) {
                const msg = err && (((err as Error).message) || String(err)) || 'unknown error';
                console.error(`Fill failed — ${msg}`);
            }
        }
        return false;
    }

    async function Find(root: Page, selector: string, options?: { timeout?: number; }): Promise<Locator | null> {
        const timeout = options?.timeout ?? 1000;
        try {
            const locator = root.locator(selector).first();
            await locator.waitFor({ state: 'visible', timeout });
            return locator;
        } catch {
            // not found
        }
        return null;
    }

    for (const sel of selectors) {
        const locator = await Find(page, sel);
        if (locator) {
            if (await Fill(locator)) return true;
        }
    }
    return false;
}

async function clickFirst(page: Page, selectors: string[], options?: { timeout?: number; waitAfterClick?: boolean }): Promise<boolean> {
    const timeout = options?.timeout ?? 2000;
    const waitAfterClick = options?.waitAfterClick ?? true;

    async function locateFirst(root: Page, selector: string): Promise<Locator | null> {
        try {
            const locator = root.locator(selector).first();
            await locator.waitFor({ state: 'visible', timeout });
            return locator;
        } catch {
            return null;
        }
    }

    for (const sel of selectors) {
        const locator = await locateFirst(page, sel);
        if (!locator) continue;
        try {
            await locator.scrollIntoViewIfNeeded();
            await locator.click({ timeout });
            if (waitAfterClick) {
                try {
                    await Promise.race([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 2000 }),
                        locator.waitFor({ state: 'detached', timeout: 2000 }),
                    ]);
                } catch {
                    return false;
                }
            }
            return true;
        } catch (err) {
            console.error(`clickFirst: failed to click selector "${sel}" — ${(err as Error).message}`);
        }
    }
    return false;
}

export async function requestOtp(username: string, password: string, headless = false, userDataDir?: string): Promise<{ identifier: string | null; storageState?: any; response?: string }> {
  const { browser: b, context: initialContext, launchedPid, reusedPage } = await launchBrowserForSession(headless, userDataDir);
  browserInstance = b;
  if (!b) {
    return { identifier: null, storageState: null, response: 'fail' };
  }
  // Prefer context returned by the launcher; if not present, create a new per-session context.
  let context = initialContext;
  if (!context && b && typeof (b as any).newContext === 'function') {
    try { context = await (b as any).newContext(); } catch { context = null; }
  }
  if (!context) {
    return { identifier: null, storageState: null, response: 'fail' };
  }

  let page: Page;
  try {
    page = await context.newPage();
  } catch {
    if (reusedPage) {
      try { page = reusedPage; } catch { return { identifier: null, storageState: null, response: 'fail' }; }
    } else {
      return { identifier: null, storageState: null, response: 'fail' };
    }
  }
    try {
        await page.goto('https://portal.australiansuper.com/login');

        const usernameInput = '#login-form\\.login-fieldset\\.username';
        await page.waitForSelector(usernameInput, { state: 'visible', timeout: 8000 });
        await findAndFill(page, [usernameInput], username);

        const nextButton = 'button[data-target-id="login--form--login-proceed-cta"]';
        await clickFirst(page, [nextButton]);

        const passwordInput = '#login-form\\.password-fieldset\\.password';
        await page.waitForSelector(passwordInput, { state: 'visible', timeout: 8000 });
        await findAndFill(page, [passwordInput], password);

        const loginButton = 'button[data-target-id="login--form--login-cta"]';
        await clickFirst(page, [loginButton]);

        try { await Promise.race([ page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 2000 }) ]); } catch (_) {}

        const verificationSelectors = ['input[id="login-otp-validation-form-config.verificationCode"]'];
        let foundVerification = false;
        for (const sel of verificationSelectors) {
            try {
                await page.waitForSelector(sel, { state: 'visible', timeout: 2000 });
                foundVerification = true; break;
            } catch (_) { }
        }

        const storageState = await context.storageState();
        if (foundVerification) {
            const identifier = randomBytes(4).toString('hex');
            sessionStore.set(identifier, { browser: b, context, page, storageState, verified: false, otp_required: true, otpAttempts: 0, launchedPid });
            return { identifier, storageState, response: 'need_otp' };
        }

        await closeSession({ browser: b, context, page, launchedPid });
        return { identifier: null, storageState: undefined, response: 'fail' };
    } catch (e) {
        console.error('requestOtp error:', e);
        try { await closeSession({ browser: b, context, page, launchedPid }); } catch (_) {}
        return { identifier: null, storageState: undefined, response: 'fail' };
    }
}

export async function verifyOtp(otp: string, storageIdentifier: any): Promise<{ response: string }> {
    let stored: SessionEntry | undefined;
    let sessionKey: string | null = null;
    if (typeof storageIdentifier === 'string') {
        sessionKey = storageIdentifier; stored = sessionStore.get(sessionKey);
    } else if (storageIdentifier && typeof storageIdentifier === 'object') {
        for (const [k, v] of sessionStore.entries()) {
            if ((v as any).storageState === storageIdentifier) { stored = v; sessionKey = k; break; }
        }
    }

    if (!stored || !stored.otp_required || !stored.page) return { response: 'request_otp first' };

    const page = stored.page;
    try {
        const verificationSelectors = ['input[id="login-otp-validation-form-config.verificationCode"]'];
        let filled = false;
        for (const sel of verificationSelectors) {
            try { await page.waitForSelector(sel, { state: 'visible', timeout: 3000 }); await page.fill(sel, otp); filled = true; break; } catch (_) {}
        }
        if (!filled) return { response: 'verification_input_not_found' };

        const verifyButton = 'button[data-target-id="login-otp-validation-form--continue-button"]';
        await clickFirst(page, [verifyButton]);

        try { const feedbackButton = 'button:has-text("No Thanks")'; await clickFirst(page, [feedbackButton]); } catch (_) {}

        try {
            const trustDeviceButton = `button:has-text("Don't trust")`;
            await page.waitForSelector(trustDeviceButton, { state: 'visible', timeout: 3000 });
            await clickFirst(page, [trustDeviceButton]);
        } catch (_) {
            // no trust device prompt
        }

        // Wait briefly for either successful navigation or remaining verification input / error message
        let success = false;
        try {
            await Promise.race([
                page.waitForURL('https://portal.australiansuper.com/', { timeout: 5000 }).then(() => { success = true; }),
                page.waitForSelector(verificationSelectors[0], { state: 'visible', timeout: 5000 }),
                page.waitForSelector('div[role="alert"], .error, .validation-message', { timeout: 5000 }).catch(() => {})
            ]);
        } catch (_) {}

        if (success) {
            try { if (stored) stored.verified = true; } catch (_) {}
            try { if (stored) stored.otpAttempts = 0; } catch (_) {}
            // Persist session state
            try { if (sessionKey) sessionStore.set(sessionKey, stored); } catch (_) {}
            return { response: 'success' };
        }

        // Not successful: increment attempt counter and persist.
        try { stored.otpAttempts = (stored.otpAttempts || 0) + 1; } catch (_) { stored.otpAttempts = 1; }
        try { if (sessionKey) sessionStore.set(sessionKey, stored); } catch (_) {}

        // If this is the first incorrect attempt, keep the session/browser alive
        // and allow the caller/user to retry once more.
        if ((stored.otpAttempts || 0) <= 1) {
            return { response: 'verify code incorrect, you only have 1 more attempt' };
        }

        // Second failure: cleanup the session, release the slot and close browser.
        try { await closeSession(sessionKey ?? stored); } catch (_) {}
        return { response: 'fail' };
    } catch (e) {
        console.error('verifyOtp error:', e);
        return { response: 'fail' };
    }
}

export async function resendOtp(storageIdentifier: any): Promise<{ response: string }> {
    let stored: SessionEntry | undefined;
    let sessionKey: string | null = null;
    if (typeof storageIdentifier === 'string') { sessionKey = storageIdentifier; stored = sessionStore.get(sessionKey); }
    else if (storageIdentifier && typeof storageIdentifier === 'object') {
        for (const [k, v] of sessionStore.entries()) { if ((v as any).storageState === storageIdentifier) { stored = v; sessionKey = k; break; } }
    }
    if (!stored || !stored.page) return { response: 'invalid_identifier' };
    try {
        const page = stored.page;
        const resendSelector = 'button[data-target-id="login-otp-validation-form--resend-code-button"]';
        await page.waitForSelector(resendSelector, { state: 'visible', timeout: 3000 });
        await clickFirst(page, [resendSelector]);
        return { response: 'sent' };
    } catch (err) {
        console.warn('resendOtp error:', err);
        return { response: 'fail' };
    }
}

export async function queryWithSession(storageIdentifier: any): Promise<{ id: string; name: string; balance: number; currency: string } | null> {
    let stored: SessionEntry | undefined;
    let sessionKey: string | null = null;
    if (typeof storageIdentifier === 'string') { sessionKey = storageIdentifier; stored = sessionStore.get(sessionKey); }
    else if (storageIdentifier && typeof storageIdentifier === 'object') {
        for (const [k, v] of sessionStore.entries()) { if ((v as any).storageState === storageIdentifier) { stored = v; sessionKey = k; break; } }
    }
    if (!stored) { console.warn('queryWithSession: no stored session found for identifier'); return null; }
    if (stored.verified !== true) { console.warn('queryWithSession: session not verified; call verifyOtp first'); return null; }
    if (!stored.page || !stored.context) return null;

    const page = stored.page;
    try {
        await page.goto('https://portal.australiansuper.com/');
        await page.waitForSelector('h1', { timeout: 6000 });
        let name = '';
        try {
            const h1 = page.locator('h1').first();
            if (await h1.count() > 0) {
                const heading = (await h1.textContent())?.replace(/\r?\n/g, ' ').trim() || '';
                const m = heading.match(/Welcome\s+(.+)$/i);
                if (m) name = m[1].trim();
            }
        } catch (_) {}

        let memberId = '';
        try {
            const memberIdLocator = page.locator('p:has-text("Member number") + p').first();
            if (await memberIdLocator.count() > 0) memberId = (await memberIdLocator.textContent())?.trim() || '';
        } catch (_) {}

        const transactionsButton = 'button:has-text("Transactions")';
        await clickFirst(page, [transactionsButton]);
        const contributionsDropdownLink = 'div[aria-hidden="false"] a:has-text("Contributions")';
        await clickFirst(page, [contributionsDropdownLink]);
        const viewtransactionsLink = 'a:has-text("View all contributions")';
        await clickFirst(page, [viewtransactionsLink]);
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 });

        let balance = 0;
        try {
            const balanceElements = await page.locator('p[class*="SummaryBalance"]');
            const balanceText = (await balanceElements.first().textContent())?.replace('$', '').trim() || '';
            balance = parseFloat(balanceText.replace(/,/g, '')) || 0;
        } catch (_) {}

        const result = { id: memberId, name, balance, currency: 'AUD' };
        return result;
    } catch (err) {
        console.error('queryWithSession failed:', err);
        return null;
    } finally {
        try { await closeSession(sessionKey ?? stored); } catch (_) {}
    }
}


