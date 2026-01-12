import { chromium, Page, BrowserContext } from "playwright";
import * as readline from "readline";

function ask(question: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) =>
        rl.question(question, (answer) => {
            rl.close();
            if (answer.trim().toLowerCase() === "q") {
                process.exit(0);
            }
            resolve(answer);
        })
    );
}

async function login(page: Page, id?: string, pin?: string): Promise<void> {
    let loginSuccess = false;
    let retryCount = 0;
    const maxRetries = 4;

    while (!loginSuccess && retryCount < maxRetries) {
        try {
            if (retryCount === 0) {
                await page.goto("https://portal.australiansuper.com/login");
            }
            
            const usernameInput = '#login-form\\.login-fieldset\\.username';
            await page.waitForSelector(usernameInput, { state: "visible", timeout: 6000 });
            const username = id;
            if (!username) throw new Error("Username must be provided as a CLI argument");
            await page.type(usernameInput, username, { delay: 20 });

            const nextButton = 'button[data-target-id="login--form--login-proceed-cta"]';
            await page.waitForSelector(nextButton, { state: "visible", timeout: 6000 });
            await page.click(nextButton);
            
            const passwordInput = '#login-form\\.password';
            await page.waitForSelector(passwordInput, { state: "visible", timeout: 6000 });
            const password = pin;
            if (!password) throw new Error("Password must be provided as a CLI argument");
            await page.type(passwordInput, password, { delay: 20 });
            
            const loginButton = 'button[data-target-id="login--form--login-cta"]';
            await page.waitForSelector(loginButton, { state: "visible", timeout: 6000 });
            await page.click(loginButton);
            
            let verificationPageFound = false;
            try {
                await page.locator('text=Verify your login').first().waitFor({ timeout: 50000 });
                verificationPageFound = true;
                loginSuccess = true;
            } catch (error) {
                await page.waitForTimeout(2000);
                const pageText = await page.textContent('body');
                if (pageText && pageText.includes("Sorry, these details aren't right")) {
                    console.log("Login error: Username or password is incorrect");
                    retryCount++;
                    if (retryCount < maxRetries) {
                        console.log(`Please try again (Attempt ${retryCount + 1}/${maxRetries})`);
                        await page.goto("https://portal.australiansuper.com/login");
                        continue;
                    } else {
                        throw new Error("Max login attempts exceeded");
                    }
                } else {
                    throw new Error("Verification page not found and no error message detected");
                }
            }
            
            try {
                const feedbackButton = 'button:has-text("No Thanks")';
                try {
                    await page.waitForSelector(feedbackButton, { state: "visible", timeout: 5000 });
                    await page.click(feedbackButton);
                } catch (error) {
                    // console.log("No feedback dialog found, continuing...");
                }
                const verificationCodeInput = 'input[id="login-otp-validation-form-config.verificationCode"]';
                await page.waitForSelector(verificationCodeInput, { state: "visible", timeout: 6000 });
                const verificationCode = await ask("Enter your verification code: ");
                await page.fill(verificationCodeInput, verificationCode);
                const verifyButton = 'button[data-target-id="login-otp-validation-form--continue-button"]';
                await page.waitForSelector(verifyButton, { state: "visible", timeout: 6000 });
                await page.click(verifyButton);
                const trustDeviceButton = 'button:has-text("Trust device")';
                try {
                    await page.waitForSelector(trustDeviceButton, { state: "visible", timeout: 6000 });
                    await page.click(trustDeviceButton);
                } catch (error) {
                    console.log("Trust device button not found, skipping...");
                }
                const replaceButton = 'button:has-text("Replace")';
                try {
                    await page.waitForSelector(replaceButton, { state: "visible", timeout: 6000 });
                    await page.click(replaceButton);
                } catch (error) {
                    console.log("Replace button not found, skipping...");
                }
            } catch (error) {
                console.log("Verification step failed:", error);
            }
            
            await page.waitForURL("https://portal.australiansuper.com/", { timeout: 6000 });
            // console.log("Login Successful, current URL:", page.url());
            
        } catch (error) {
            if ((error as Error).message === "Max login attempts exceeded") {
                throw error;
            }
            retryCount++;
            if (retryCount < maxRetries) {
                console.log(`Login attempt failed, retrying... (${retryCount}/${maxRetries})`);
            } else {
                console.error("Login failed after", maxRetries, "attempts");
                throw error;
            }
        }
    }
}

export async function queryResult(id?: string, pin?: string, headless?: boolean): Promise<{ id: string; name: string; balance: number; currency: string } | null> {
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await login(page, id, pin);
        await page.goto("https://portal.australiansuper.com/");

        const profileSelectors = [
        'h2:has-text("Set-up your profile")',
        'h2:has-text("Set up your profile")',
        'text=Set-up your profile',
        'text=Set up your profile'
        ];

        let profileFound = false;
        for (const sel of profileSelectors) {
            try {
                await page.waitForSelector(sel, { state: 'visible', timeout: 3000 });
                profileFound = true;
                break;
            } catch {
            // try next selector
            }
        }
    if (!profileFound) {
    console.warn("Profile heading not found; continuing without it.");
    }

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

        await page.waitForURL("https://portal.australiansuper.com/transactions/transaction-history", { timeout: 6000 });

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
        console.error('queryResult failed:', err);
        return null;
    } finally {
        await browser.close().catch(() => {});
    }
}

async function main() {
    const [, , id, pin, headlessArg] = process.argv;
    try {
        const info = await queryResult(id, pin, headlessArg !== 'false');
        console.log(JSON.stringify(info, null, 2));
    } catch (err) {
        console.error('queryResult failed:', err);
    }
}

if (require.main === module) {
    main();
}