import { accessSync, constants, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Runtime state lives outside the repo and outside ~/.claude.
export const DATA_DIR = process.env.CM_DATA_DIR ?? join(homedir(), '.tiny-hq');
export const TOKEN_PATH = join(DATA_DIR, 'token');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const LEADS_PATH = join(DATA_DIR, 'leads.json');
export const MODELS_PATH = join(DATA_DIR, 'models.json'); // the model the owner picked per room
export const SCENE_PATH = join(DATA_DIR, 'scene.json'); // the office decor (paintings, plants, colours)
export const DEVICES_PATH = join(DATA_DIR, 'devices.json'); // phones paired for Tailscale access
export const REMOTE_AUDIT_PATH = join(DATA_DIR, 'remote-audit.log');

// The manager's home: their Claude session starts here and picks up manager/CLAUDE.md (who he
// is and how they run the office). The daemon gives them access to ~/Dev from here.
export const MANAGER_DIR = process.env.CM_MANAGER_DIR ?? join(REPO_ROOT, 'manager');
export const PROJECTS_ROOT = join(homedir(), 'Dev');
export const WORKER_BRIEF = join(REPO_ROOT, 'agents', 'worker-brief.md'); // the note each room's session starts with
export const OFFICE_SKILL = join(REPO_ROOT, 'skills', 'theoffice'); // how the office works, for every room
// The manager's notebook lives outside ~/Dev, the one place they may write.
export const MANAGER_NOTES_DIR = join(DATA_DIR, 'manager');

export const DEFAULT_PORT = Number(process.env.CM_PORT ?? 4949);
// The Claude Code the office runs, as a full path. The office runs it with your login shell's PATH,
// which can put an old copy first (an outdated Homebrew one, say) that lacks commands the office
// needs; so it uses the same claude the installer checked: Claude Code's own install in
// ~/.local/bin if there is one, else the first on the office's PATH.
export const CLAUDE_BIN = process.env.CM_CLAUDE_BIN ?? findClaude();

export function findClaude(home = homedir(), path = process.env.PATH ?? ''): string {
  const dirs = [join(home, '.local', 'bin'), ...path.split(':').filter(Boolean)];
  for (const dir of dirs) {
    const bin = join(dir, 'claude');
    try {
      accessSync(bin, constants.X_OK);
      if (statSync(bin).isFile()) return bin;
    } catch {
      // not here
    }
  }
  return 'claude';
}

// Flags every node process we spawn needs (run .ts directly).
export const NODE_FLAGS: readonly string[] = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
