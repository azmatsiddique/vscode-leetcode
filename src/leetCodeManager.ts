// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as cp from "child_process";
import { EventEmitter } from "events";
import * as vscode from "vscode";
import { leetCodeChannel } from "./leetCodeChannel";
import { leetCodeExecutor } from "./leetCodeExecutor";
import { IQuickItemEx, loginArgsMapping, UserStatus } from "./shared";
import { createEnvOption } from "./utils/cpUtils";
import { DialogType, promptForOpenOutputChannel } from "./utils/uiUtils";
import * as wsl from "./utils/wslUtils";

class LeetCodeManager extends EventEmitter {
    private currentUser: string | undefined;
    private userStatus: UserStatus;
    private readonly successRegex: RegExp = /(?:.*)(?:Successfully .*login as (.*)|login\s+success)/i;
    private readonly failRegex: RegExp = /.*\[ERROR\].*/i;

    constructor() {
        super();
        this.currentUser = undefined;
        this.userStatus = UserStatus.SignedOut;
    }

    public async getLoginStatus(): Promise<void> {
        try {
            const result: string = await leetCodeExecutor.getUserInfo();
            leetCodeChannel.append(`[DEBUG] getUserInfo output:\n${result}\n`);
            this.currentUser = this.tryParseUserName(result);
            if (this.currentUser && this.currentUser !== "Unknown") {
                this.userStatus = UserStatus.SignedIn;
                leetCodeChannel.append(`[DEBUG] Login verified. Username: ${this.currentUser}\n`);
            } else {
                this.userStatus = UserStatus.SignedOut;
                leetCodeChannel.append(`[DEBUG] Failed to parse username from output\n`);
            }
        } catch (error) {
            this.currentUser = undefined;
            this.userStatus = UserStatus.SignedOut;
            leetCodeChannel.append(`[DEBUG] getUserInfo error: ${error}\n`);
        } finally {
            this.emit("statusChanged");
        }
    }

    public async signIn(): Promise<void> {
        const picks: Array<IQuickItemEx<string>> = [];
        picks.push(
            {
                label: "LeetCode",
                detail: "Use LeetCode account to login",
                value: "LeetCode",
            },
            {
                label: "Cookie",
                detail: "Use LeetCode cookie to login",
                value: "Cookie",
            },
            {
                label: "Login via Browser",
                detail: "Open LeetCode login page and use cookie to login",
                value: "CookieWithBrowser",
            },
        );
        const choice: IQuickItemEx<string> | undefined = await vscode.window.showQuickPick(picks);
        if (!choice) {
            return;
        }
        const loginMethod: string = choice.value;

        const isByCookie: boolean = loginMethod === "Cookie" || loginMethod === "CookieWithBrowser";
        let precomputedCookie: string | undefined;

        if (loginMethod === "CookieWithBrowser") {
            try {
                const puppeteer = require("puppeteer-core");
                const chromeLauncher = require("chrome-launcher");

                const chromePath = await chromeLauncher.Launcher.getFirstInstallation();
                if (!chromePath) {
                    throw new Error("Chrome installation not found.");
                }

                const browser = await puppeteer.launch({
                    executablePath: chromePath,
                    headless: false,
                    defaultViewport: null,
                    args: ["--start-maximized"],
                });

                const page = (await browser.pages())[0];
                const url: string = "https://leetcode.com/accounts/login/";
                await page.goto(url);

                vscode.window.showInformationMessage("Opening Chrome... Please sign in. The browser will close automatically when successful.");

                precomputedCookie = await new Promise<string | undefined>((resolve) => {
                    let found = false;
                    const interval = setInterval(async () => {
                        try {
                            if (!browser.isConnected()) {
                                clearInterval(interval);
                                if (!found) resolve(undefined);
                                return;
                            }

                            const cookies = await page.cookies();
                            const session = cookies.find((c: any) => c.name === "LEETCODE_SESSION");
                            const csrf = cookies.find((c: any) => c.name === "csrftoken");

                            if (session && csrf) {
                                found = true;
                                clearInterval(interval);
                                const cookieValue = `LEETCODE_SESSION=${session.value};csrftoken=${csrf.value};`;
                                leetCodeChannel.append(`[DEBUG] Cookies extracted successfully. Session value: ${session.value.substring(0, 20)}...\n`);
                                // Give it a moment before closing to ensure everything is captured
                                setTimeout(async () => {
                                    try {
                                        await browser.close();
                                    } catch (e) {
                                        leetCodeChannel.append(`[DEBUG] Browser close error: ${e}\n`);
                                    }
                                    resolve(cookieValue);
                                }, 1000);
                            }
                        } catch (err) {
                            leetCodeChannel.append(`[DEBUG] Cookie check error: ${err}\n`);
                        }
                    }, 1000);

                    browser.on("disconnected", () => {
                        clearInterval(interval);
                        if (!found) {
                            leetCodeChannel.append(`[DEBUG] Browser disconnected without finding cookies\n`);
                            resolve(undefined);
                        }
                    });
                });
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to launch browser for login: ${error.message}. Please ensure Chrome is installed.`);
                return;
            }

            if (precomputedCookie) {
                const sessionMatch = precomputedCookie.match(/LEETCODE_SESSION=(.+?);/);
                const csrfMatch = precomputedCookie.match(/csrftoken=(.+?);/);
                if (sessionMatch && csrfMatch) {
                    await leetCodeExecutor.saveUser({
                        sessionId: sessionMatch[1],
                        sessionCSRF: csrfMatch[1],
                        name: "browser-login",
                        paid: false,
                    });
                    leetCodeChannel.append("[DEBUG] Browser login: Session cache updated manually\n");
                    await this.getLoginStatus();
                    if (this.userStatus === UserStatus.SignedIn) {
                        vscode.window.showInformationMessage("Successfully signed in via browser.");
                        return;
                    }
                }
            }
        }

        const commandArg: string | undefined = loginArgsMapping.get(loginMethod) || loginArgsMapping.get("Cookie");
        if (!commandArg) {
            throw new Error(`The login method "${loginMethod}" is not supported.`);
        }

        const inMessage: string = isByCookie ? "sign in by cookie" : "sign in";
        leetCodeChannel.append(`[DEBUG] Starting login process: method=${loginMethod}, arg=${commandArg}\n`);
        try {
            await new Promise(async (resolve: (res: string | undefined) => void, reject: (e: Error) => void): Promise<void> => {

                const leetCodeBinaryPath: string = await leetCodeExecutor.getLeetCodeBinaryPath();

                const childProc: cp.ChildProcess = wsl.useWsl()
                    ? cp.spawn("wsl", [leetCodeExecutor.node, leetCodeBinaryPath, "user", commandArg], { shell: true })
                    : cp.spawn(leetCodeExecutor.node, [leetCodeBinaryPath, "user", commandArg], {
                        shell: true,
                        env: createEnvOption(),
                    });

                childProc.stdout.on("data", async (data: string | Buffer) => {
                    data = data.toString();
                    // Strip ANSI escape codes
                    const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
                    leetCodeChannel.append(cleanData);
                    if (cleanData.includes("twoFactorCode")) {
                        const twoFactor: string | undefined = await vscode.window.showInputBox({
                            prompt: "Enter two-factor code.",
                            ignoreFocusOut: true,
                            validateInput: (s: string): string | undefined => s && s.trim() ? undefined : "The input must not be empty",
                        });
                        if (!twoFactor) {
                            childProc.kill();
                            return resolve(undefined);
                        }
                        childProc.stdin.write(`${twoFactor}\n`);
                    }
                    const successMatch: RegExpMatchArray | null = cleanData.match(this.successRegex);
                    if (successMatch && successMatch[1]) {
                        childProc.stdin.end();
                        return resolve(successMatch[1]);
                    } else if (cleanData.match(this.failRegex)) {
                        childProc.stdin.end();
                        return reject(new Error("Failed to login"));
                    }
                });

                childProc.stderr.on("data", (data: string | Buffer) => {
                    const cleanData = data.toString().replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
                    leetCodeChannel.append(cleanData);
                });

                childProc.on("error", reject);

                childProc.on("close", (code: number) => {
                    if (code !== 0) {
                        reject(new Error(`Login process exited with code ${code}`));
                    } else {
                        // resolve(undefined) if not already resolved by stdout match
                        resolve(undefined);
                    }
                });

                // For cookie login, we might not strictly need username, but CLI flow might ask.
                // If using 'Login via Browser', we can use a dummy username since the cookie is what matters.
                const name: string | undefined = (loginMethod === "CookieWithBrowser") ? "browser-login" : await vscode.window.showInputBox({
                    prompt: "Enter username or E-mail.",
                    ignoreFocusOut: true,
                    validateInput: (s: string): string | undefined => s && s.trim() ? undefined : "The input must not be empty",
                });
                if (!name) {
                    childProc.kill();
                    leetCodeChannel.append("[DEBUG] Login aborted: username/email input cancelled\n");
                    return resolve(undefined);
                }
                leetCodeChannel.append(`[DEBUG] Sending username: ${name}\n`);
                childProc.stdin.write(`${name}\n`);

                const pwd: string | undefined = precomputedCookie || await vscode.window.showInputBox({
                    prompt: isByCookie ? "Enter cookie" : "Enter password.",
                    password: true,
                    ignoreFocusOut: true,
                    validateInput: (s: string): string | undefined => s ? undefined : isByCookie ? "Cookie must not be empty" : "Password must not be empty",
                });
                if (!pwd) {
                    childProc.kill();
                    leetCodeChannel.append("[DEBUG] Login aborted: password/cookie input cancelled\n");
                    return resolve(undefined);
                }
                leetCodeChannel.append(`[DEBUG] Sending ${isByCookie ? "cookie" : "password"}\n`);
                childProc.stdin.write(`${pwd}\n`);
            });
            // Always verify login status after login attempt
            await this.getLoginStatus();
            if (this.userStatus === UserStatus.SignedIn) {
                vscode.window.showInformationMessage(`Successfully ${inMessage}.`);
            } else {
                vscode.window.showErrorMessage(`Failed to ${inMessage}.`);
            }
        } catch (error) {
            promptForOpenOutputChannel(`Failed to ${inMessage}. Please open the output channel for details`, DialogType.error);
        }

    }

    public async signOut(): Promise<void> {
        try {
            await leetCodeExecutor.signOut();
            vscode.window.showInformationMessage("Successfully signed out.");
            this.currentUser = undefined;
            this.userStatus = UserStatus.SignedOut;
            this.emit("statusChanged");
        } catch (error) {
            // swallow the error when sign out.
        }
    }

    public getStatus(): UserStatus {
        return this.userStatus;
    }

    public getUser(): string | undefined {
        return this.currentUser;
    }

    private tryParseUserName(output: string): string {
        const cleanOutput = output.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");

        // Try primary pattern: "✔ username https://leetcode"
        let reg: RegExp = /^\s*.\s*(.+?)\s*https:\/\/leetcode/m;
        let match: RegExpMatchArray | null = cleanOutput.match(reg);
        if (match && match.length === 2) {
            return match[1].trim();
        }

        // Try alternative patterns for different CLI versions
        // Pattern: "username" on its own line with profile URL or leetcode reference
        reg = /^\s*(.+?)\s*$\n.*leetcode/m;
        match = cleanOutput.match(reg);
        if (match && match.length === 2) {
            const candidate = match[1].trim();
            if (candidate && !candidate.includes("ERROR") && !candidate.includes("error")) {
                return candidate;
            }
        }

        // Pattern: look for lines with user profile info
        const lines = cleanOutput.split("\n");
        for (const line of lines) {
            if ((line.includes("✔") || line.includes("*")) && !line.includes("ERROR") && line.length > 2) {
                const userMatch = line.match(/✔\s+(.+?)(?:\s|$)/);
                if (userMatch && userMatch[1]) {
                    return userMatch[1].trim();
                }
            }
        }

        return "Unknown";
    }

    public async signInAsGuest(): Promise<void> {
        this.currentUser = "Guest";
        this.userStatus = UserStatus.Guest;
        this.emit("statusChanged");
        vscode.window.showInformationMessage("Successfully signed in as Guest.");
    }
}

export const leetCodeManager: LeetCodeManager = new LeetCodeManager();
