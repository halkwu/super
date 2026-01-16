import { randomBytes } from "crypto";
import { chromium, Page, BrowserContext, Browser } from "playwright";
import { launchChrome } from './launch_chrome';
const cp = require('child_process');

// --- Shared browser/session management ---
let browserInstance: Browser | null = null;
const sessionStore = new Map<string, { browser?: any; context: BrowserContext; page: Page; storageState?: any; verified?: boolean; otp_required?: boolean; launchedPid?: number | null }>();

// Close a single session by object or by key. Deletes sessionStore entry when key is provided/found.
export async function closeSession(sessionOrKey?: any): Promise<void> {
    try {
        if (!sessionOrKey) return;
        let s: any = null;
        let keyToDelete: string | null = null;
        if (typeof sessionOrKey === 'string') {
            keyToDelete = sessionOrKey;
            s = sessionStore.get(sessionOrKey);
        } else {
            s = sessionOrKey;
        }
        if (!s) return;

        // Attempt to clear local/session storage and cookies before closing.
        try {
            const page = s.page as Page | undefined;
            const context = s.context as BrowserContext | undefined;
            if (page) {
                try {
                    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
                } catch (_) {}
            }

            if (context && typeof (context as any).clearCookies === 'function') {
                try { await (context as any).clearCookies(); } catch (_) {}
            } else if (page && typeof (page as any).context === 'function') {
                try {
                    // @ts-ignore
                    const client = await (page as any).context().newCDPSession(page);
                    await client.send('Network.clearBrowserCookies');
                    try {
                        await client.send('Storage.clearDataForOrigin', { origin: 'https://portal.australiansuper.com', storageTypes: 'all' });
                    } catch (_) {}
                } catch (_) {}
            }
        } catch (_) {}

        // Close page/context/browser and kill any launched PID
        try { if (s.page) await s.page.close().catch(() => {}); } catch (_) {}
        try { if (s.context) await s.context.close().catch(() => {}); } catch (_) {}
        try {
            if (s.browser) {
                if (s.browser.disconnect) await s.browser.disconnect().catch(() => {});
                else await s.browser.close().catch(() => {});
            }
        } catch (_) {}
        try { if (s.launchedPid) { cp.execSync(`taskkill /PID ${s.launchedPid} /T /F`); } } catch (_) {}

        if (keyToDelete) {
            try { sessionStore.delete(keyToDelete); } catch (_) {}
        } else {
            for (const [k, v] of sessionStore.entries()) {
                if (v === s) { try { sessionStore.delete(k); } catch (_) {} ; break; }
            }
        }
    } catch (_) {}
}

async function launchBrowser(headless = false): Promise<{ browser: any; context: any; launchedPid: number | null }> {
    let browser: any = null;
    let context: any = null;
    let launchedPid: number | null = null;
    if (!headless) {
        try {
            const exePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
            const userDataDir = process.env.PW_USER_DATA || 'C:\\pw-chrome-profile';
            try {
                launchedPid = launchChrome(exePath, userDataDir, 9222);
                if (launchedPid) console.log(`Launched Chrome (pid=${launchedPid}), waiting for CDP...`);
            } catch (e) {
                console.error('Error invoking launchChrome:', e);
            }
        } catch (e) {
            console.error('Error preparing to launch Chrome:', e);
        }

        const start = Date.now();
        const timeout = 10000;
        while (Date.now() - start < timeout) {
            try {
                browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
                break;
            } catch (e) {
                await new Promise(r => setTimeout(r, 500));
            }
        }
    }

    if (!browser) {
        browser = await chromium.launch({ headless });
    }

    const existingContexts = (browser as any).contexts ? (browser as any).contexts() : [];
    context = existingContexts && existingContexts.length ? existingContexts[0] : await browser.newContext();
    // keep a reference for other helpers
    try { browserInstance = browser; } catch (_) {}
    return { browser, context, launchedPid };
}

export async function requestOtp(username: string, password: string, headless = false): Promise<{ identifier: string | null; storageState?: any; response?: string }> {
    const { browser: b, context, launchedPid } = await launchBrowser(headless);
    browserInstance = b;
    const page = await context.newPage();
    try {
        await page.goto("https://portal.australiansuper.com/login");
        const usernameInput = '#login-form\\.login-fieldset\\.username';
        await page.waitForSelector(usernameInput, { state: "visible", timeout: 6000 });
        await page.fill(usernameInput, username);

        const nextButton = 'button[data-target-id="login--form--login-proceed-cta"]';
        await page.waitForSelector(nextButton, { state: "visible", timeout: 6000 });
        await page.click(nextButton);

        const passwordInput = '#login-form\\.password';
        await page.waitForSelector(passwordInput, { state: "visible", timeout: 6000 });
        await page.fill(passwordInput, password);

        const loginButton = 'button[data-target-id="login--form--login-cta"]';
        await page.waitForSelector(loginButton, { state: "visible", timeout: 6000 });
        await page.click(loginButton);

        const verificationSelectors = [
            'input[id="login-otp-validation-form-config.verificationCode"]',
        ];

        try {
            await Promise.race([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 2000 }),
            ]);
        } catch (_) { /* navigation timeout - continue to check for verification input */ }

        let foundVerification = false;
        for (const sel of verificationSelectors) {
            try {
                await page.waitForSelector(sel, { state: 'visible', timeout: 2000 });
                foundVerification = true;
                break;
            } catch (_) {
                await closeSession({ browser: b, context, page, launchedPid });
            }
        }

        const storageState = await context.storageState();
        if (foundVerification) {
            const identifier = randomBytes(4).toString('hex');
            sessionStore.set(identifier, { browser: b, context, page, storageState, verified: false, otp_required: true, launchedPid });
            return {
                identifier,
                storageState,
                response: 'need_otp'
            };
        } else {
            await context.close().catch(() => {});
            return { identifier: null, storageState: undefined, response: 'fail' };
        }
    } catch (e) {
        console.error('requestOtp error:', e);
        try { await closeSession({ browser: b, context, page, launchedPid }); } catch (_) {}
        return { identifier: null, storageState: undefined, response: 'fail' };
    }
}

export async function verifyOtp(otp: string, storageState: any): Promise<{ response: string } > {
    // try to reuse an existing stored context/page first
    let stored: any = undefined;
    let sessionKey: string | null = null;
    // If caller passed an identifier string, use it directly
    if (typeof storageState === 'string') {
        sessionKey = storageState;
        stored = sessionStore.get(storageState);
    } else if (storageState && typeof storageState === 'object') {
        // If caller passed a storageState object, find the session whose stored.storageState === that object
        for (const [key, val] of sessionStore.entries()) {
            if ((val as any).storageState === storageState) { stored = val; sessionKey = key; break; }
        }
    }
    
    if (!stored || !stored.otp_required) {
        return { response: 'request_otp first' };
    }

    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let createdLocal = false;

    if (stored) {
        context = stored.context;
        page = stored.page;
    }
    
    try {
        // try a few selector variants for the verification input
        const verificationSelectors = [
            'input[id="login-otp-validation-form-config.verificationCode"]'
        ];
        let filled = false;
        for (const sel of verificationSelectors) {
            try {
                await page.waitForSelector(sel, { state: 'visible', timeout: 3000 });
                await page.fill(sel, otp);
                filled = true;
                break;
            } catch (_) {
                // try next selector
            }
        }
        if (!filled) {
            console.warn('verifyOtp: verification input not found');
            // try { if (sessionKey) await closeSession(sessionKey); else await closeSession(stored); } catch (_) {}
            // try { if (sessionKey) sessionStore.delete(sessionKey); } catch (_) {}
            return { response: 'verification_input_not_found' };
        }
        const verifyButton = 'button[data-target-id="login-otp-validation-form--continue-button"]';
        await page.waitForSelector(verifyButton, { state: 'visible', timeout: 3000 });
        await page.click(verifyButton);
        // Wait for successful navigation to the portal home
        // Wait longer for navigation or check page for success indicators
        try {
            const feedbackButton = 'button:has-text("No Thanks")';
            await page.waitForSelector(feedbackButton, { state: 'visible', timeout: 3000 });
            await page.click(feedbackButton).catch(() => {});
        } catch (_) {}

        const trustDeviceButton = `button:has-text("Don't trust")`;
            try {
                    await page.waitForSelector(trustDeviceButton, { state: "visible", timeout: 3000 });
                    await page.click(trustDeviceButton);
                } catch (error) {
                    console.log("Trust device button not found");
                    return { response: 'fail' };
                }
        // const replaceButton = 'button:has-text("Replace")';
        //     try {
        //             await page.waitForSelector(replaceButton, { state: "visible", timeout: 3000 });
        //             await page.click(replaceButton);
        //         } catch (error) {
        //             console.log("Replace button not found");
        //         }
                
            await page.waitForURL("https://portal.australiansuper.com/", { timeout: 6000 });
        // mark stored session as verified when verification succeeds
        if (stored) {
            try { (stored as any).verified = true; } catch (_) {}
        }
        return { response: 'success' };
    } finally {
        // cleanup: if we created a local context for this verify, close it.
        try {
            if (createdLocal && context) await context.close().catch(() => {});
        } catch (_) {}
    }
}

export async function resendOtp(storageIdentifier: any): Promise<{ response: string }> {
    // find stored session by identifier string or storageState object
    let stored: any = undefined;
    let sessionKey: string | null = null;
    if (typeof storageIdentifier === 'string') {
        sessionKey = storageIdentifier;
        stored = sessionStore.get(sessionKey);
    } else if (storageIdentifier && typeof storageIdentifier === 'object') {
        for (const [key, val] of sessionStore.entries()) {
            if ((val as any).storageState === storageIdentifier) { stored = val; sessionKey = key; break; }
        }
    }

    if (!stored || !stored.page) {
        return { response: 'invalid_identifier' };
    }

    const page: Page = stored.page;
    try {
        const resendSelector = 'button[data-target-id="login-otp-validation-form--resend-code-button"]';
        await page.waitForSelector(resendSelector, { state: 'visible', timeout: 3000 });
        await page.click(resendSelector);
        return { response: 'sent' };
    } catch (err) {
        console.warn('resendOtp error:', err);
        return { response: 'fail' };
    }
}

export async function queryWithSession(storageIdentifier: any): Promise<{ id: string; name: string; balance: number; currency: string } | null> {
    // try to reuse existing stored context/page first
    let stored: any = undefined;
    let sessionKey: string | null = null;
    if (typeof storageIdentifier === 'string') {
        sessionKey = storageIdentifier;
        stored = sessionStore.get(sessionKey);
    } else if (storageIdentifier && typeof storageIdentifier === 'object') {
        for (const [key, val] of sessionStore.entries()) {
            if ((val as any).storageState === storageIdentifier) { stored = val; sessionKey = key; break; }
        }
    }
    // If there's no stored session for the given identifier, bail out early.
    if (!stored) {
        console.warn('queryWithSession: no stored session found for identifier');
        return null;
    }
    // If there's a stored session but it hasn't been verified, don't proceed
    if (stored && stored.verified !== true) {
        console.warn('queryWithSession: session not verified; call verifyOtp and ensure response is "success" before querying');
        return null;
    }
    let context: BrowserContext | undefined;
    let page: Page | undefined;

    if (stored) {
        context = stored.context;
        page = stored.page;
    }

    let success = false;
    try {
        await page.goto("https://portal.australiansuper.com/");

        await page.waitForSelector('h1', { timeout: 6000 })
        let name = "";
        try {
            const h1 = page.locator("h1").first();
            if (await h1.count() > 0) {
                const heading = (await h1.textContent())?.replace(/\r?\n/g, " ").trim() || "";
                const m = heading.match(/Welcome\s+(.+)$/i);
                if (m) name = m[1].trim();
            }
       } catch (e) { console.error(e); }

       await page.waitForSelector('p:has-text("Member number") + p', { timeout: 6000 })
        let memberId = "";
        try {
            const memberIdLocator = page.locator('p:has-text("Member number") + p').first();
            if (await memberIdLocator.count() > 0) {
                memberId = (await memberIdLocator.textContent())?.trim() || "";
            } 
        } catch (e) { console.error(e); }

        const transactionsButton = 'button:has-text("Transactions")';
        await page.waitForSelector(transactionsButton, { state: "visible", timeout: 6000 });
        await page.click(transactionsButton);

        const contributionsDropdownLink = 'div[aria-hidden="false"] a:has-text("Contributions")';
        await page.waitForSelector(contributionsDropdownLink, { state: "visible", timeout: 6000 });
        await page.click(contributionsDropdownLink);

        const viewtransactionsLink = 'a:has-text("View all contributions")';
        await page.waitForSelector(viewtransactionsLink, { state: "visible", timeout: 6000 });
        await page.click(viewtransactionsLink);

        // await page.waitForURL("https://portal.australiansuper.com/transactions/transaction-history", { timeout: 6000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 })

        const balanceElements = await page.locator('p[class*="SummaryBalance"]');
        const balanceText = (await balanceElements.first().textContent())?.replace("$", "").trim() || "";
        const balance = parseFloat(balanceText.replace(/,/g, ""));

        const result = { 
            id: memberId,
            name: name,
            balance: balance,
            currency: "AUD"
        };
        success = true;
        return result;
    } catch (err) {
        console.error('queryWithSession failed:', err);
        return null;
    } finally {
        try {
            await closeSession(sessionKey ?? stored);
        } catch (_) {}
    }
}


