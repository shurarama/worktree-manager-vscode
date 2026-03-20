import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Worktree Manager");
  }
  return channel;
}

export function log(message: string): void {
  getChannel().appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

export function showLog(): void {
  getChannel().show(true);
}

export function dispose(): void {
  channel?.dispose();
}
