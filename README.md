# Worktree Manager for VS Code

Manage git worktrees and run configurable commands from a single VS Code window.

## Features

- Create/remove git worktrees from the sidebar
- Configurable **commands** (output mode) and **terminals** (interactive mode)
- Global and per-command environment variables with template expansion
- Command dependencies with automatic resolution
- `onCreate` hooks for automatic worktree setup
- Open worktree in new VS Code window with correct env
- Multiple concurrent commands per worktree with tree view
- Stop/close running commands from UI

## Configuration

Create `.vscode/worktree-presets.json` in your project root:

```json
{
  "variables": {
    "outputPath": "/home/user/builds/myproject-output${number}",
    "buildPath": "${outputPath}/build/debug",
    "vcpkgPrefix": "/home/user/libs/vcpkg/installed/x64-linux"
  },
  "env": {
    "MY_VAR": "${outputPath}",
    "PROJECT_ROOT": "${wtPath}"
  },
  "onCreate": ["Setup", "Configure"],
  "commands": [
    {
      "label": "Setup",
      "command": "cp CMakeUserPresets.json ${wtPath}/",
      "hidden": true
    },
    {
      "label": "Configure",
      "command": "cmake -S ${wtPath} -B ${buildPath} -G Ninja"
    },
    {
      "label": "Build",
      "command": "ninja -j${cpus} install",
      "cwd": "${buildPath}",
      "depends": ["Configure"]
    }
  ],
  "terminals": [
    {
      "label": "Shell",
      "command": "${SHELL}"
    },
    {
      "label": "Claude",
      "command": "claude"
    },
    {
      "label": "Debug Server",
      "command": "./run-server.sh",
      "depends": ["Build"]
    }
  ]
}
```

### Built-in variables

| Variable | Description |
|----------|-------------|
| `${wtPath}` | Worktree source directory |
| `${branch}` | Current branch name |
| `${number}` | Worktree number (1-9) |
| `${cpus}` | CPU count |
| `${SHELL}` | User's shell |

User variables in `variables` can reference built-in vars and each other (resolved in order).

### Config sections

| Section | Description |
|---------|-------------|
| `variables` | User-defined variables for template expansion |
| `env` | Global environment variables (inherited by all commands/terminals) |
| `onCreate` | List of command labels to run after worktree creation |
| `commands` | Output-mode commands (read-only log, stoppable) |
| `terminals` | Terminal-mode commands (interactive, closable) |

### Command/terminal options

| Field | Description | Default |
|-------|-------------|---------|
| `label` | Display name | required |
| `command` | Shell command (supports `${...}` variables) | required |
| `cwd` | Working directory | `${wtPath}` |
| `env` | Extra env vars (merged on top of global `env`) | `{}` |
| `depends` | List of command labels that must complete first | `[]` |
| `hidden` | Hide from QuickPick (still available for `onCreate`/`depends`) | `false` |

### Dependencies

When a command or terminal has `depends`, the extension checks if those commands have completed successfully in the current session. If not, they are run automatically before the main command.

### Open in VS Code

The extension adds a window button on each secondary worktree that opens it in a new VS Code window with the global `env` applied. For this to work, your shell startup files (`.zshenv`, `.bashrc`) should use conditional defaults:

```bash
export MY_VAR=${MY_VAR:-default_value}
```

This way, env vars set by the extension won't be overwritten by shell startup.

## Install

```bash
cd worktree-manager-vscode
npm install
npm run compile
```

Then in VS Code: `Ctrl+Shift+P` > `Developer: Install Extension from Location...` > select this folder.

## Worktree layout

```
~/Projects/
  myproject/          # wt1 (primary repo)
  myproject2/         # wt2 (worktree)
  myproject3/         # wt3 (worktree)
```

The extension auto-detects the primary repo via `git rev-parse --git-common-dir`, so it works correctly even when VS Code is opened from a secondary worktree.
