import * as fs from "fs";
import * as path from "path";
import { log } from "./logger";

export interface CommandDef {
  label: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  depends?: string[];
  /** Hide from QuickPick menu. Still available for onCreate and depends. */
  hidden?: boolean;
}

export interface TerminalDef {
  label: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  depends?: string[];
  hidden?: boolean;
}

interface ConfigFile {
  variables: Record<string, string>;
  /** Global env applied to all commands/terminals. Individual env merges on top. */
  env?: Record<string, string>;
  onCreate?: string[];
  commands: CommandDef[];
  terminals: TerminalDef[];
}

const DEFAULT_CONFIG: ConfigFile = {
  variables: {},
  commands: [],
  terminals: [
    { label: "Shell", command: "${SHELL}" },
  ],
};

export class PresetManager {
  private filePath: string;

  constructor(primaryRepo: string) {
    this.filePath = path.join(primaryRepo, ".vscode", "worktree-presets.json");
  }

  private read(): ConfigFile {
    if (!fs.existsSync(this.filePath)) {
      log(`Config not found at ${this.filePath}, creating default`);
      this.write(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
    try {
      const content = fs.readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(content) as Partial<ConfigFile>;
      const commands = data.commands || [];
      const terminals = data.terminals || DEFAULT_CONFIG.terminals;
      log(`Loaded ${commands.length} commands, ${terminals.length} terminals from ${this.filePath}`);
      return {
        variables: data.variables || {},
        env: data.env,
        onCreate: data.onCreate,
        commands,
        terminals,
      };
    } catch (err) {
      log(`Failed to read ${this.filePath}: ${err}`);
      return DEFAULT_CONFIG;
    }
  }

  private write(data: ConfigFile): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2) + "\n");
  }

  getUserVariables(builtinVars: Record<string, string>): Record<string, string> {
    const userVars = this.read().variables;
    const merged = { ...builtinVars };
    for (const [key, value] of Object.entries(userVars)) {
      merged[key] = this.expand(value, merged);
    }
    return merged;
  }

  getCommands(): CommandDef[] {
    return this.read().commands;
  }

  getTerminals(): TerminalDef[] {
    return this.read().terminals;
  }

  getOnCreate(): string[] {
    return this.read().onCreate || [];
  }



  /** Find a command by label */
  findCommand(label: string): CommandDef | undefined {
    return this.getCommands().find(c => c.label === label);
  }

  expand(template: string, vars: Record<string, string>): string {
    return template.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] || `\${${key}}`);
  }

  /** Get global env merged with command-specific env, all expanded */
  expandEnv(localEnv: Record<string, string> | undefined, vars: Record<string, string>): Record<string, string> {
    const globalEnv = this.read().env || {};
    const merged = { ...globalEnv, ...localEnv };
    if (Object.keys(merged).length === 0) { return {}; }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(merged)) {
      result[key] = this.expand(value, vars);
    }
    return result;
  }

  /** Deep-expand all string values in a JSON object */
  expandDeep(obj: any, vars: Record<string, string>): any {
    if (typeof obj === "string") {
      return this.expand(obj, vars);
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.expandDeep(item, vars));
    }
    if (obj && typeof obj === "object") {
      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.expandDeep(value, vars);
      }
      return result;
    }
    return obj;
  }

  getFilePath(): string {
    this.read();
    return this.filePath;
  }
}
