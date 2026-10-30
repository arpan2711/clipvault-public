// Icons from the app's sprite (src/renderer/icons.svg, built by scripts/build-icons.js).
//   icon('sword')                 -> 16 px
//   icon('swords', { size: 'md' }) -> 20 px; 'lg' -> 24 px
const SIZE = { sm: '', md: ' i-md', lg: ' i-lg' };

export function icon(name, { size = 'sm', cls = '' } = {}) {
  return `<svg class="i${SIZE[size] || ''}${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="icons.svg#i-${name}"></use></svg>`;
}
