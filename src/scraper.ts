import { chromium, Page, BrowserContext } from "playwright";
import * as readline from "readline";
import fs from "fs";
import path from "path";

const SESSION_FILE = path.join(__dirname, "session.json");

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

async function login(page: Page): Promise<void> {
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
            const username = await ask("Enter your username: ");
            await page.fill(usernameInput, username);   

            const nextButton = 'button[data-target-id="login--form--login-proceed-cta"]';
            await page.waitForSelector(nextButton, { state: "visible", timeout: 6000 });
            await page.click(nextButton);
            
            const passwordInput = '#login-form\\.password';
            await page.waitForSelector(passwordInput, { state: "visible", timeout: 6000 });
            const password = await ask("Enter your password: ");
            await page.fill(passwordInput, password);
            
            const loginButton = 'button[data-target-id="login--form--login-cta"]';
            await page.waitForSelector(loginButton, { state: "visible", timeout: 6000 });
            await page.click(loginButton);
            
            let verificationPageFound = false;
            try {
                await page.locator('text=Verify your login').first().waitFor({ timeout: 35000 });
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

async function getTransactions(page: Page): Promise<{ balances: string[] }> {
    await page.goto("https://portal.australiansuper.com/");        
        
    const transactionsButton = 'button:has-text("Transactions")';
    await page.waitForSelector(transactionsButton, { state: "visible", timeout: 10000 });
    await page.click(transactionsButton);
            
    const contributionsLink = 'a:has-text("Contributions")';
    await page.waitForSelector(contributionsLink, { state: "visible", timeout: 6000 });
    await page.click(contributionsLink);

    const viewtransactionsLink = 'a:has-text("View all contributions")';
    await page.waitForSelector(viewtransactionsLink, { state: "visible", timeout: 6000 });
    await page.click(viewtransactionsLink);
    
    await page.waitForURL("https://portal.australiansuper.com/transactions/transaction-history", { timeout: 6000 });
    
    const balances: string[] = [];
    const balanceElements = await page.locator('p[class*="SummaryBalance"]');
    const balanceText = (await balanceElements.first().innerText()).replace("$", "").trim();
    balances.push(balanceText);
    
    const result = {
        balances: balances
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
}

async function saveSession(browser: any): Promise<{ context: BrowserContext; reused: boolean }> {
    let context: BrowserContext;
    let reused = false;

    if (fs.existsSync(SESSION_FILE)) {
        context = await browser.newContext({
        storageState: SESSION_FILE,
        });
        reused = true;
    } else {
        context = await browser.newContext();
    }

    const page = await context.newPage();
    try {
        await page.goto("https://portal.australiansuper.com/");
        await page.waitForSelector('button:has-text("Transactions")',{ timeout: 6000 });
        // console.log("Session is valid");
        return { context, reused};
    } catch (error) {
        // console.log("Session is invalid, need to log in again.");
    }

    try {
        await login(page);
        await context.storageState({ path: SESSION_FILE });
        return { context, reused: false };
    } catch (error) {
        console.log("Error closing page:", error);
        throw error;
    }
}

async function main(){
    const browser = await chromium.launch({ headless: false });
    const { context } = await saveSession(browser);
    const page = await context.newPage();
    await getTransactions(page);
    // await browser.close();
}

main();