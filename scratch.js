const fs = require('fs');
const files = fs.readdirSync('./examples/templates');
for (const f of files) {
  if (f.endsWith('.json')) {
    const data = JSON.parse(fs.readFileSync('./examples/templates/' + f, 'utf8'));
    function findQ(node) {
      if (node.rmType === 'DV_QUANTITY') {
        console.log('File:', f, 'Node ID:', node.id);
        console.log('Inputs:', JSON.stringify(node.inputs, null, 2));
      }
      if (node.children) node.children.forEach(findQ);
    }
    findQ(data.tree);
  }
}
