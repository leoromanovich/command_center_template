const english = 'qwertyuiopasdfghjklzxcvbnm';
const russian = 'йцукенгшщзфывапролдячсмить';
const letters = new Map([...russian].flatMap((letter, i) => [
  [letter, english[i]], [letter.toUpperCase(), english[i].toUpperCase()],
]));
const codepoints = new Map([...letters].map(([from, to]) => [String(from.codePointAt(0)), String(to.codePointAt(0))]));

// Used only for key matching. Text fields always receive the original input.
export function shortcutInput(data, widgets) {
  let translated = letters.get(data) ?? data;
  // Preserve modifiers, alternate keys and event type in extended terminal input.
  translated = translated.replace(/^(\x1b\[)(\d+(?::\d*){0,2})(;[\d:]+)?u$/, (_, prefix, points, modifiers = '') =>
    prefix + points.split(':').map(point => codepoints.get(point) ?? point).join(':') + modifiers + 'u');
  translated = translated.replace(/^(\x1b\[27;\d+;)(\d+)~$/, (_, prefix, point) => prefix + (codepoints.get(point) ?? point) + '~');
  const key = widgets.parseKey(translated);
  if (/^[a-z0-9]$/.test(key ?? '')) return key;
  if (/^shift\+[a-z]$/.test(key ?? '')) return key.at(-1).toUpperCase();
  return widgets.decodeKittyPrintable(translated) ?? translated;
}
