#!/usr/bin/env node
// A global PreToolUse hook (Bash, Write, Edit, MultiEdit): no session changes, imports or connects a
// VPN or network profile on the owner's Mac, or changes its routes, DNS or network settings (a test VPN
// profile can break the owner's work login and Claude's own connection mid-work). There is no pass: a
// network change goes to the owner as a plain choice on a button and they make it themselves. Looking is never held up (networksetup -get/-list, scutil --nc list/status,
// profiles list, tailscale status, ifconfig, route get/-n), and text that only mentions a command (a
// commit message, a heredoc given to cat) is not one.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commands, programAt } from './screen-click-guard.mjs';

const ASK = '~/.tiny-hq/app/manager/ask';
const name = (x) => String(x).split('/').pop();
const is = (re) => (x) => re.test(name(x));
const flags = (args) => args.filter((a) => a.startsWith('-'));

// Folders and files that hold VPN profiles, DNS or network settings: writing there is a change.
const HOME = homedir();
export const PROTECTED = [
  /^\/(private\/)?(etc|var\/run)\/(hosts|resolv\.conf|resolver(\/|$)|pf\.conf|pf\.anchors(\/|$)|ppp(\/|$)|racoon(\/|$)|wireguard(\/|$)|openvpn(\/|$))/,
  /^\/Library\/Preferences\/SystemConfiguration(\/|$)/,
  /\/\.config\/AWSVPNClient(\/|$)/,
  /\/Library\/Application Support\/(AWSVPNClient|Tailscale|OpenVPN Connect|Viscosity|Tunnelblick|WireGuard)(\/|$)/i,
  /\/Library\/(Group Containers|Containers)\/[^/]*(wireguard|tailscale|openvpn|vpn)[^/]*(\/|$)/i,
  /\/(\.wireguard|\.openvpn)(\/|$)/i,
];
const expand = (p, cwd) => resolve(cwd ?? process.cwd(), String(p).replace(/^~(?=\/|$)/, HOME));
export const isProtected = (p, cwd) => {
  if (!p || typeof p !== 'string') return false;
  const full = expand(p.replace(/^['"]|['"]$/g, ''), cwd);
  return PROTECTED.some((re) => re.test(full));
};
// A .ovpn or .mobileconfig file may be written anywhere else (a room drafting one for the owner to look
// at); writing it into a VPN app's folder, or opening or installing it, is the change.
const isProfileFile = (p) => /\.(mobileconfig|ovpn)$/i.test(String(p).replace(/['"]$/, ''));
const isSettingsPath = isProtected;

// VPN and network apps whose opening connects or imports (open -a "AWS VPN Client", open x.ovpn).
const VPN_APP = /^(aws vpn client|tailscale|openvpn connect|viscosity|tunnelblick|wireguard|cisco (secure client|anyconnect.*)|globalprotect|forticlient|nordvpn|expressvpn|protonvpn|mullvad vpn|cloudflare warp|1\.1\.1\.1)(\.app)?\/?$/i;
const VPN_BUNDLE = /^(com\.amazonaws\.acvc|io\.tailscale|net\.openvpn|com\.wireguard|com\.cloudflare\.1dot1dot1dot1)/i;
// Read-only verbs of each tool. Anything else changes something.
const NETWORKSETUP_READ = /^-(get|list|show|print|is|help|version)/i;
const SCUTIL_NC_READ = new Set(['list', 'status', 'show', 'help', 'trigger-status']);
const PROFILES_READ = new Set(['list', 'show', 'status', 'help', 'version', 'validate', '-P', '-L', '-C', '-H', '-h', '-o']);
const TAILSCALE_READ = new Set(['status', 'ip', 'netcheck', 'ping', 'version', 'whois', 'help', 'dns', 'bugreport', 'exit-node', 'metrics', 'licenses', 'completion', 'ssh', 'nc']);
const WRITERS = /^(cp|mv|tee|rsync|ln|install|ditto|rm|touch|truncate|dd|mkdir|chmod|chown)$/;

// What one simple command would change, or undefined.
export function change(w, cwd) {
  let at;
  // Asking where a program is (command -v openvpn, which wg-quick, type pfctl) runs nothing.
  const first = w.find((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
  if (/^(which|type|whereis|man|apropos)$/.test(name(first ?? '')) || (first === 'command' && /^-[vV]$/.test(w[w.indexOf(first) + 1] ?? ''))) return undefined;
  // A redirection into a protected file (echo ... > /etc/hosts, sed ... >/etc/hosts), whatever the program.
  for (let i = 0; i < w.length; i++) {
    const glued = /^(\d?>>?|&>>?|>\|)(.+)$/.exec(w[i]);
    const target = glued ? glued[2] : /^(\d?>>?|&>>?|>\|)$/.test(w[i]) ? w[i + 1] : undefined;
    if (target && isSettingsPath(target, cwd)) return `network settings (writing ${target})`;
  }
  if ((at = programAt(w, is(/^networksetup$/))) >= 0) {
    const verb = w.slice(at + 1).find((a) => a.startsWith('-'));
    return verb && !NETWORKSETUP_READ.test(verb) ? `network settings (networksetup ${verb})` : undefined;
  }
  if ((at = programAt(w, is(/^scutil$/))) >= 0) {
    const args = w.slice(at + 1);
    const nc = args.indexOf('--nc');
    if (nc >= 0) return SCUTIL_NC_READ.has(args[nc + 1] ?? 'help') ? undefined : `a VPN connection (scutil --nc ${args[nc + 1]})`;
    if (args.includes('--set')) return 'network settings (scutil --set)';
    return undefined; // --get, --dns, --proxy, -r; scutil reading a script on stdin is checked below
  }
  // macOS's profiles is a bare `profiles` or /usr/bin/profiles; any other path named profiles (the
  // office's own manager/profiles, which finds a Chrome profile) is not it.
  if ((at = programAt(w, (x) => x === 'profiles' || (name(x) === 'profiles' && expand(x, cwd) === '/usr/bin/profiles'))) >= 0) {
    const args = w.slice(at + 1);
    const verb = args.find((a) => !/^-[a-z]$/.test(a) || /^-[A-Z]$/.test(a)) ?? args[0] ?? 'help';
    return PROFILES_READ.has(verb) ? undefined : `a configuration profile (profiles ${verb})`;
  }
  if ((at = programAt(w, is(/^tailscale$/i))) >= 0) {
    const verb = w.slice(at + 1).find((a) => !a.startsWith('-')) ?? 'help';
    return TAILSCALE_READ.has(verb) ? undefined : `Tailscale (tailscale ${verb})`;
  }
  if ((at = programAt(w, is(/^(wg-quick|openvpn|openvpn3|vpnutil|ipsec|racoon|pppd|vpnc|openconnect|warp-cli|nordvpn|expressvpn|protonvpn|mullvad)$/))) >= 0) {
    const args = w.slice(at + 1);
    if (/^(warp-cli|nordvpn|mullvad|expressvpn|protonvpn)$/.test(name(w[at])) && /^(status|account|version|help|--help|-h|list|settings)$/.test(args[0] ?? 'help')) return undefined;
    if (name(w[at]) === 'wg-quick' && /^(strip)$/.test(args[0] ?? '')) return undefined;
    if (args.some((a) => a === '--help' || a === '-h' || a === '--version')) return undefined;
    return `a VPN (${name(w[at])})`;
  }
  if ((at = programAt(w, is(/^wg$/))) >= 0) {
    const verb = w[at + 1] ?? 'show';
    return /^(set|setconf|addconf|syncconf)$/.test(verb) ? `a VPN (wg ${verb})` : undefined;
  }
  if ((at = programAt(w, is(/^route$/))) >= 0) {
    const verb = w.slice(at + 1).find((a) => !a.startsWith('-'));
    return /^(add|delete|change|flush)$/.test(verb ?? '') ? `the routes (route ${verb})` : undefined;
  }
  if ((at = programAt(w, is(/^ifconfig$/))) >= 0) {
    const args = w.slice(at + 1).filter((a) => a !== '-a' && a !== '-l' && a !== '-u' && a !== '-d' && a !== '-v' && a !== '-L');
    return args.length > 1 ? `a network interface (ifconfig ${args.join(' ')})` : undefined;
  }
  if ((at = programAt(w, is(/^pfctl$/))) >= 0) {
    const f = flags(w.slice(at + 1));
    return f.length && f.every((a) => /^-(s\w*|v+|g)$/.test(a)) ? undefined : 'the firewall (pfctl)';
  }
  if ((at = programAt(w, is(/^(dnsctl|resolvectl)$/))) >= 0) return 'DNS settings';
  if ((at = programAt(w, is(/^(systemsetup)$/))) >= 0) {
    const verb = w.slice(at + 1).find((a) => a.startsWith('-'));
    return verb && !/^-(get|list|help|printcommands)/i.test(verb) ? `system settings (systemsetup ${verb})` : undefined;
  }
  if ((at = programAt(w, is(/^open$/))) >= 0) {
    const args = w.slice(at + 1);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if ((a === '-a' || a === '-b') && (VPN_APP.test(name(String(args[i + 1] ?? '').replace(/\/$/, ''))) || VPN_BUNDLE.test(args[i + 1] ?? ''))) return `a VPN app (${args[i + 1]})`;
      // A VPN app bundle (/Applications/Tailscale.app) or a profile file; a web page or a source folder named after one is fine.
      if (!a.startsWith('-') && !/^[a-z][a-z0-9+.-]*:/i.test(a) && ((/\.app\/?$/i.test(a) && VPN_APP.test(name(a.replace(/\/$/, '')))) || isProfileFile(a))) return `a VPN or network profile (${name(a)})`;
      if (/^x-apple\.systempreferences:com\.apple\.(network|Network|preferences\.configurationprofiles|NetworkExtension)/i.test(a)) return undefined; // only shows the pane
    }
    return undefined;
  }
  if ((at = programAt(w, is(/^osascript$/))) >= 0) {
    const text = w.slice(at + 1).join(' ');
    if (/application\s+"(AWS VPN Client|Tailscale|OpenVPN Connect|Viscosity|Tunnelblick|WireGuard)"/i.test(text)) return 'a VPN app (osascript)';
    if (/\b(connect|disconnect)\s+(service|VPN)\b|current location\s+(of\s+network preferences\s+)?to\b/i.test(text)) return 'network settings (osascript)';
    return undefined;
  }
  if ((at = programAt(w, is(/^(sed|perl|gsed)$/))) >= 0) {
    const args = w.slice(at + 1);
    if (args.some((a) => /^-i/.test(a) || a === '--in-place') && args.some((a) => isSettingsPath(a, cwd))) return 'network settings (an in-place edit)';
    return undefined;
  }
  if ((at = programAt(w, is(/^defaults$/))) >= 0) {
    const args = w.slice(at + 1);
    if (/^(write|delete|import|rename)$/.test(args[0] ?? '') && /systemconfiguration|AWSVPNClient|tailscale|networkextension/i.test(args[1] ?? '')) return `network settings (defaults ${args[0]} ${args[1]})`;
    return undefined;
  }
  if ((at = programAt(w, is(WRITERS))) >= 0) {
    const args = w.slice(at + 1).filter((a) => !a.startsWith('-'));
    const prog = name(w[at]);
    // cp/mv/rsync/ln/install/ditto write their last argument; tee, rm, touch... write every one.
    const targets = /^(cp|mv|rsync|ln|install|ditto)$/.test(prog) ? args.slice(-1) : args;
    const hit = targets.find((a) => isSettingsPath(a, cwd));
    return hit ? `network settings (writing ${hit})` : undefined;
  }
  return undefined;
}

// What a shell command would change on the network, if anything.
export function networkChange(command, cwd) {
  if (typeof command !== 'string' || !command.trim()) return undefined;
  const all = commands(command);
  for (const w of all) {
    const what = change(w, cwd);
    if (what) return what;
  }
  // scutil reading a script on stdin (scutil <<EOF ... set State:/... EOF): the parser drops the body.
  if (all.some((w) => { const at = programAt(w, is(/^scutil$/)); return at >= 0 && w.length === at + 1; }) && /^\s*(set|remove|add|d\.add|notify)\b/m.test(command)) return 'network settings (scutil script)';
  return undefined;
}

// A file the Write/Edit tools would write: settings files and VPN app folders are refused.
export function fileChange(toolName, input) {
  if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(toolName)) return undefined;
  const p = input?.file_path ?? input?.notebook_path;
  if (!p || !isProtected(p)) return undefined;
  return `network settings (writing ${p})`;
}

export function denyReason(what) {
  return `This would change ${what} on the owner's Mac. Rooms never change, import or connect a VPN or network profile, routes, DNS or network settings (a test VPN profile can break the owner's work login and Claude's own connection). There is no pass for it. Put the fix to the owner as a plain choice and stop: \`${ASK} "<what is wrong, and the change you'd make>" --why choice --choices "<your pick>|Leave it"\`. They make the change themselves. Looking is fine without asking (networksetup -get..., scutil --nc list, tailscale status, ifconfig).`;
}

// undefined to let it run; a reason to refuse it.
export function decideNetwork(toolName, input, hook = {}) {
  const what = toolName === 'Bash' ? networkChange(input?.command, hook.cwd) : fileChange(toolName, input);
  return what ? denyReason(what) : undefined;
}

let isMain = false;
try {
  isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isMain = false;
}
if (isMain) {
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let why;
    try {
      const hook = JSON.parse(raw || '{}');
      why = decideNetwork(hook.tool_name, hook.tool_input, hook);
    } catch {
      why = undefined;
    }
    if (why) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }));
  });
}
