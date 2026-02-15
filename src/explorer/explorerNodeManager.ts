// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as _ from "lodash";
import * as vscode from "vscode";
import { Disposable } from "vscode";
import * as list from "../commands/list";
import { Category, defaultProblem, IProblem, ProblemState } from "../shared";
import { shouldHideSolvedProblem } from "../utils/settingUtils";
import { LeetCodeNode } from "./LeetCodeNode";

class ExplorerNodeManager implements Disposable {
    private explorerNodeMap: Map<string, LeetCodeNode> = new Map<string, LeetCodeNode>();
    private companySet: Set<string> = new Set<string>();
    private tagSet: Set<string> = new Set<string>();

    private customProblems: IProblem[] = [];

    private context: vscode.ExtensionContext;

    public initialize(context: vscode.ExtensionContext): void {
        this.context = context;
        this.customProblems = this.context.globalState.get<IProblem[]>("customProblems") || [];

    }

    public updateCustomProblems(problems: IProblem[]): void {
        this.customProblems = problems;
        this.context.globalState.update("customProblems", this.customProblems);
        this.refreshCache();
    }

    public async refreshCache(): Promise<void> {
        this.dispose();
        const shouldHideSolved: boolean = shouldHideSolvedProblem();
        for (const problem of await list.listProblems()) {
            if (shouldHideSolved && problem.state === ProblemState.AC) {
                continue;
            }
            this.explorerNodeMap.set(problem.id, new LeetCodeNode(problem));
            for (const company of problem.companies) {
                this.companySet.add(company);
            }
            for (const tag of problem.tags) {
                this.tagSet.add(tag);
            }
        }
        for (const problem of this.customProblems) {
            this.explorerNodeMap.set(problem.id, new LeetCodeNode(problem));
        }
    }

    public getRootNodes(): LeetCodeNode[] {
        const rootNodes: LeetCodeNode[] = [
            new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: Category.Difficulty,
                name: Category.Difficulty,
            }), false),
        ];

        if (this.customProblems.length > 0) {
            rootNodes.unshift(new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: Category.Custom,
                name: "Custom Problems",
            }), false));
        }

        return rootNodes;
    }

    public getAllNodes(): LeetCodeNode[] {
        return Array.from(this.explorerNodeMap.values());
    }

    public getAllDifficultyNodes(): LeetCodeNode[] {
        const res: LeetCodeNode[] = [];
        res.push(
            new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: `${Category.Difficulty}.Easy`,
                name: "Easy",
            }), false),
            new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: `${Category.Difficulty}.Medium`,
                name: "Medium",
            }), false),
            new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: `${Category.Difficulty}.Hard`,
                name: "Hard",
            }), false),
        );
        this.sortSubCategoryNodes(res, Category.Difficulty);
        return res;
    }

    public getAllCompanyNodes(): LeetCodeNode[] {
        const res: LeetCodeNode[] = [];
        for (const company of this.companySet.values()) {
            res.push(new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: `${Category.Company}.${company}`,
                name: _.startCase(company),
            }), false));
        }
        this.sortSubCategoryNodes(res, Category.Company);
        return res;
    }

    public getAllTagNodes(): LeetCodeNode[] {
        const res: LeetCodeNode[] = [];
        for (const tag of this.tagSet.values()) {
            res.push(new LeetCodeNode(Object.assign({}, defaultProblem, {
                id: `${Category.Tag}.${tag}`,
                name: _.startCase(tag),
            }), false));
        }
        this.sortSubCategoryNodes(res, Category.Tag);
        return res;
    }

    public getNodeById(id: string): LeetCodeNode | undefined {
        return this.explorerNodeMap.get(id);
    }

    public getFavoriteNodes(): LeetCodeNode[] {
        const res: LeetCodeNode[] = [];
        for (const node of this.explorerNodeMap.values()) {
            if (node.isFavorite) {
                res.push(node);
            }
        }
        return res;
    }

    public getChildrenNodesById(id: string): LeetCodeNode[] {
        // The sub-category node's id is named as {Category.SubName}
        const metaInfo: string[] = id.split(".");
        const res: LeetCodeNode[] = [];
        // The sub-category node's id is named as {Category.SubName}
        if (id === Category.Custom) {
            return this.customProblems.map((p: IProblem) => new LeetCodeNode(p));
        }

        switch (metaInfo[0]) {
            case Category.Company:
                for (const node of this.explorerNodeMap.values()) {
                    if (node.companies.indexOf(metaInfo[1]) >= 0) {
                        res.push(node);
                    }
                }
                break;
            case Category.Difficulty:
                for (const problem of this.customProblems) {
                    if (problem.difficulty.toLowerCase() === metaInfo[1].toLowerCase()) {
                        res.push(new LeetCodeNode(problem));
                    }
                }
                break;
            case Category.Tag:
                for (const node of this.explorerNodeMap.values()) {
                    if (node.tags.indexOf(metaInfo[1]) >= 0) {
                        res.push(node);
                    }
                }
                break;
            default:
                break;
        }
        return res;
    }

    public dispose(): void {
        this.explorerNodeMap.clear();
        this.companySet.clear();
        this.tagSet.clear();
    }

    private sortSubCategoryNodes(subCategoryNodes: LeetCodeNode[], category: Category): void {
        switch (category) {
            case Category.Difficulty:
                subCategoryNodes.sort((a: LeetCodeNode, b: LeetCodeNode): number => {
                    function getValue(input: LeetCodeNode): number {
                        switch (input.name.toLowerCase()) {
                            case "easy":
                                return 1;
                            case "medium":
                                return 2;
                            case "hard":
                                return 3;
                            default:
                                return Number.MAX_SAFE_INTEGER;
                        }
                    }
                    return getValue(a) - getValue(b);
                });
                break;
            case Category.Tag:
            case Category.Company:
                subCategoryNodes.sort((a: LeetCodeNode, b: LeetCodeNode): number => {
                    if (a.name === "Unknown") {
                        return 1;
                    } else if (b.name === "Unknown") {
                        return -1;
                    } else {
                        return Number(a.name > b.name) - Number(a.name < b.name);
                    }
                });
                break;
            default:
                break;
        }
    }
}

export const explorerNodeManager: ExplorerNodeManager = new ExplorerNodeManager();
