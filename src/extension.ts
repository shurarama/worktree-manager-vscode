import * as vscode from "vscode";
import { dispose as disposeLogger } from "./logger";
import { WorktreeManager } from "./worktreeManager";
import { WorktreeItem, RunningCommandItem, WorktreeProvider } from "./worktreeProvider";

interface RunPickItem extends vscode.QuickPickItem {
  kind2: "command" | "terminal" | "custom";
  index: number;
}

export function activate(context: vscode.ExtensionContext) {
  const manager = new WorktreeManager();
  const provider = new WorktreeProvider(manager);

  const treeView = vscode.window.createTreeView("dsWorktrees", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push({ dispose: () => { manager.dispose(); disposeLogger(); } });

  // Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand("ds-worktree.refresh", () => provider.refresh())
  );

  // Create worktree
  context.subscriptions.push(
    vscode.commands.registerCommand("ds-worktree.create", async () => {
      try {
        const n = await manager.nextAvailableNumber();

        const branchType = await vscode.window.showQuickPick(
          [
            { label: "New branch", description: "Create a new branch from current HEAD", value: "new" },
            { label: "Existing branch", description: "Checkout an existing local branch", value: "existing" },
            { label: "Remote branch", description: "Checkout a remote branch", value: "remote" },
          ],
          { placeHolder: `Create worktree wt${n}` }
        );
        if (!branchType) { return; }

        let branch: string | undefined;
        let createBranch = false;

        if (branchType.value === "new") {
          branch = await vscode.window.showInputBox({ prompt: "New branch name" });
          createBranch = true;
        } else if (branchType.value === "existing") {
          branch = await vscode.window.showQuickPick(await manager.listBranches(), { placeHolder: "Select branch" });
        } else {
          branch = await vscode.window.showQuickPick(await manager.listRemoteBranches(), { placeHolder: "Select remote branch" });
        }

        if (!branch) { return; }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Creating worktree wt${n}...` },
          async () => { await manager.createWorktree(n, branch, createBranch); }
        );

        provider.refresh();
        vscode.window.showInformationMessage(`Worktree wt${n} created on branch ${branch}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to create worktree: ${err.message}`);
      }
    })
  );

  // Remove worktree
  context.subscriptions.push(
    vscode.commands.registerCommand("ds-worktree.remove", async (item?: WorktreeItem) => {
      if (!item) { return; }
      const wt = item.worktree;
      const confirm = await vscode.window.showWarningMessage(
        `Remove worktree wt${wt.number} (${wt.branch})? This will delete ${wt.srcPath}.`,
        { modal: true }, "Remove"
      );
      if (confirm !== "Remove") { return; }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Removing wt${wt.number}...` },
          async () => { await manager.removeWorktree(wt.number); }
        );
        provider.refresh();
        vscode.window.showInformationMessage(`Worktree wt${wt.number} removed`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to remove worktree: ${err.message}`);
      }
    })
  );

  // Open worktree in new VS Code window with env
  context.subscriptions.push(
    vscode.commands.registerCommand("ds-worktree.openFolder", async (item?: WorktreeItem) => {
      if (!item) { return; }
      const wt = item.worktree;
      const vars = manager.getVars(wt);
      const env = manager.presets.expandEnv(undefined, vars); // global env only

      // Build env prefix for the command
      const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ");
      const command = envPrefix ? `${envPrefix} code --new-window ${wt.srcPath}` : `code --new-window ${wt.srcPath}`;

      manager.runInOutput(wt.number, "VS Code", command, wt.srcPath);
    })
  );

  // Edit config
  context.subscriptions.push(
    vscode.commands.registerCommand("ds-worktree.editPresets", async () => {
      const doc = await vscode.workspace.openTextDocument(manager.presets.getFilePath());
      await vscode.window.showTextDocument(doc);
    })
  );

  // Run command (output mode)
  context.subscriptions.push(
    vscode.commands.registerCommand("ds-worktree.runCommand", async (item?: WorktreeItem) => {
      if (!item) { return; }
      const wt = item.worktree;
      const commands = manager.presets.getCommands();
      const terminals = manager.presets.getTerminals();
      const vars = manager.getVars(wt);

      const items: RunPickItem[] = [];

      commands.forEach((c, i) => {
        if (!c.hidden) { items.push({ label: c.label, description: c.command, kind2: "command", index: i }); }
      });
      terminals.forEach((t, i) => {
        if (!t.hidden) { items.push({ label: t.label, description: t.command, kind2: "terminal", index: i }); }
      });
      items.push({
        label: "$(terminal) Custom command...", description: "Enter a custom command",
        kind2: "custom", index: -1,
      });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Run in wt${wt.number} (${wt.srcPath})`,
      });
      if (!picked) { return; }

      if (picked.kind2 === "custom") {
        const input = await vscode.window.showInputBox({ prompt: `Command to run in ${wt.srcPath}` });
        if (!input) { return; }
        const mode = await vscode.window.showQuickPick(
          [
            { label: "Output", description: "Read-only log" },
            { label: "Terminal", description: "Interactive" },
          ],
          { placeHolder: "Run mode" }
        );
        if (!mode) { return; }
        const command = manager.presets.expand(input, vars);
        if (mode.label === "Terminal") {
          manager.runInTerminal(wt.number, input, command, wt.srcPath);
        } else {
          manager.runInOutput(wt.number, input, command, wt.srcPath);
        }
        return;
      }

      if (picked.kind2 === "command") {
        const cmd = commands[picked.index];
        await manager.runDependencies(wt, cmd.depends, () => {
          const command = manager.presets.expand(cmd.command, vars);
          const cwd = cmd.cwd ? manager.presets.expand(cmd.cwd, vars) : wt.srcPath;
          const env = manager.presets.expandEnv(cmd.env, vars);
          manager.runInOutput(wt.number, cmd.label, command, cwd, env);
        });
        return;
      }

      if (picked.kind2 === "terminal") {
        const term = terminals[picked.index];
        await manager.runDependencies(wt, term.depends, () => {
          const command = manager.presets.expand(term.command, vars);
          const cwd = term.cwd ? manager.presets.expand(term.cwd, vars) : wt.srcPath;
          const env = manager.presets.expandEnv(term.env, vars);
          manager.runInTerminal(wt.number, term.label, command, cwd, env);
        });
      }
    })
  );

  // View running command
  context.subscriptions.push(
    vscode.commands.registerCommand("ds-worktree.viewCommand", (item?: RunningCommandItem) => {
      if (!item) { return; }
      manager.viewCommand(item.running.id);
    })
  );

  // Stop output command
  context.subscriptions.push(
    vscode.commands.registerCommand("ds-worktree.stopCommand", (item?: RunningCommandItem) => {
      if (!item) { return; }
      manager.stopCommand(item.running.id);
    })
  );

  // Close terminal
  context.subscriptions.push(
    vscode.commands.registerCommand("ds-worktree.closeCommand", (item?: RunningCommandItem) => {
      if (!item) { return; }
      manager.closeCommand(item.running.id);
    })
  );
}

export function deactivate() {}
