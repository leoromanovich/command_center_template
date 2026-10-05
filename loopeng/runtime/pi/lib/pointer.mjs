// Regular Pi delegates the mouse to the terminal. Capture SGR events only while
// our overlay is open; fullscreen Pi already supplies normalized handleMouse.
export function overlayPointer(tui, getBounds, dispatch) {
  const regular = tui.mode !== 'fullscreen';
  let enabled = false;
  const enable = () => {
    if (regular && !enabled) { tui.terminal.write?.('\x1b[?1000h\x1b[?1006h'); enabled = true; }
  };
  const disable = () => {
    if (enabled) { tui.terminal.write?.('\x1b[?1006l\x1b[?1000l'); enabled = false; }
  };
  return {
    enable, disable,
    input(data) {
      const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
      if (!match) return false;
      // Never let mouse bytes fall through into text entry or keyboard shortcuts.
      if (!regular || !enabled) return true;
      const bounds = getBounds();
      if (!bounds) return true;
      const button = Number(match[1]), screenX = Number(match[2]) - 1, screenY = Number(match[3]) - 1;
      const x = screenX - bounds.col, y = screenY - bounds.row;
      if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return true;
      if (button & 32 || button & 128 || button & 64 && (button & 3) > 1) return true;
      const wheel = !!(button & 64);
      if (wheel && match[4] !== 'M') return true;
      dispatch({ type: wheel ? 'wheel' : match[4] === 'm' ? 'release' : 'press',
        button: wheel ? 'none' : ['left', 'middle', 'right', 'none'][button & 3],
        wheelDelta: wheel ? (button & 1 ? 3 : -3) : undefined,
        x, y, screenX, screenY, width: bounds.width, height: bounds.height,
        shift: !!(button & 4), alt: !!(button & 8), ctrl: !!(button & 16),
      });
      return true;
    },
  };
}
