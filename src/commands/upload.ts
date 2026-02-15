
import * as vscode from "vscode";
import { explorerNodeManager } from "../explorer/explorerNodeManager";
import { IProblem, ProblemState } from "../shared";
import * as fse from "fs-extra";

export async function uploadProblems(): Promise<void> {
    const fileUris: vscode.Uri[] | undefined = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Upload Problem List",
        filters: {
            "Text Files": ["txt", "tsv", "csv"],
            "All Files": ["*"],
        },
    });

    if (!fileUris || fileUris.length === 0) {
        return;
    }

    const fileContent: string = fse.readFileSync(fileUris[0].fsPath, "utf8");
    const problems: IProblem[] = parseProblems(fileContent);

    if (problems.length === 0) {
        vscode.window.showErrorMessage("No valid problems found in the file.");
        return;
    }

    explorerNodeManager.updateCustomProblems(problems);
    vscode.window.showInformationMessage(`Successfully loaded ${problems.length} problems.`);
}


function parseProblems(content: string): IProblem[] {
    const problems: IProblem[] = [];
    const lines: string[] = content.split(/\r?\n/).filter(line => line.trim() !== "");

    // Simple header detection
    let headerMap: { [key: string]: number } = {};
    if (lines.length > 0) {
        const potentialHeader = parseCSVLine(lines[0]);
        // Check if it looks like a header
        if (potentialHeader.some(h => ["title", "difficulty", "id", "link", "url"].indexOf(h.toLowerCase()) >= 0)) {
            potentialHeader.forEach((h, i) => {
                headerMap[h.toLowerCase()] = i;
            });
            lines.shift(); // Remove header line
        }
    }

    for (const line of lines) {
        if (!line.trim()) { continue; }

        const parts: string[] = parseCSVLine(line);
        if (parts.length === 0) { continue; }

        let title: string = "";
        let difficulty: string = "Easy"; // Default
        let link: string = "";
        let id: string = "";
        let tags: string[] = [];

        // 1. Try to get values from header mapping if available
        if (Object.keys(headerMap).length > 0) {
            if (headerMap["title"] !== undefined && parts[headerMap["title"]]) title = parts[headerMap["title"]];
            else if (headerMap["name"] !== undefined && parts[headerMap["name"]]) title = parts[headerMap["name"]];

            if (headerMap["difficulty"] !== undefined && parts[headerMap["difficulty"]]) difficulty = parts[headerMap["difficulty"]];
            if (headerMap["link"] !== undefined && parts[headerMap["link"]]) link = parts[headerMap["link"]];
            else if (headerMap["url"] !== undefined && parts[headerMap["url"]]) link = parts[headerMap["url"]];

            if (headerMap["id"] !== undefined && parts[headerMap["id"]]) id = parts[headerMap["id"]];
        }

        // 2. Heuristics fallback (if header didn't catch everything or didn't exist)

        // Find Difficulty (Easy/Medium/Hard) if not already found or default
        if (difficulty === "Easy" && headerMap["difficulty"] === undefined) {
            const diffMatch = parts.find(p => ["easy", "medium", "hard"].indexOf(p.toLowerCase()) >= 0);
            if (diffMatch) {
                difficulty = diffMatch;
            }
        }
        // Normalize difficulty case
        difficulty = difficulty.charAt(0).toUpperCase() + difficulty.slice(1).toLowerCase();
        if (["Easy", "Medium", "Hard"].indexOf(difficulty) < 0) {
            difficulty = "Easy";
        }

        // Find Link if not found
        if (!link) {
            const linkMatch = parts.find(p => p.toLowerCase().startsWith("http"));
            if (linkMatch) {
                link = linkMatch;
            }
        }

        // Find Title if not found
        if (!title) {
            // Heuristic: longest string that isn't the link or difficulty or a number? 
            // Or just the first non-empty, non-difficulty, non-link column?
            for (const part of parts) {
                if (part === link || part.toLowerCase() === difficulty.toLowerCase()) continue;
                // crude check: ignore numbers, ignore short strings if we have better candidates
                if (!/^\d+$/.test(part) && !part.match(/^\d+(\.\d+)?%?$/)) {
                    title = part;
                    break;
                }
            }
        }

        // Extract ID/Slug from link
        let slug: string = "";
        if (link) {
            const match: RegExpMatchArray | null = link.match(/problems\/([^\/]+)/);
            if (match) {
                slug = match[1];
            }
        }
        // Fallback ID from title
        if (!slug && title) {
            slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        }

        // Final ID assignment
        if (id) {
            // Use provided ID if it's valid-ish?
        } else {
            id = slug;
        }

        if (id && title) {
            problems.push({
                id: id,
                name: title,
                difficulty: difficulty,
                passRate: "Unknown",
                companies: [],
                tags: tags,
                isFavorite: false,
                locked: false,
                state: ProblemState.Unknown,
            });
        }
    }

    return problems;
}

function parseCSVLine(text: string): string[] {
    const results: string[] = [];
    let curr = "";
    let inQuote = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            if (inQuote && text[i + 1] === '"') { // Escaped quote
                curr += '"';
                i++;
            } else {
                inQuote = !inQuote;
            }
        } else if (char === ',' && !inQuote) {
            results.push(curr.trim());
            curr = "";
        } else {
            curr += char;
        }
    }
    results.push(curr.trim());
    return results;
}
