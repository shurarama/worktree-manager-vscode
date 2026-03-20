import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "./logger";
import { PresetManager } from "./presetManager";

export interface WorktreeInfo {
  srcPath: string;
  branch: string;
  isPrimary: boolean;
  number: number;
}

export interface RunningCommand {
  id: string;
  label: string;
  worktreeNumber: number;
  mode: "command" | "terminal";
  process?: cp.ChildProcess;
  terminal?: vscode.Terminal;
  channel?: vscode.OutputChannel;
}

export class WorktreeManager {
  private workspace: string;
  private primaryRepo: string;
  private projectName: string;
  readonly presets: PresetManager;

  private _running = new Map<string, RunningCommand>();
  private _outputChannels = new Map<string, vscode.OutputChannel>();
  private _onChanged = new vscode.EventEmitter<void>();
  readonly onRunningChanged = this._onChanged.event;
  private _terminalDisposable: vscode.Disposable | undefined;

  /** Track successfully completed commands per worktree: Map<"wt2:Build", true> */
  private _completed = new Set<string>();

  constructor() {
    const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

    try {
      const gitCommonDir = cp.execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: workspaceDir, encoding: "utf-8",
      }).trim();
      const absGitDir = path.resolve(workspaceDir, gitCommonDir);
      this.primaryRepo = path.dirname(absGitDir);
    } catch {
      this.primaryRepo = workspaceDir;
    }

    this.workspace = path.dirname(this.primaryRepo);
    this.projectName = path.basename(this.primaryRepo);
    this.presets = new PresetManager(this.primaryRepo);

    log(`Primary repo: ${this.primaryRepo}`);
    log(`Workspace: ${this.workspace}`);
    log(`Project: ${this.projectName}`);

    this._terminalDisposable = vscode.window.onDidCloseTerminal((closed) => {
      for (const [id, cmd] of this._running) {
        if (cmd.terminal === closed) {
          this._running.delete(id);
          this._onChanged.fire();
          break;
        }
      }
    });
  }

  // --- Paths ---

  private srcPath(n: number): string {
    const suffix = n === 1 ? "" : String(n);
    return path.join(this.workspace, `${this.projectName}${suffix}`);
  }

  private worktreeNumber(srcPath: string): number {
    const base = path.basename(srcPath);
    const re = new RegExp(`^${this.escapeRegex(this.projectName)}(\\d+)$`);
    const match = base.match(re);
    if (match) { return parseInt(match[1], 10); }
    if (base === this.projectName) { return 1; }
    return 0;
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  getVars(wt: WorktreeInfo): Record<string, string> {
    const builtins: Record<string, string> = {
      wtPath: wt.srcPath,
      branch: wt.branch,
      number: String(wt.number),
      cpus: String(os.cpus().length),
      SHELL: process.env.SHELL || "/bin/bash",
    };
    return this.presets.getUserVariables(builtins);
  }

  // --- Worktree CRUD ---

  async listWorktrees(): Promise<WorktreeInfo[]> {
    const output = await this.exec("git", ["worktree", "list", "--porcelain"], this.primaryRepo);
    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        current.srcPath = line.substring("worktree ".length);
      } else if (line.startsWith("branch ")) {
        current.branch = line.substring("branch ".length).replace("refs/heads/", "");
      } else if (line === "bare") {
        current.branch = current.branch || "bare";
      } else if (line === "detached") {
        current.branch = "detached HEAD";
      } else if (line === "") {
        if (current.srcPath) {
          const n = this.worktreeNumber(current.srcPath);
          worktrees.push({
            srcPath: current.srcPath,
            branch: current.branch || "unknown",
            isPrimary: n === 1,
            number: n,
          });
        }
        current = {};
      }
    }
    return worktrees.sort((a, b) => a.number - b.number);
  }

  async createWorktree(n: number, branch: string, createBranch: boolean): Promise<void> {
    if (n < 2 || n > 9) { throw new Error("Worktree number must be 2-9"); }

    const src = this.srcPath(n);
    if (fs.existsSync(src)) { throw new Error(`${src} already exists`); }

    const args = ["worktree", "add"];
    if (createBranch) { args.push("-b", branch); }
    args.push(src);
    if (!createBranch) { args.push(branch); }

    await this.exec("git", args, this.primaryRepo);

    const wt: WorktreeInfo = { srcPath: src, branch, isPrimary: false, number: n };
    await this.runOnCreate(wt);
  }

  private async runOnCreate(wt: WorktreeInfo): Promise<void> {
    const vars = this.getVars(wt);
    const labels = this.presets.getOnCreate();
    if (labels.length === 0) { return; }

    const channel = this.getOutputChannel(`wt${wt.number}: onCreate`);
    channel.clear();
    channel.show(true);

    for (const label of labels) {
      const cmd = this.presets.findCommand(label);
      if (!cmd) {
        channel.appendLine(`WARNING: command "${label}" not found, skipping`);
        continue;
      }

      const command = this.presets.expand(cmd.command, vars);
      const cwd = cmd.cwd ? this.presets.expand(cmd.cwd, vars) : wt.srcPath;
      channel.appendLine(`> [${label}] ${command}`);

      try {
        const output = await this.execShell(command, cwd);
        if (output.trim()) { channel.appendLine(output); }
        this._completed.add(`wt${wt.number}:${label}`);
      } catch (err: any) {
        channel.appendLine(`FAILED: ${err.message}`);
        vscode.window.showErrorMessage(`onCreate "${label}" failed`);
        break;
      }
    }

    channel.appendLine("\nonCreate: done.");
  }

  async removeWorktree(n: number): Promise<void> {
    if (n === 1) { throw new Error("Cannot remove primary worktree"); }

    for (const cmd of this.getRunningForWorktree(n)) {
      this.stopCommand(cmd.id);
    }

    const src = this.srcPath(n);
    if (!fs.existsSync(src)) { throw new Error(`${src} does not exist`); }

    await this.exec("git", ["worktree", "remove", src, "--force"], this.primaryRepo);

    // Clear completed history for this worktree
    for (const key of this._completed) {
      if (key.startsWith(`wt${n}:`)) { this._completed.delete(key); }
    }
  }

  // --- Dependencies ---

  /** Check if all dependencies are satisfied. Returns unsatisfied labels. */
  checkDependencies(worktreeNumber: number, depends?: string[]): string[] {
    if (!depends || depends.length === 0) { return []; }
    const missing: string[] = [];
    for (const dep of depends) {
      const key = `wt${worktreeNumber}:${dep}`;
      if (!this._completed.has(key)) {
        missing.push(dep);
      }
    }
    return missing;
  }

  /** Run missing dependencies sequentially (blocking), then call afterFn. Shows output in channel. */
  async runDependencies(wt: WorktreeInfo, depends: string[] | undefined, afterFn: () => void): Promise<void> {
    const missing = this.checkDependencies(wt.number, depends);
    if (missing.length === 0) {
      afterFn();
      return;
    }

    const vars = this.getVars(wt);
    const channel = this.getOutputChannel(`wt${wt.number}: deps`);
    channel.clear();
    channel.show(true);

    for (const depLabel of missing) {
      const dep = this.presets.findCommand(depLabel);
      if (!dep) {
        channel.appendLine(`WARNING: "${depLabel}" not found, skipping`);
        continue;
      }

      const command = this.presets.expand(dep.command, vars);
      const cwd = dep.cwd ? this.presets.expand(dep.cwd, vars) : wt.srcPath;
      channel.appendLine(`> [${depLabel}] ${command}`);

      try {
        const output = await this.execShell(command, cwd);
        if (output.trim()) { channel.appendLine(output); }
        this._completed.add(`wt${wt.number}:${depLabel}`);
      } catch (err: any) {
        channel.appendLine(`FAILED: ${err.message}`);
        vscode.window.showErrorMessage(`Dependency "${depLabel}" failed`);
        return; // Don't run the main command
      }
    }

    afterFn();
  }

  /** Check if a command is currently running for this worktree */
  isRunning(worktreeNumber: number, label: string): boolean {
    for (const cmd of this._running.values()) {
      if (cmd.worktreeNumber === worktreeNumber && cmd.label === label) {
        return true;
      }
    }
    return false;
  }

  // --- Running commands ---

  getRunningForWorktree(n: number): RunningCommand[] {
    const result: RunningCommand[] = [];
    for (const cmd of this._running.values()) {
      if (cmd.worktreeNumber === n) { result.push(cmd); }
    }
    return result;
  }

  private makeId(worktreeNumber: number, label: string): string {
    const base = `wt${worktreeNumber}:${label}`;
    if (!this._running.has(base)) { return base; }
    let i = 2;
    while (this._running.has(`${base} #${i}`)) { i++; }
    return `${base} #${i}`;
  }

  runInTerminal(worktreeNumber: number, label: string, command: string, cwd: string, env?: Record<string, string>): void {
    const id = this.makeId(worktreeNumber, label);
    const terminal = vscode.window.createTerminal({ name: id, cwd, env });
    terminal.show();
    terminal.sendText(`cd "${cwd}" && ${command}`);

    this._running.set(id, { id, label, worktreeNumber, mode: "terminal", terminal });
    this._onChanged.fire();
  }

  runInOutput(worktreeNumber: number, label: string, command: string, cwd: string, env?: Record<string, string>): void {
    const id = this.makeId(worktreeNumber, label);
    const channel = this.getOutputChannel(id);
    channel.clear();
    channel.show(true);

    const fullEnv = { ...process.env, ...env };
    channel.appendLine(`> ${command}`);
    channel.appendLine(`> cwd: ${cwd}`);
    channel.appendLine("");

    const child = cp.spawn("sh", ["-c", command], { cwd, env: fullEnv, stdio: "pipe", detached: true });

    this._running.set(id, { id, label, worktreeNumber, mode: "command", process: child, channel });
    this._onChanged.fire();

    child.stdout?.on("data", (data: Buffer) => { channel.append(data.toString()); });
    child.stderr?.on("data", (data: Buffer) => { channel.append(data.toString()); });

    child.on("close", (code) => {
      this._running.delete(id);
      channel.appendLine("");
      channel.appendLine(code === 0 ? "Done (exit code 0)" : `FAILED (exit code ${code})`);

      if (code === 0) {
        this._completed.add(`wt${worktreeNumber}:${label}`);
        vscode.window.showInformationMessage(`${id}: done`);
      } else {
        vscode.window.showErrorMessage(`${id}: failed (exit code ${code})`);
      }
      this._onChanged.fire();
    });

    child.on("error", (err) => {
      this._running.delete(id);
      channel.appendLine(`ERROR: ${err.message}`);
      vscode.window.showErrorMessage(`${id}: ${err.message}`);
      this._onChanged.fire();
    });
  }

  viewCommand(id: string): void {
    const cmd = this._running.get(id);
    if (!cmd) { return; }
    if (cmd.mode === "terminal" && cmd.terminal) { cmd.terminal.show(); }
    else if (cmd.mode === "command" && cmd.channel) { cmd.channel.show(true); }
  }

  stopCommand(id: string): void {
    const cmd = this._running.get(id);
    if (!cmd || cmd.mode !== "command" || !cmd.process) { return; }
    if (cmd.process.pid) {
      try { process.kill(-cmd.process.pid, "SIGTERM"); }
      catch { cmd.process.kill("SIGTERM"); }
    } else {
      cmd.process.kill("SIGTERM");
    }
  }

  closeCommand(id: string): void {
    const cmd = this._running.get(id);
    if (!cmd || cmd.mode !== "terminal" || !cmd.terminal) { return; }
    cmd.terminal.dispose();
  }

  // --- Helpers ---

  private getOutputChannel(name: string): vscode.OutputChannel {
    let channel = this._outputChannels.get(name);
    if (!channel) {
      channel = vscode.window.createOutputChannel(name);
      this._outputChannels.set(name, channel);
    }
    return channel;
  }

  private execShell(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(stderr || err.message)); }
        else { resolve(stdout + stderr); }
      });
    });
  }

  dispose(): void {
    this._terminalDisposable?.dispose();
    for (const cmd of this._running.values()) {
      if (cmd.mode === "command" && cmd.process) { cmd.process.kill("SIGTERM"); }
      else if (cmd.mode === "terminal" && cmd.terminal) { cmd.terminal.dispose(); }
    }
    for (const channel of this._outputChannels.values()) { channel.dispose(); }
  }

  async nextAvailableNumber(): Promise<number> {
    const worktrees = await this.listWorktrees();
    const used = new Set(worktrees.map((w) => w.number));
    for (let n = 2; n <= 9; n++) {
      if (!used.has(n)) { return n; }
    }
    throw new Error("No available worktree slots (max 9)");
  }

  async listBranches(): Promise<string[]> {
    const output = await this.exec("git", ["branch", "--format=%(refname:short)"], this.primaryRepo);
    return output.split("\n").map((b) => b.trim()).filter(Boolean);
  }

  async listRemoteBranches(): Promise<string[]> {
    const output = await this.exec("git", ["branch", "-r", "--format=%(refname:short)"], this.primaryRepo);
    return output.split("\n").map((b) => b.trim()).filter(Boolean).map((b) => b.replace(/^origin\//, ""));
  }

  private exec(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`)); }
        else { resolve(stdout); }
      });
    });
  }
}
