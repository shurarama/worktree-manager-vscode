# Worktree Manager for VS Code

Manage git worktrees and run configurable commands from a single VS Code window.

## Features

- Create/remove git worktrees from the sidebar
- Run configurable commands (build, shell, Claude, etc.) in any worktree
- Two execution modes: **terminal** (interactive) and **output** (read-only log)
- Track running commands per worktree with stop/close controls
- User-defined variables for DRY command configuration

## Configuration

Create `.vscode/worktree-presets.json` in your project root:

```json
{
  "variables": {
    "outputPath": "/home/user/builds/myproject${number}",
    "buildPath": "${outputPath}/debug"
  },
  "commands": [
    {
      "label": "Build",
      "command": "make -j${cpus}",
      "cwd": "${buildPath}",
      "mode": "output"
    },
    {
      "label": "Shell",
      "command": "${SHELL}",
      "mode": "terminal"
    }
  ]
}
```

### Built-in variables

| Variable | Description |
|----------|-------------|
| `${srcPath}` | Worktree source directory |
| `${branch}` | Current branch name |
| `${number}` | Worktree number (1-9) |
| `${cpus}` | CPU count |
| `${SHELL}` | User's shell |

User variables defined in `variables` can reference built-in vars and each other (in order).

### Command options

| Field | Description | Default |
|-------|-------------|---------|
| `label` | Display name | required |
| `command` | Shell command | required |
| `cwd` | Working directory | `${srcPath}` |
| `mode` | `"terminal"` (interactive) or `"output"` (read-only) | `"terminal"` |
| `env` | Environment variables | `{}` |

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
