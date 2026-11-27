'use strict';

// Vendored react-form-builder2 contract.
//
// apps/web imports the local workspace fork (`react-form-builder2`) and the
// compiled stylesheet (`react-form-builder2/dist/app.css`). The Docker build
// order relies on the package's `build:lib` target, which transpiles `src/`
// into `lib/` (the `main` entry) and compiles `scss/application.scss` into
// `dist/app.css`. These tests read the vendored package directly so a cleanup
// that removes a build input, or re-adds the upstream demo scaffolding, fails
// here before the image build does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PACKAGE_DIR = path.join(ROOT, 'packages', 'react-form-builder2');

const DESIGNER_PAGES = [
  'apps/web/src/pages/FormBuilder.tsx',
  'apps/web/src/designer/CompositionBuilderCanvas.tsx',
];

// Upstream demo/dev scaffolding that the production build never reads. The
// package publishes only `lib`, `dist` and `types`, and the workspace build
// uses the root lockfile, so these cannot be picked up by npm ci or build:lib.
const REMOVED_DEMO_ENTRIES = [
  'app.js',
  'demobar.js',
  'index.html',
  'jquery-stub.js',
  'variables.js',
  'webpack.config.js',
  'webpack.production.config.js',
  'screenshot.png',
  'screenshot2.png',
  'screenshot3.png',
  'package-lock.json',
  'examples',
  'docs',
  'public',
  'server',
];

function readPackageFile(relativePath) {
  return fs.readFileSync(path.join(PACKAGE_DIR, relativePath), 'utf8');
}

function packagePathExists(relativePath) {
  return fs.existsSync(path.join(PACKAGE_DIR, relativePath));
}

test('vendored form builder keeps its publish and build contract', () => {
  const pkg = JSON.parse(readPackageFile('package.json'));

  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.types, 'types/index.d.ts');
  assert.ok(
    pkg.files.includes('lib') && pkg.files.includes('types'),
    `package files must keep lib and types, got: ${JSON.stringify(pkg.files)}`,
  );
  assert.ok(
    packagePathExists('src/index.jsx'),
    'packages/react-form-builder2/src/index.jsx must exist',
  );
  assert.ok(
    packagePathExists('types/index.d.ts'),
    'packages/react-form-builder2/types/index.d.ts must exist',
  );
  assert.match(pkg.scripts['build:lib'], /npm run transpile/);
  assert.match(pkg.scripts['build:lib'], /npm run build:style/);
  assert.match(pkg.scripts['build:style'], /scss\/application\.scss/);
  assert.match(pkg.scripts['build:style'], /dist\/app\.css/);

  const rootLock = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'),
  );
  assert.ok(
    rootLock.packages['packages/react-form-builder2'],
    'the root package-lock.json must keep the react-form-builder2 workspace entry',
  );
});

test('vendored Sass entry point resolves every local partial', () => {
  const application = readPackageFile('scss/application.scss');
  const imports = [...application.matchAll(/@use\s+['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith('sass:'));

  assert.ok(imports.length > 0, 'scss/application.scss must import partials');

  for (const specifier of imports) {
    // Bare `../node_modules/...` imports come from the root install.
    if (specifier.startsWith('.')) {
      continue;
    }
    assert.ok(
      packagePathExists(path.join('scss', `${specifier}.scss`)),
      `scss/application.scss imports ${specifier}, but scss/${specifier}.scss is missing`,
    );
  }
});

test('both local designer pages import the fork and its stylesheet', () => {
  const webPackage = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'apps', 'web', 'package.json'), 'utf8'),
  );
  assert.equal(
    webPackage.dependencies['react-form-builder2'],
    '*',
    'apps/web must consume the local react-form-builder2 workspace',
  );

  for (const relativePath of DESIGNER_PAGES) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.match(
      source,
      /from ['"]react-form-builder2['"]/,
      `${relativePath} must import react-form-builder2`,
    );
    assert.match(
      source,
      /import ['"]react-form-builder2\/dist\/app\.css['"]/,
      `${relativePath} must import react-form-builder2/dist/app.css`,
    );
  }
});

test('vendored form builder keeps its license and origin', () => {
  const license = readPackageFile('LICENSE');
  const pkg = JSON.parse(readPackageFile('package.json'));

  assert.match(license, /The MIT License/);
  assert.equal(pkg.license, 'MIT');
  assert.equal(
    pkg.repository.url,
    'git+https://github.com/Kiho/react-form-builder.git',
  );
});

test('vendored form builder carries no unused upstream demo scaffolding', () => {
  for (const entry of REMOVED_DEMO_ENTRIES) {
    assert.equal(
      packagePathExists(entry),
      false,
      `packages/react-form-builder2/${entry} is not read by the workspace build and must not be vendored`,
    );
  }

  const readme = readPackageFile('README.md');
  for (const orphanedReference of [
    'screenshot',
    'examples/',
    'docs/',
    'server/',
    'public/index.html',
    'css/application.css.scss',
    'build:dist',
    'serve:api',
  ]) {
    assert.ok(
      !readme.includes(orphanedReference),
      `README.md still references removed path "${orphanedReference}"`,
    );
  }
  assert.ok(
    readme.includes('scss/application.scss'),
    'README.md must document the productive Sass entry point',
  );
});
