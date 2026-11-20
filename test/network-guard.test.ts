import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOKS } from '../src/cli/install.ts';
// @ts-expect-error: a plain .mjs hook, no types
import { networkChange, decideNetwork } from '../hooks/network-guard.mjs';

// A room's test VPN profile can break the owner's work login and Claude's own connection mid-work.
test('VPN and network changes are refused, wherever the command sits', () => {
  for (const c of [
    'scutil --nc start "Work VPN"',
    'scutil --nc stop Work',
    'scutil --nc select Work',
    'sudo scutil --set HostName work',
    "scutil <<'EOF'\nd.init\nd.add ServerAddresses * 1.1.1.1\nset State:/Network/Service/x/DNS\nEOF",
    'networksetup -setdnsservers Wi-Fi 1.1.1.1',
    'sudo networksetup -setv6off Ethernet',
    'networksetup -connectpppoeservice Work',
    'networksetup -switchtolocation Home',
    'networksetup -setairportpower en0 off',
    'profiles install -path vpn.mobileconfig',
    'sudo profiles -I -F vpn.mobileconfig',
    '/usr/bin/profiles install -path vpn.mobileconfig',
    'profiles remove -identifier com.x.vpn',
    'open -a "AWS VPN Client"',
    'open "/Applications/AWS VPN Client/AWS VPN Client.app"',
    'open work.ovpn',
    'open ~/Downloads/vpn.mobileconfig',
    'open -b com.amazonaws.acvc.osx',
    'cp work.ovpn ~/.config/AWSVPNClient/OpenVpnConfigs/work',
    'cp work.ovpn ~/.config/AWSVPNClient/',
    'echo "10.0.0.1 work" | sudo tee -a /etc/hosts',
    'echo nameserver 1.1.1.1 > /etc/resolver/work',
    'sudo sed -i "" s/a/b/ /etc/hosts',
    'tailscale up',
    'tailscale down',
    'tailscale set --exit-node=x',
    'tailscale logout',
    'sudo wg-quick up wg0',
    'sudo openvpn --config work.ovpn',
    'sudo route add -net 10.0.0.0/8 10.1.1.1',
    'sudo route delete default',
    'sudo ifconfig en0 down',
    'sudo pfctl -e',
    'sudo pfctl -f /etc/pf.conf',
    'bash -c "networksetup -setdnsservers Wi-Fi Empty"',
    'cd /tmp && timeout 5 scutil --nc start Work',
    `osascript -e 'tell application "AWS VPN Client" to activate'`,
    'warp-cli connect',
    'defaults write /Library/Preferences/SystemConfiguration/preferences x -bool true',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale up',
    'tailscale serve 3000',
    'tailscale funnel 443',
    'sed s/a/b/ hosts.txt > /etc/hosts',
    'echo "10.0.0.1 x" >/etc/hosts',
    'sudo cp pf.conf /private/etc/pf.conf',
    'sudo tee /private/etc/ppp/options',
    'open /Applications/Tailscale.app',
  ])
    assert.ok(networkChange(c, '/tmp'), c);
  for (const c of [
    'scutil --nc list',
    'scutil --nc status "Work VPN"',
    'scutil --dns',
    'scutil --get HostName',
    'networksetup -listallnetworkservices',
    'networksetup -getdnsservers Wi-Fi',
    'networksetup -getinfo Wi-Fi',
    'profiles list',
    'profiles show -type configuration',
    './profiles vercel',
    'manager/profiles vercel',
    '~/.tiny-hq/app/manager/profiles google',
    'cd ~/.tiny-hq/app/manager && ./profiles vercel',
    'tailscale status',
    'tailscale ip -4',
    'tailscale netcheck',
    'ifconfig',
    'ifconfig en0',
    'ifconfig -a',
    'route -n get default',
    'netstat -rn',
    'sudo pfctl -s rules',
    'cat /etc/hosts',
    'ls ~/.config/AWSVPNClient',
    'cp ~/.config/AWSVPNClient/x.ovpn /tmp/look.ovpn',
    'git commit -m "network guard refuses networksetup -setdnsservers and scutil --nc start"',
    "cat <<'EOF'\nsudo networksetup -setv6off Ethernet\nEOF",
    'grep -rn networksetup src',
    'open -a Safari',
    'open "x-apple.systempreferences:com.apple.Network-Settings.extension"',
    'echo hi > /tmp/hosts',
    'warp-cli status',
    'ping -c 1 work',
    'curl https://example.com',
    'ls',
    'command -v openvpn',
    'which wg-quick',
    'type pfctl',
    'tailscale ssh work',
    'open https://github.com/tailscale/tailscale',
    'open ~/src/tailscale',
  ])
    assert.equal(networkChange(c, '/tmp'), undefined, c);
});

test('Write and Edit into network settings or a VPN app folder are refused; a draft profile elsewhere is fine', () => {
  assert.match(decideNetwork('Write', { file_path: '/etc/hosts', content: 'x' }) ?? '', /--why choice/);
  assert.ok(decideNetwork('Edit', { file_path: `${homedir()}/.config/AWSVPNClient/OpenVpnConfigs/work` }));
  assert.ok(decideNetwork('Write', { file_path: `${homedir()}/.config/AWSVPNClient/OpenVpnConfigs/work.ovpn` }));
  assert.equal(decideNetwork('Write', { file_path: '/tmp/draft/work.ovpn' }), undefined);
  assert.equal(decideNetwork('Write', { file_path: '/tmp/draft/notes.md' }), undefined);
  assert.equal(decideNetwork('Read', { file_path: '/etc/hosts' }), undefined);
});

test('the hook refuses over stdin, has no pass, and is offered by setup for Bash and file writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'net-'));
  const run = (input: object) => execFileSync('node', ['hooks/network-guard.mjs'], { input: JSON.stringify(input), env: { ...process.env, CM_DATA_DIR: dir } }).toString();
  assert.equal(JSON.parse(run({ tool_name: 'Bash', tool_input: { command: 'scutil --nc start Work' }, cwd: dir, session_id: 's' })).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse(run({ tool_name: 'Write', tool_input: { file_path: '/etc/hosts' }, cwd: dir })).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: dir }), '');
  // Unwired is the failure this test exists for: setup must offer it, for Bash and file writes.
  const spec = HOOKS.find((h) => h.file === 'network-guard.mjs');
  assert.ok(spec, 'setup offers the network guard');
  for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit']) assert.ok(spec.event === 'PreToolUse' && new RegExp(`^(${spec.matcher})$`).test(tool), `runs before ${tool}`);
});
