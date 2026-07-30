import ts from 'typescript';
import {
  FormDefinitionV1,
  FormScriptDiagnostic,
  FormScriptDocument,
  generateFormScriptTypes,
} from 'core';

const SCRIPT_FILE = '/form-script.ts';
const TYPES_FILE = '/form-script.generated.d.ts';
const MAX_SCRIPT_LENGTH = 200_000;
const ALLOWED_MODULE = '@formbuilder/runtime';
const BANNED_GLOBALS = new Set([
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'eval',
  'Function',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'indexedDB',
  'self',
  'globalThis',
  'postMessage',
  'importScripts',
  'navigator',
  'caches',
]);

export interface FormScriptCompileResult {
  document: FormScriptDocument;
  valid: boolean;
}

function position(file: ts.SourceFile, start: number): Pick<FormScriptDiagnostic, 'line' | 'column'> {
  const location = file.getLineAndCharacterOfPosition(start);
  return { line: location.line + 1, column: location.character + 1 };
}

function compilerDiagnostic(diagnostic: ts.Diagnostic): FormScriptDiagnostic {
  const file = diagnostic.file;
  const start = diagnostic.start;
  return {
    code: diagnostic.code,
    severity: diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error',
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ...(file && start !== undefined ? position(file, start) : {}),
    ...(diagnostic.length !== undefined ? { length: diagnostic.length } : {}),
  };
}

function securityDiagnostic(
  file: ts.SourceFile,
  node: ts.Node,
  code: string,
  message: string,
): FormScriptDiagnostic {
  return {
    code,
    severity: 'error',
    message,
    ...position(file, node.getStart(file)),
    length: node.getWidth(file),
  };
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || (ts.isMethodDeclaration(parent) && parent.name === node)
    || (ts.isPropertyDeclaration(parent) && parent.name === node);
}

function securityDiagnostics(source: string): FormScriptDiagnostic[] {
  const file = ts.createSourceFile(SCRIPT_FILE, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const diagnostics: FormScriptDiagnostic[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const moduleName = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
      if (moduleName !== ALLOWED_MODULE) {
        diagnostics.push(securityDiagnostic(
          file,
          node,
          'SCRIPT_IMPORT_NOT_ALLOWED',
          `Importe aus "${moduleName || 'unbekannt'}" sind im Form Script nicht erlaubt.`,
        ));
      }
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      diagnostics.push(securityDiagnostic(
        file,
        node,
        'SCRIPT_DYNAMIC_IMPORT',
        'Dynamische Imports sind im Form Script nicht erlaubt.',
      ));
    }

    if (ts.isIdentifier(node) && BANNED_GLOBALS.has(node.text) && !isPropertyName(node)) {
      diagnostics.push(securityDiagnostic(
        file,
        node,
        'SCRIPT_FORBIDDEN_GLOBAL',
        `"${node.text}" ist in der isolierten Form Runtime nicht verfügbar.`,
      ));
    }

    ts.forEachChild(node, visit);
  };

  visit(file);
  return diagnostics;
}

function typeScriptDiagnostics(source: string, generatedTypes: string): FormScriptDiagnostic[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ['lib.es2022.d.ts'],
  };
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const virtualFiles = new Map<string, string>([
    [SCRIPT_FILE, source],
    [TYPES_FILE, generatedTypes],
  ]);

  host.fileExists = (fileName) => virtualFiles.has(fileName) || originalFileExists(fileName);
  host.readFile = (fileName) => virtualFiles.get(fileName) ?? originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const content = virtualFiles.get(fileName);
    return content === undefined
      ? originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, content, languageVersion, true);
  };

  const program = ts.createProgram([SCRIPT_FILE, TYPES_FILE], options, host);
  return ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => !diagnostic.file || diagnostic.file.fileName === SCRIPT_FILE)
    .map(compilerDiagnostic);
}

function emitJavaScript(source: string): string {
  const result = ts.transpileModule(source, {
    fileName: SCRIPT_FILE,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      inlineSourceMap: true,
      inlineSources: true,
      removeComments: false,
    },
  });

  return result.outputText.replace(
    /^\s*import\s+\{[^}]*\}\s+from\s+["']@formbuilder\/runtime["'];?\s*$/gm,
    '',
  );
}

export function compileFormScript(
  form: Pick<FormDefinitionV1, 'layout'>,
  source: string,
): FormScriptCompileResult {
  const generatedTypes = generateFormScriptTypes(form);
  const diagnostics: FormScriptDiagnostic[] = [];
  if (source.length > MAX_SCRIPT_LENGTH) {
    diagnostics.push({
      code: 'SCRIPT_TOO_LARGE',
      severity: 'error',
      message: `Das Form Script darf höchstens ${MAX_SCRIPT_LENGTH} Zeichen enthalten.`,
    });
  } else {
    diagnostics.push(...securityDiagnostics(source));
    diagnostics.push(...typeScriptDiagnostics(source, generatedTypes));
  }

  const uniqueDiagnostics = diagnostics.filter((item, index, all) => (
    all.findIndex((candidate) => (
      candidate.code === item.code
      && candidate.line === item.line
      && candidate.column === item.column
      && candidate.message === item.message
    )) === index
  ));
  const valid = !uniqueDiagnostics.some((diagnostic) => diagnostic.severity === 'error');

  return {
    valid,
    document: {
      language: 'typescript',
      source,
      compiled: valid ? emitJavaScript(source) : '',
      generatedTypes,
      diagnostics: uniqueDiagnostics,
      ...(valid ? { compiledAt: new Date().toISOString() } : {}),
    },
  };
}

export function compileFormDefinitionScript(form: FormDefinitionV1): FormScriptCompileResult {
  return compileFormScript(form, form.formScript.source);
}
