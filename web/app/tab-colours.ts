// Each tab's colour: the person's shirt from the floor; when an earlier open tab already wears
// it (several leads share a shirt), the next unused colour from the office's own palette, so no two
// open tabs look alike.
const OFFICE_COLOURS = ['#e07a5f', '#81b29a', '#f2cc8f', '#7d9cc9', '#c59fc9', '#e8a87c', '#3f6fb5', '#f2b544', '#7fd1ff', '#d8443c'];
export function tabColours(shirts: (string | undefined)[]): (string | undefined)[] {
  const used = new Set<string>();
  return shirts.map((c) => {
    let pick = c && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : undefined;
    if (!pick || used.has(pick)) pick = OFFICE_COLOURS.find((o) => !used.has(o)) ?? pick;
    if (pick) used.add(pick);
    return pick;
  });
}
