# Changelog

## 0.2.0: setup in the browser, and a first install that works

The first version on npm, as `tiny-hq-office` (npm keeps `tiny-hq` back as too close to another package's name): `npx tiny-hq-office` installs it, and the command it adds is still `tiny-hq`.

**New**

- **Setup is a welcome page in your browser:** name the office, hire the manager, pick your project folders with the Mac's folder picker, choose which projects get rooms, and switch the extras and helpers on or off. Suggested tools (GitHub CLI, a usage meter, Codex, Obsidian, project memory, Tailscale) can be installed from there. `tiny-hq setup --terminal` asks the same questions in the terminal.
- **Links you can tap:** web addresses in speech bubbles and in a room's chat open in a new tab.
- **Pictures and files:** bubbles can show a picture, and you can attach a file to a room's chat.
- **A Done / Stuck button** for a step only you can do (a switch in macOS System Settings, say), instead of Approve / No.
- **Optional screen helper** (`tiny-hq screen on`): rooms can take screenshots of desktop apps and click them while they test (needs Peekaboo).
- **Rooms write plainly:** they lead with the answer, say where you answered from (the Mac or your phone), and only call something working once they've seen or heard it.

**Safer**

- **Public deploys are button-only,** like posts. Each Approve covers one exact version and lists every commit going out.
- **Each post Approve is for one place:** making a repo public, or changing a hosting setting, needs its own yes.

**Fixed for a first install**

- Opening a room no longer fails when an older Claude Code is also on the Mac. The office uses the same Claude Code that setup checked, and `tiny-hq doctor` says which one.
- A room in a folder Claude Code hasn't trusted yet asks **Trust and open**, instead of failing with "Workspace not trusted".
- Reloading the welcome page keeps your setup going.
- Projects you leave out of the rooms stay in the archive cupboard after a restart.

## 0.1.0: first release

Tiny HQ is a little office for your Claude Code projects: a room for every busy project, each one its own Claude Code session, and a manager that hands out work and makes sure it gets finished.

**What's in it**

- **The office:** rooms found from your Claude Code history and project folders, sized by how busy they are; quiet ones go to the archive cupboard. Click any room to open its Claude in a terminal in the page.
- **A manager you name,** in the style you pick (calm, whimsical or plain). It hands work to the right room with a written brief, keeps a whiteboard of what's next, and reports back in a speech bubble.
- **Jobs that get finished:** every job has a "done when" line, and the office nudges a room that goes quiet until it's true. Jobs waiting on someone else are held and pick up again by themselves.
- **Question buttons instead of chat:** anything that needs you is an Approve / No (or a few choices) over someone's head, saying why only you can answer and what was already tried.
- **Your desk** for reports you asked for, **room goals** that rooms work toward on their own (on a branch, stopping before anything that needs you), and a **timetable** for scheduled checks.
- **Optional extras:** a GitHub keeper for other people's pull requests, issues and comments; a coffee room where rooms share what they learned; little office happenings; phone access over your own Tailscale.

**Safe by default**

- No email is sent and nothing is posted publicly without your yes to the exact text.
- What outsiders write (GitHub comments, email) reaches the manager as facts only, never as instructions.
- Nothing is added outside `~/.tiny-hq` without asking: each Claude Code hook, the office skill and the login item is a separate yes or no, and `tiny-hq uninstall` removes them.
- The office listens only on your Mac; phone access is off unless you set it up.

**Install:** `npx tiny-hq` (macOS, Node 22.17+, Claude Code).
