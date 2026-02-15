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
    private readonly successRegex: RegExp = /(?:.*)Successfully .*login as (.*)/i;
    private readonly failRegex: RegExp = /.*\[ERROR\].*/i;

    constructor() {
        super();
        this.currentUser = undefined;
        this.userStatus = UserStatus.SignedOut;
    }

    public async getLoginStatus(): Promise<void> {
        try {
            const result: string = await leetCodeExecutor.getUserInfo();
            this.currentUser = this.tryParseUserName(result);
            this.userStatus = UserStatus.SignedIn;
        } catch (error) {
            this.currentUser = undefined;
            this.userStatus = UserStatus.SignedOut;
        } finally {
            this.emit("statusChanged");
        }
    }

    public async signIn(): Promise<void> {
        const picks: Array<IQuickItemEx<string>> = [];
        picks.push(
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
        if (loginMethod === "Guest") {
            await this.signInAsGuest();
            return;
        }

        const isByCookie: boolean = loginMethod === "Cookie" || loginMethod === "CookieWithBrowser";
        let precomputedCookie: string | undefined;

        if (loginMethod === "CookieWithBrowser") {
            try {
                const puppeteer = require("puppeteer-core");
                const chromeLauncher = require("chrome-launcher");

                const chromePath = await chromeLauncher.Launcher.getFirstInstallation();
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
                                await browser.close();
                                resolve(`LEETCODE_SESSION=${session.value};csrftoken=${csrf.value};`);
                            }
                        } catch (err) {
                            // Ignore errors during interval (e.g. browser closing)
                        }
                    }, 1000);

                    browser.on("disconnected", () => {
                        clearInterval(interval);
                        if (!found) resolve(undefined);
                    });
                });
            } catch (error) {
                vscode.window.showErrorMessage("Failed to launch browser for login. Please ensure Chrome is installed.");
                return;
            }

            if (!precomputedCookie) {
                vscode.window.showErrorMessage("Login cancelled or failed to retrieve cookies.");
                return;
            }
        }

        const commandArg: string | undefined = loginArgsMapping.get(loginMethod) || loginArgsMapping.get("Cookie");
        if (!commandArg) {
            throw new Error(`The login method "${loginMethod}" is not supported.`);
        }

        const inMessage: string = isByCookie ? "sign in by cookie" : "sign in";
        try {
            const userName: string | undefined = await new Promise(async (resolve: (res: string | undefined) => void, reject: (e: Error) => void): Promise<void> => {

                const leetCodeBinaryPath: string = await leetCodeExecutor.getLeetCodeBinaryPath();

                const childProc: cp.ChildProcess = wsl.useWsl()
                    ? cp.spawn("wsl", [leetCodeExecutor.node, leetCodeBinaryPath, "user", commandArg], { shell: true })
                    : cp.spawn(leetCodeExecutor.node, [leetCodeBinaryPath, "user", commandArg], {
                        shell: true,
                        env: createEnvOption(),
                    });

                childProc.stdout.on("data", async (data: string | Buffer) => {
                    data = data.toString();
                    leetCodeChannel.append(data);
                    if (data.includes("twoFactorCode")) {
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
                    const successMatch: RegExpMatchArray | null = data.match(this.successRegex);
                    if (successMatch && successMatch[1]) {
                        childProc.stdin.end();
                        return resolve(successMatch[1]);
                    } else if (data.match(this.failRegex)) {
                        childProc.stdin.end();
                        return reject(new Error("Faile to login"));
                    }
                });

                childProc.stderr.on("data", (data: string | Buffer) => leetCodeChannel.append(data.toString()));

                childProc.on("error", reject);

                // For cookie login, we might not strictly need username, but CLI flow might ask.
                // If using cookie, we can input any non-empty string as username if prompted.
                // However, existing logic prompts for it. Let's keep existing logic for username.
                const name: string | undefined = await vscode.window.showInputBox({
                    prompt: "Enter username or E-mail.",
                    ignoreFocusOut: true,
                    validateInput: (s: string): string | undefined => s && s.trim() ? undefined : "The input must not be empty",
                });
                if (!name) {
                    childProc.kill();
                    return resolve(undefined);
                }
                childProc.stdin.write(`${name}\n`);

                const pwd: string | undefined = precomputedCookie || await vscode.window.showInputBox({
                    prompt: isByCookie ? "Enter cookie" : "Enter password.",
                    password: true,
                    ignoreFocusOut: true,
                    validateInput: (s: string): string | undefined => s ? undefined : isByCookie ? "Cookie must not be empty" : "Password must not be empty",
                });
                if (!pwd) {
                    childProc.kill();
                    return resolve(undefined);
                }
                childProc.stdin.write(`${pwd}\n`);
            });
            if (userName) {
                vscode.window.showInformationMessage(`Successfully ${inMessage}.`);
                this.currentUser = userName;
                this.userStatus = UserStatus.SignedIn;
                this.emit("statusChanged");
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
        const reg: RegExp = /^\s*.\s*(.+?)\s*https:\/\/leetcode/m;
        const match: RegExpMatchArray | null = output.match(reg);
        if (match && match.length === 2) {
            return match[1].trim();
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
