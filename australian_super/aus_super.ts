import { chromium, Page, BrowserContext, Browser } from "playwright";

// --- Shared browser/session management ---
let browserInstance: Browser | null = null;
const sessionStore = new Map<string, { context: BrowserContext; page: Page; storageState?: any; verified?: boolean; otp_required?: boolean }>();

async function ensureBrowser(headless = false): Promise<Browser> {
    if (!browserInstance) {
        browserInstance = await chromium.launch({ headless });
        // attempt graceful shutdown on process exit
        process.on('exit', async () => {
            try {
                await browserInstance?.close();
            } catch (_) {}
        });
    }
    return browserInstance;
}

export async function requestOtp(username: string, password: string, headless = false): Promise<{ identifier: string | null; storageState?: any; response?: string }> {
    const browser = await ensureBrowser(headless);
    const context = await browser.newContext();
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
            'input[id*="verificationCode"]',
            'input[name*="verificationCode"]',
            'input[type="tel"]',
            'input[type="text"]'
        ];

        try {
            await Promise.race([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }),
                page.waitForTimeout(8000)
            ]);
        } catch (_) {}

        let foundVerification = false;
        for (const sel of verificationSelectors) {
            try {
                await page.waitForSelector(sel, { state: 'visible', timeout: 4000 });
                foundVerification = true;
                break;
            } catch (_) {
                // try next selector
            }
        }

        const storageState = await context.storageState();
        if (foundVerification) {
            const identifier = Math.random().toString(36).slice(2);
            sessionStore.set(identifier, { context, page, storageState, verified: false, otp_required: true });
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
                return { identifier: null, storageState: undefined, response: 'fail' };
    }
}

export async function verifyOtp(otp: string, storageState: any): Promise<{ response: string } > {
    // try to reuse an existing stored context/page first
    let stored: any = undefined;
    // If caller passed an identifier string, use it directly
    if (typeof storageState === 'string') {
        stored = sessionStore.get(storageState);
    } else if (storageState && typeof storageState === 'object') {
        // If caller passed a storageState object, find the session whose stored.storageState === that object
        for (const [, val] of sessionStore.entries()) {
            if ((val as any).storageState === storageState) { stored = val; break; }
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
                await page.waitForSelector(sel, { state: 'visible', timeout: 4000 });
                console.log(`verifyOtp: filling OTP using selector: ${sel}`);
                await page.fill(sel, otp);
                filled = true;
                break;
            } catch (_) {
                // try next selector
            }
        }
        if (!filled) {
            console.warn('verifyOtp: verification input not found');
            return { response: 'verification_input_not_found' };
        }
        const verifyButton = 'button[data-target-id="login-otp-validation-form--continue-button"]';
        await page.waitForSelector(verifyButton, { state: 'visible', timeout: 6000 });
        await page.click(verifyButton);
        // Wait for successful navigation to the portal home
        // Wait longer for navigation or check page for success indicators
        try {
            const feedbackButton = 'button:has-text("No Thanks")';
            await page.waitForSelector(feedbackButton, { state: 'visible', timeout: 3000 });
            await page.click(feedbackButton).catch(() => {});
        } catch (_) {}

        const trustDeviceButton = 'button:has-text("Trust device")';
            try {
                    await page.waitForSelector(trustDeviceButton, { state: "visible", timeout: 3000 });
                    await page.click(trustDeviceButton);
                } catch (error) {
                    console.log("Trust device button not found");
                    return { response: 'fail' };
                }
        const replaceButton = 'button:has-text("Replace")';
            try {
                    await page.waitForSelector(replaceButton, { state: "visible", timeout: 3000 });
                    await page.click(replaceButton);
                } catch (error) {
                    console.log("Replace button not found");
                    return { response: 'fail' };
                }
                
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

    try {
        await page.goto("https://portal.australiansuper.com/");
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 })

        let name = "";
        try {
            const h1 = page.locator("h1").first();
            if (await h1.count() > 0) {
                const heading = (await h1.textContent())?.replace(/\r?\n/g, " ").trim() || "";
                const m = heading.match(/Welcome\s+(.+)$/i);
                if (m) name = m[1].trim();
            }
       } catch (e) {}

        let memberId = "";
        try {
            const memberIdLocator = page.locator('p:has-text("Member number") + p').first();
            if (await memberIdLocator.count() > 0) {
                memberId = (await memberIdLocator.textContent())?.trim() || "";
            } 
        } catch (e) {}

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
        return result;
    } catch (err) {
        console.error('queryWithSession failed:', err);
        return null;
    } finally {
        // Ensure the session is cleared and browser/context closed after one query
        try {
            if (context) await context.close().catch(() => {});
        } catch (_) {}
        try {
            if (sessionKey) sessionStore.delete(sessionKey);
        } catch (_) {}
        try {
            if (browserInstance) {
                await browserInstance.close().catch(() => {});
                browserInstance = null;
            }
        } catch (_) {}
    }
}
