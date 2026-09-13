#!/usr/bin/env node

/**
 * Stage 2 read-only source collector/comparison.
 *
 * This program performs only GET requests. It pins GitHub to the Stage 1
 * parent commit, reads GAS HEAD and version 83 through projects.getContent,
 * computes per-file UTF-8 byte length + SHA-256 tuples, and prints the
 * comparison. Retrieved source is held only in memory and is never logged or
 * written to disk.
 *
 * Required environment:
 *   GAS_SCRIPT_ID       Apps Script project ID (not a deployment ID)
 *   GOOGLE_ACCESS_TOKEN OAuth access token authorized for Apps Script API
 *
 * Optional:
 *   GAS_VERSION=83      kept explicit below; changing it changes the experiment
 */

import crypto from 'node:crypto';

const REPO = 'MidnightProject-MP/CT-Runtime';
const GITHUB_REF = '98f0d184636cbe45cd962d4e9985c00abb2b0b93';
const GAS_VERSION = 83;
const SCRIPT_ID = process.env.GAS_SCRIPT_ID;
const ACCESS_TOKEN = process.env.GOOGLE_ACCESS_TOKEN;

const FILES = [
  'appsscript.json',
  'gas_actions.js',
  'gas_agent_executor.js',
  'gas_bootstrap.js',
  'gas_chronicle.js',
  'gas_core.js',
  'gas_deploy.js',
  'gas_evidence.js',
  'gas_federation.js',
  'gas_feedback.js',
  'gas_github.js',
  'gas_migrate.js',
  'gas_observer.js',
  'gas_state.js',
  'gas_trigger.js',
  'gas_v8.js'
];

if (!SCRIPT_ID || !ACCESS_TOKEN) {
  throw new Error('GAS_SCRIPT_ID and GOOGLE_ACCESS_TOKEN are required');
}

function tuple(name, source) {
  const bytes = Buffer.from(source, 'utf8');
  return {
    file: name,
    utf8ByteLength: bytes.length,
    sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex')
  };
}

async function githubJson(path) {
  const url = `https://api.github.com/repos/${REPO}/contents/${path}?ref=${GITHUB_REF}`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'ct-runtime-source-diagnostic'
    }
  });
  if (!response.ok) throw new Error(`GitHub GET ${path}: HTTP ${response.status}`);
  return response.json();
}

async function collectGithub() {
  const result = {};
  for (const file of FILES) {
    const payload = await githubJson(`gas/${file}`);
    const source = Buffer.from(payload.content, 'base64').toString('utf8');
    result[file] = tuple(file, source);
  }
  return result;
}

async function gasGetContent(versionNumber) {
  const url = new URL(`https://script.googleapis.com/v1/projects/${encodeURIComponent(SCRIPT_ID)}/content`);
  if (versionNumber !== null) url.searchParams.set('versionNumber', String(versionNumber));
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      accept: 'application/json'
    }
  });
  if (!response.ok) throw new Error(`Apps Script projects.getContent ${versionNumber ?? 'HEAD'}: HTTP ${response.status}`);
  return response.json();
}

function normalizeGasFiles(payload, label) {
  const files = payload.files || [];
  const result = {};
  for (const file of files) {
    if (file.name === 'appsscript' && file.type === 'JSON') {
      result['appsscript.json'] = tuple('appsscript.json', file.source || '');
      continue;
    }
    if (file.type === 'SERVER_JS') {
      result[file.name] = tuple(file.name, file.source || '');
    }
  }
  const names = Object.keys(result).sort();
  if (names.length !== FILES.length || names.some((name, index) => name !== [...FILES].sort()[index])) {
    throw new Error(`${label} returned ${names.length} comparable files; expected exactly ${FILES.length}`);
  }
  return result;
}

function compare(github, head, v83) {
  const rows = FILES.map((file) => ({
    file,
    github98f0: github[file],
    gasHead: head[file],
    gasV83: v83[file],
    githubEqualsHead: JSON.stringify(github[file]) === JSON.stringify(head[file]),
    githubEqualsV83: JSON.stringify(github[file]) === JSON.stringify(v83[file]),
    headEqualsV83: JSON.stringify(head[file]) === JSON.stringify(v83[file])
  }));

  return rows;
}

const github = await collectGithub();
const head = normalizeGasFiles(await gasGetContent(null), 'GAS HEAD');
const v83 = normalizeGasFiles(await gasGetContent(GAS_VERSION), 'GAS v83');
const rows = compare(github, head, v83);

console.log(JSON.stringify({
  diagnosticOnly: true,
  githubRef: GITHUB_REF,
  gasVersion: GAS_VERSION,
  fileCount: rows.length,
  comparison: rows
}, null, 2));
