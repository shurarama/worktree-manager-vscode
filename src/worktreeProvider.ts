import * as vscode from "vscode";
import { WorktreeInfo, WorktreeManager, RunningCommand } from "./worktreeManager";

/** Tree item representing a worktree */
export class WorktreeItem extends vscode.TreeItem {
  constructor(public readonly worktree: WorktreeInfo, hasRunning: boolean) {
    const label = `wt${worktree.number}`;
    super(label, hasRunning
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None);

    // Unique id that changes with running state so VS Code resets collapsible state
    this.id = `wt${worktree.number}-${hasRunning ? "r" : "e"}`;

    const role = worktree.isPrimary ? "primary" : "secondary";
    this.contextValue = `worktree.${role}`;

    this.description = worktree.branch;

    this.iconPath = worktree.isPrimary
      ? new vscode.ThemeIcon("star-full")
      : new vscode.ThemeIcon("git-branch");

    this.tooltip = [
      `Path: ${worktree.srcPath}`,
      `Branch: ${worktree.branch}`,
    ].join("\n");
  }
}

/** Tree item representing a running command */
export class RunningCommandItem extends vscode.TreeItem {
  public readonly running: RunningCommand;

  constructor(cmd: RunningCommand) {
    super(cmd.label, vscode.TreeItemCollapsibleState.None);
    this.running = cmd;

    this.contextValue = cmd.mode === "command" ? "running.output" : "running.terminal";
    this.description = cmd.mode;

    this.iconPath = new vscode.ThemeIcon(
      "circle-filled",
      new vscode.ThemeColor("testing.runAction")
    );

    // Click to focus output/terminal
    this.command = {
      command: "ds-worktree.viewCommand",
      title: "View",
      arguments: [this],
    };
  }
}

type TreeElement = WorktreeItem | RunningCommandItem;

export class WorktreeProvider implements vscode.TreeDataProvider<TreeElement> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: WorktreeManager) {
    // Refresh tree when running commands change
    manager.onRunningChanged(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeElement): Promise<TreeElement[]> {
    // Root level: worktrees
    if (!element) {
      try {
        const worktrees = await this.manager.listWorktrees();
        return worktrees.map((w) => {
          const hasRunning = this.manager.getRunningForWorktree(w.number).length > 0;
          return new WorktreeItem(w, hasRunning);
        });
      } catch {
        return [];
      }
    }

    // Children of a worktree: running commands
    if (element instanceof WorktreeItem) {
      const running = this.manager.getRunningForWorktree(element.worktree.number);
      return running.map((cmd) => new RunningCommandItem(cmd));
    }

    return [];
  }

  getParent(element: TreeElement): TreeElement | undefined {
    // Required for reveal() but we don't need it
    return undefined;
  }
}
