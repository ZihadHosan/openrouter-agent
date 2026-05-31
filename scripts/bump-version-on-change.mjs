/**
 * Pre-compile version bump: updates package.json when src/ changes since last compile.
 * - 1–3 files changed  → patch (0.4.4 → 0.4.5)
 * - 4+ files or key files → minor (0.4.4 → 0.5.0)
 * Key files: extension.ts, package.json
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'src');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const statePath = path.join(root, '.version-state.json');

const KEY_FILES = new Set([
  'src/extension.ts',
  'package.json',
]);

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function collectSrcHashes() {
  const out = {};
  if (!fs.existsSync(srcDir)) {
    return out;
  }
  const walk = (dir, prefix = 'src') => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.join(prefix, name).replace(/\\/g, '/');
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, rel);
      } else if (/\.(ts|tsx|js|json)$/i.test(name)) {
        out[rel] = hashFile(full);
      }
    }
  };
  walk(srcDir);
  out['package.json'] = hashFile(pkgPath);
  return out;
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) {
    throw new Error(`Invalid semver in package.json: ${v}`);
  }
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function bump(version, level) {
  const v = parseVersion(version);
  if (level === 'major') {
    return formatVersion({ major: v.major + 1, minor: 0, patch: 0 });
  }
  if (level === 'minor') {
    return formatVersion({ major: v.major, minor: v.minor + 1, patch: 0 });
  }
  return formatVersion({ major: v.major, minor: v.minor, patch: v.patch + 1 });
}

function loadState() {
  if (!fs.existsSync(statePath)) {
    return { version: null, fileHashes: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { version: null, fileHashes: {} };
  }
}

function saveState(version, fileHashes) {
  fs.writeFileSync(
    statePath,
    JSON.stringify({ version, fileHashes, updatedAt: new Date().toISOString() }, null, 2) + '\n'
  );
}

function updateLockVersion(newVersion) {
  if (!fs.existsSync(lockPath)) {
    return;
  }
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (lock.version) {
      lock.version = newVersion;
    }
    if (lock.packages?.['']) {
      lock.packages[''].version = newVersion;
    }
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  } catch {
    /* optional */
  }
}

function diffHashes(prev, next) {
  const changed = [];
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    if (prev[key] !== next[key]) {
      changed.push(key);
    }
  }
  return changed;
}

function decideBumpLevel(changedFiles) {
  if (changedFiles.length === 0) {
    return null;
  }
  const touchesKey = changedFiles.some((f) => KEY_FILES.has(f));
  if (changedFiles.length >= 4 || touchesKey) {
    return 'minor';
  }
  return 'patch';
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const currentHashes = collectSrcHashes();
  const state = loadState();
  const changed = diffHashes(state.fileHashes ?? {}, currentHashes);

  if (!fs.existsSync(statePath)) {
    saveState(pkg.version, currentHashes);
    console.log(`[version] ${pkg.version} (baseline saved — bump on next src change)`);
    return;
  }

  if (changed.length === 0) {
    console.log(`[version] ${pkg.version} (no source changes)`);
    return;
  }

  const level = decideBumpLevel(changed);
  const oldVersion = pkg.version;
  const newVersion = bump(pkg.version, level);
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  updateLockVersion(newVersion);

  currentHashes['package.json'] = hashFile(pkgPath);
  saveState(newVersion, currentHashes);

  console.log(
    `[version] ${oldVersion} → ${newVersion} (${level}, ${changed.length} file(s): ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? '…' : ''})`
  );
}

main();
