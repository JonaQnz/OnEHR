const flat = {
  "person/personendaten/person/name/vorname:0": "Jona",
  "person/personendaten/person/straßenanschrift:0/straße": "Teststr"
};

function readFlatValue(flat, path, rmType) {
  const prefix = `${path}:`;
  const entries = Object.keys(flat).map((key) => {
    if (!key.startsWith(prefix)) return undefined;
    const suffix = key.slice(prefix.length).split('|', 1)[0];
    return /^\d+$/.test(suffix) ? { index: Number(suffix), key } : undefined;
  }).filter(Boolean).sort((left, right) => left.index - right.index);
  
  const indexed = entries.map(({ key }) => flat[key]);
  if (indexed.length > 0) {
    return indexed.map((_value, index) => readFlatValue(flat, `${path}:${index}`, rmType));
  }
  if (rmType === 'DV_QUANTITY') {
    const magnitude = flat[`${path}|magnitude`];
    const unit = flat[`${path}|unit`];
    return (!magnitude && !unit) ? undefined : { magnitude, unit };
  }
  if (rmType === 'DV_CODED_TEXT' || rmType === 'CODE_PHRASE') return flat[`${path}|code`] ?? flat[`${path}|value`] ?? flat[path];
  return flat[path];
}

console.log("vorname:", readFlatValue(flat, 'person/personendaten/person/name/vorname', undefined));
console.log("straße:", readFlatValue(flat, 'person/personendaten/person/straßenanschrift/straße', undefined));
