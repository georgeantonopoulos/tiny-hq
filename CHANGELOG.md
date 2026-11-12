# Changelog

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
