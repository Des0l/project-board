// Alternate hue and lightness so neighbouring projects are easy to tell apart.
const palette = [
  '#5267c5', '#db852c', '#16816e', '#a25297', '#317fc0', '#cc5260',
  '#73862f', '#835bd2', '#96704a', '#0898a8', '#be4982', '#655a45',
  '#708ab0', '#eb7551', '#48a16b', '#99748e',
];

export function validProjectColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export function assignProjectColors(projects) {
  const used = new Set(projects.filter(p => validProjectColor(p.color)).map(p => p.color.toLowerCase()));
  let sequence = 0;
  function nextColor() {
    const preset = palette.find(color => !used.has(color));
    if (preset) return preset;
    // An odd step visits every 24-bit RGB value before repeating.
    let color;
    do {
      color = '#' + ((++sequence * 0x9e3779) % 0x1000000).toString(16).padStart(6, '0');
    } while (used.has(color));
    return color;
  }
  for (const project of projects) {
    if (validProjectColor(project.color)) continue;
    project.color = nextColor();
    used.add(project.color);
  }
}
