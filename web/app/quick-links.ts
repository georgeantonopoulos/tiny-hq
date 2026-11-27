// Quick links: taskbar-style icons along the bottom of the floor. Each opens its page in a new tab.
// `{here}` is the address this page was opened at, so a page served by the Mac opens from the Mac
// and from a phone alike. The list is ~/.tiny-hq/links.json.
export interface QuickLink {
  name: string;
  url: string;
  emoji: string;
  icon?: string; // the site's own icon, as a data: URL, once Tiny HQ has fetched it
  launchable?: boolean; // a program on the Mac serves it: Tiny HQ starts it on a click if needed
}

export const linkHref = (url: string, here: string): string => url.replace(/\{here\}/g, here);

export function renderLinks(dock: HTMLElement, links: QuickLink[], here: string, launch?: (name: string) => Promise<{ ok: boolean; error?: string }>): void {
  dock.replaceChildren();
  dock.hidden = links.length === 0;
  for (const l of links) {
    const a = document.createElement('a');
    a.className = 'dock-link';
    a.href = linkHref(l.url, here);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = l.name;
    a.setAttribute('aria-label', l.name);
    if (l.launchable && launch) {
      // Open the tab now (a later window.open is blocked), start the program, then point the tab at it.
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const win = window.open('about:blank', '_blank');
        a.classList.add('starting');
        void launch(l.name).then((r) => {
          a.classList.remove('starting');
          if (r.ok) {
            if (win) win.location.href = a.href;
            else window.open(a.href, '_blank', 'noopener');
          } else {
            win?.close();
            a.title = `${l.name}: ${r.error ?? 'could not start'}`;
          }
        });
      });
    }
    const tile = document.createElement('span');
    tile.className = 'dock-tile';
    const emoji = () => {
      tile.textContent = l.emoji;
      tile.classList.add('emoji');
    };
    if (l.icon && l.icon.startsWith('data:image/')) {
      const img = document.createElement('img');
      img.src = l.icon;
      img.alt = '';
      img.onerror = () => {
        img.remove();
        emoji();
      };
      tile.append(img);
    } else emoji();
    const label = document.createElement('span');
    label.className = 'dock-label';
    label.textContent = l.name;
    a.append(tile, label);
    dock.append(a);
  }
}
