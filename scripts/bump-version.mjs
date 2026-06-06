#!/usr/bin/env node
/**
 * Flash⚡Transfer — synchroniseur de version
 *
 * Met à jour la version du projet de façon cohérente dans TOUS les fichiers :
 *   - package.json
 *   - src-tauri/Cargo.toml
 *   - src-tauri/tauri.conf.json
 *   - README.md (badge + références d'installeurs)
 *
 * Usage :
 *   node scripts/bump-version.mjs patch       # 1.3.2 -> 1.3.3
 *   node scripts/bump-version.mjs minor       # 1.3.2 -> 1.4.0
 *   node scripts/bump-version.mjs major       # 1.3.2 -> 2.0.0
 *   node scripts/bump-version.mjs 1.5.0       # version explicite
 *   node scripts/bump-version.mjs --print     # affiche la version courante sans rien changer
 *
 * Sortie : écrit la nouvelle version sur stdout (utile pour la CI).
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PKG = join(ROOT, 'package.json');
const CARGO = join(ROOT, 'src-tauri', 'Cargo.toml');
const TAURI_CONF = join(ROOT, 'src-tauri', 'tauri.conf.json');
const README = join(ROOT, 'README.md');

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function readCurrentVersion() {
  // Source de vérité = tauri.conf.json (version réelle de l'application packagée).
  const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
  if (!conf.version || !SEMVER_RE.test(conf.version)) {
    throw new Error(`Version invalide dans tauri.conf.json : ${conf.version}`);
  }
  return conf.version;
}

function computeNext(current, bump) {
  if (SEMVER_RE.test(bump)) return bump; // version explicite
  const [maj, min, pat] = current.split('.').map(Number);
  switch (bump) {
    case 'major': return `${maj + 1}.0.0`;
    case 'minor': return `${maj}.${min + 1}.0`;
    case 'patch': return `${maj}.${min}.${pat + 1}`;
    default:
      throw new Error(`Type de bump inconnu : "${bump}" (attendu: major|minor|patch|X.Y.Z)`);
  }
}

function replaceInFile(path, replacer) {
  const before = readFileSync(path, 'utf8');
  const after = replacer(before);
  if (before !== after) writeFileSync(path, after);
  return before !== after;
}

function updatePackageJson(next) {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  pkg.version = next;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
}

function updateTauriConf(next) {
  const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
  conf.version = next;
  writeFileSync(TAURI_CONF, JSON.stringify(conf, null, 2) + '\n');
}

function updateCargo(next) {
  // Remplace uniquement la 1re clé `version = "..."` (celle du [package])
  let replaced = false;
  replaceInFile(CARGO, (txt) =>
    txt.replace(/^version\s*=\s*"[^"]*"/m, () => {
      replaced = true;
      return `version = "${next}"`;
    })
  );
  if (!replaced) throw new Error('Clé version introuvable dans Cargo.toml');
}

function updateReadme(current, next) {
  // Badge shields.io : version-1.3.2-FFD700  →  version-1.5.0-FFD700
  // + toute référence littérale à l'ancienne version (ex: noms d'installeurs).
  const escaped = current.replace(/\./g, '\\.');
  replaceInFile(README, (txt) =>
    txt
      .replace(new RegExp(`version-${escaped}-`, 'g'), `version-${next}-`)
      .replace(new RegExp(escaped, 'g'), next)
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
const arg = process.argv[2];
const current = readCurrentVersion();

if (!arg || arg === '--print') {
  process.stdout.write(current + '\n');
  process.exit(0);
}

const next = computeNext(current, arg);

updatePackageJson(next);
updateTauriConf(next);
updateCargo(next);
updateReadme(current, next);

process.stderr.write(`Version : ${current} -> ${next}\n`);
process.stdout.write(next + '\n');
