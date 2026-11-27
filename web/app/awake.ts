// The stay-awake switch next to the speaker: on, the Mac never idles into its lock screen.
// The Mac holds the state (src/team/awake.ts), so the page re-reads it and the phone sees the same.
type AwakeApi = (on?: boolean) => Promise<{ on: boolean; since?: number } | undefined>;

export function wireAwakeSwitch(btn: HTMLButtonElement, awake: AwakeApi): void {
  let on = false;
  const show = (s: { on: boolean } | undefined) => {
    if (!s) return; // Mac away: leave it as it was
    on = s.on;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Mac stays awake and unlocked (click to let it sleep)' : 'Mac sleeps and locks as usual (click to keep it awake)';
  };
  btn.addEventListener('click', () => {
    btn.disabled = true;
    void awake(!on).then((s) => {
      btn.disabled = false;
      show(s);
    });
  });
  const read = () => void awake().then(show);
  read();
  setInterval(read, 60_000);
}
