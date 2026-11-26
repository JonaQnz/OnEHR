'use strict';

/**
 * Repository credential hygiene scanner.
 *
 * Detects committed secrets in the working tree and in git history. Matched
 * values are never printed: they are kept in a non-enumerable `_value`
 * property so `JSON.stringify` cannot leak them.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');

const MAX_FILE_SIZE = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const PLACEHOLDER_VALUES = new Set([
  'changeme',
  'placeholder',
  '<redacted>',
  'example',
  'xxx',
]);

const RULE_DEFS = [
  {
    id: 'private-key',
    description: 'PEM private key header',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key id',
    pattern: /AKIA[0-9A-Z]{16}/,
  },
  {
    id: 'github-token',
    description: 'GitHub personal access or app token',
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/,
  },
  {
    id: 'llm-api-key',
    description: 'LLM provider API key',
    pattern: /sk-(?:or-v1-|proj-|ant-)?[A-Za-z0-9_-]{20,}/,
  },
  {
    id: 'slack-token',
    description: 'Slack bot, app, user or refresh token',
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    id: 'url-credentials',
    description: 'Password embedded in a URL',
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]+)@/,
    valueGroup: 1,
    checkPlaceholder: true,
  },
  {
    id: 'json-secret-field',
    description: 'Secret-looking JSON field with a literal value',
    pattern:
      /"([A-Za-z_]*(?:[Pp]ass(?:word)?|[Ss]ecret|[Aa]pi[Kk]ey|[Tt]oken|[Cc]lientSecret)[A-Za-z_]*)"\s*:\s*"([^"]+)"/,
    valueGroup: 2,
    checkPlaceholder: true,
  },
  {
    id: 'env-secret-assignment',
    description: 'Secret-looking environment or compose assignment',
    pattern:
      /^[\s-]*([A-Za-z_]*(?:PASSWORD|PASS|SECRET|TOKEN|API_KEY)[A-Za-z_]*)\s*[:=]\s*["']?([^\s"'#]+)/,
    valueGroup: 2,
    checkPlaceholder: true,
  },
];

const RULES = RULE_DEFS.map(({ id, description }) => ({ id, description }));

const GLOBAL_PATTERNS = new Map();

function isPlaceholder(value) {
  if (!value) return true;
  if (value === '***') return true;
  if (value.startsWith('${') || value.startsWith('$')) return true;
  if (value.startsWith('process.env')) return true;
  return PLACEHOLDER_VALUES.has(value.toLowerCase());
}

function globalPatternFor(def) {
  let pattern = GLOBAL_PATTERNS.get(def.id);
  if (!pattern) {
    const flags = def.pattern.flags.includes('g')
      ? def.pattern.flags
      : `${def.pattern.flags}g`;
    pattern = new RegExp(def.pattern.source, flags);
    GLOBAL_PATTERNS.set(def.id, pattern);
  }
  return pattern;
}

/** Returns `{ rule, value }` for every rule match on a single line. */
function scanLineValues(line) {
  const results = [];
  for (const def of RULE_DEFS) {
    const pattern = globalPatternFor(def);
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      const value = def.valueGroup ? match[def.valueGroup] : match[0];
      if (def.checkPlaceholder && isPlaceholder(value)) continue;
      results.push({ rule: def.id, value });
    }
  }
  return results;
}

function makeFinding({ filePath, line, rule, value }) {
  const finding = { path: filePath, line, rule, group: null };
  Object.defineProperty(finding, '_value', {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return finding;
}

function makeHistoryFinding({ commit, filePath, rule, value }) {
  const finding = { commit, path: filePath, rule, group: null };
  Object.defineProperty(finding, '_value', {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return finding;
}

function scanText(text, filePath) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const { rule, value } of scanLineValues(lines[index])) {
      findings.push(makeFinding({ filePath, line: index + 1, rule, value }));
    }
  }
  return findings;
}

function isSkippedPath(filePath) {
  return (
    filePath.includes('node_modules/') ||
    filePath === 'package-lock.json' ||
    filePath.endsWith('/package-lock.json')
  );
}

function listTrackedFiles(repoRoot) {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter(Boolean);
}

function readTextFileIfScannable(absolutePath) {
  let stats;
  try {
    stats = fs.statSync(absolutePath);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size > MAX_FILE_SIZE) return null;

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return null;
  }
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  return buffer.toString('utf8');
}

function scanTree(repoRoot) {
  const findings = [];
  for (const filePath of listTrackedFiles(repoRoot)) {
    if (isSkippedPath(filePath)) continue;
    const text = readTextFileIfScannable(path.join(repoRoot, filePath));
    if (text === null) continue;
    findings.push(...scanText(text, filePath));
  }
  return assignGroups(findings);
}

function assignGroups(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const value = finding._value;
    if (value === undefined) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  const groupIds = new Map();
  let nextGroup = 1;
  for (const finding of findings) {
    const value = finding._value;
    if (value === undefined || counts.get(value) < 2) {
      finding.group = null;
      continue;
    }
    if (!groupIds.has(value)) {
      groupIds.set(value, nextGroup);
      nextGroup += 1;
    }
    finding.group = groupIds.get(value);
  }
  return findings;
}

function createHistoryState() {
  return { findings: [], seen: new Set(), commit: null, file: null };
}

function scanHistoryLine(state, line) {
  if (line.startsWith('commit ')) {
    state.commit = line.slice('commit '.length).trim();
    state.file = null;
    return;
  }
  if (line.startsWith('+++ b/')) {
    state.file = line.slice('+++ b/'.length);
    return;
  }
  if (line.startsWith('+++ ')) {
    state.file = null;
    return;
  }
  if (!state.commit || !state.file) return;
  if (!line.startsWith('+') || line.startsWith('+++')) return;
  if (isSkippedPath(state.file)) return;

  const commit = state.commit.slice(0, 10);
  for (const { rule, value } of scanLineValues(line.slice(1))) {
    const key = `${commit}\0${state.file}\0${rule}\0${value}`;
    if (state.seen.has(key)) continue;
    state.seen.add(key);
    state.findings.push(
      makeHistoryFinding({ commit, filePath: state.file, rule, value }),
    );
  }
}

function scanHistory(repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      ['log', '--all', '-p', '--no-color', '--no-ext-diff', '--format=commit %H'],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const state = createHistoryState();
    let stderr = '';

    child.on('error', reject);
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });

    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    lines.on('line', (line) => {
      scanHistoryLine(state, line);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git log failed (${code}): ${stderr.trim()}`));
        return;
      }
      resolve(state.findings);
    });
  });
}

function scanPatch(text) {
  const state = createHistoryState();
  for (const line of String(text).split(/\r?\n/)) {
    scanHistoryLine(state, line);
  }
  return state.findings;
}

function loadAllowlist(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function applyAllowlist(findings, allowlist) {
  const entries = Array.isArray(allowlist) ? allowlist : [];
  const remaining = [];
  const allowed = [];
  for (const finding of findings) {
    const matched = entries.some(
      (entry) =>
        entry && entry.path === finding.path && entry.rule === finding.rule,
    );
    if (matched) allowed.push(finding);
    else remaining.push(finding);
  }
  return { remaining, allowed };
}

function summarize(findings) {
  const byRule = {};
  const byPath = {};
  for (const finding of findings) {
    byRule[finding.rule] = (byRule[finding.rule] || 0) + 1;
    byPath[finding.path] = (byPath[finding.path] || 0) + 1;
  }
  return { total: findings.length, byRule, byPath };
}

function summarizeHistory(findings) {
  const rows = new Map();
  for (const finding of findings) {
    const key = `${finding.path}\0${finding.rule}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        path: finding.path,
        rule: finding.rule,
        commits: new Set(),
        newest: finding.commit,
        oldest: finding.commit,
        groups: new Set(),
      };
      rows.set(key, row);
    }
    row.commits.add(finding.commit);
    row.oldest = finding.commit;
    if (finding.group !== null && finding.group !== undefined) {
      row.groups.add(finding.group);
    }
  }

  return [...rows.values()]
    .map((row) => ({
      path: row.path,
      rule: row.rule,
      commits: row.commits.size,
      newest: row.newest,
      oldest: row.oldest,
      groups: [...row.groups].sort((a, b) => a - b),
    }))
    .sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
      return 0;
    });
}

function repoRootOf() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
}

function printFindings(findings) {
  for (const finding of findings) {
    if (finding.commit) {
      console.log(
        `${finding.commit} ${finding.path} ${finding.rule} group=${finding.group}`,
      );
    } else {
      console.log(
        `${finding.path}:${finding.line} ${finding.rule} group=${finding.group}`,
      );
    }
  }
}

async function main(argv) {
  const useJson = argv.includes('--json');
  const includeHistory = argv.includes('--history');
  const allowlistIndex = argv.indexOf('--allowlist');
  const allowlistFile =
    allowlistIndex !== -1 ? argv[allowlistIndex + 1] || null : null;

  const root = repoRootOf();
  const allowlist = allowlistFile ? loadAllowlist(allowlistFile) : [];
  const treeFindings = scanTree(root);
  const { remaining, allowed } = applyAllowlist(treeFindings, allowlist);

  let history = null;
  if (includeHistory) {
    history = await scanHistory(root);
    assignGroups([...treeFindings, ...history]);
  }

  if (useJson) {
    const output = { tree: { summary: summarize(remaining), findings: remaining, allowed } };
    if (history) {
      output.history = {
        summary: summarize(history),
        rows: summarizeHistory(history),
        findings: history,
      };
    }
    console.log(JSON.stringify(output, null, 2));
  } else {
    const treeSummary = summarize(remaining);
    console.log(
      `tree: ${treeSummary.total} finding(s) after allowlist (${allowed.length} allowed)`,
    );
    printFindings(remaining);

    if (history) {
      console.log('');
      console.log(`history: ${history.length} finding(s)`);
      for (const row of summarizeHistory(history)) {
        const groups = row.groups.length > 0 ? row.groups.join(',') : '-';
        console.log(
          `${row.path} ${row.rule} commits=${row.commits} newest=${row.newest} oldest=${row.oldest} groups=${groups}`,
        );
      }
    }
  }

  process.exitCode = remaining.length > 0 ? 1 : 0;
  return remaining.length > 0 ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`secret-scan: ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  RULES,
  scanText,
  scanTree,
  scanHistory,
  scanPatch,
  loadAllowlist,
  applyAllowlist,
  summarize,
  summarizeHistory,
  assignGroups,
};
