// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";

import { Endpoint } from "../shared";

export function getLeetCodeEndpoint(): string {
    const leetCodeConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
    return leetCodeConfig.get<string>("endpoint", Endpoint.LeetCode);
}
