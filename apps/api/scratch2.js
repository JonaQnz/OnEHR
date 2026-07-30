const flat = {
  "person/personendaten/person/name/vorname:0": "Jona",
  "person/personendaten/person/straßenanschrift:0/straße": "Teststr",
  "person/personendaten/person/straßenanschrift:0/hausnummer": "123",
  "person/personendaten/person/straßenanschrift:1/straße": "AndereStr"
};

function readFlatValue(flat, path, rmType) {
  const pathRegex = new RegExp('^' + path.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/\//g, '(?::\\d+)?/') + '(?::\\d+)?(?:\\|.*)?$');
  const matchingKeys = Object.keys(flat).filter(k => pathRegex.test(k));
  if (matchingKeys.length === 0) return undefined;
  
  const values = [];
  for (const k of matchingKeys) {
    // extract indices
    const indices = [];
    const re = /:(\d+)(?=\/|$|\|)/g;
    let m;
    while ((m = re.exec(k)) !== null) {
      indices.push(Number(m[1]));
    }
    
    // find value
    let val = undefined;
    if (rmType === 'DV_QUANTITY') {
        if (k.endsWith('|magnitude')) val = { magnitude: flat[k], unit: flat[k.replace('|magnitude', '|unit')] };
        else continue;
    } else if (rmType === 'DV_CODED_TEXT' || rmType === 'CODE_PHRASE') {
        if (k.endsWith('|code')) val = flat[k];
        else if (k.endsWith('|value') && !matchingKeys.find(mk => mk === k.replace('|value', '|code'))) val = flat[k];
        else continue;
    } else {
        val = flat[k];
    }
    
    // put val in nested array structure according to indices
    let current = values;
    for (let i = 0; i < indices.length - 1; i++) {
        if (!current[indices[i]]) current[indices[i]] = [];
        current = current[indices[i]];
    }
    if (indices.length > 0) {
        current[indices[indices.length - 1]] = val;
    } else {
        return val; // no indices, just return
    }
  }
  return values.length > 0 ? values : undefined;
}

console.log("vorname:", JSON.stringify(readFlatValue(flat, 'person/personendaten/person/name/vorname', undefined)));
console.log("straße:", JSON.stringify(readFlatValue(flat, 'person/personendaten/person/straßenanschrift/straße', undefined)));
