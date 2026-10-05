// Reader-local navigation runs before global shortcuts and sequence handling.
// It never receives text input while another route/mode or a dialog is active.
export function readerNavigation(api, mode, { move, page, edge, reserved = [] }) {
  let firstG = 0;
  return api.keymap.intercept('key', ({ event, consume }) => {
    if (api.mode.current() !== mode || api.route.current.name !== mode || api.ui.dialog.open) { firstG = 0; return; }
    const name = event.name?.toLowerCase();
    const key = `${event.ctrl ? 'ctrl+' : ''}${event.shift ? 'shift+' : ''}${name}`;
    const wasG = firstG; firstG = 0;
    if (event.meta || event.super || event.hyper || reserved.includes(key)) return;
    let action;
    if (event.ctrl && !event.shift) {
      const amount = { u: [-1, 0.5], d: [1, 0.5], b: [-1, 1], f: [1, 1] }[name];
      if (amount) action = () => page(...amount);
    } else if (!event.ctrl) {
      if (name === 'g' && (event.shift || event.name === 'G')) action = () => edge(true);
      else if (name === 'g') {
        if (wasG && Date.now() - wasG < 2000) action = () => edge(false);
        else { firstG = Date.now(); action = () => {}; }
      } else if (!event.shift) {
        if (['j', 'down', 'k', 'up'].includes(name)) action = () => move(['j', 'down'].includes(name) ? 1 : -1);
        if (['pageup', 'pagedown'].includes(name)) action = () => page(name === 'pagedown' ? 1 : -1, 1);
        if (['home', 'end'].includes(name)) action = () => edge(name === 'end');
      }
    }
    if (!action) return;
    api.keymap.clearPendingSequence();
    consume(); action();
  }, { priority: 100 });
}
