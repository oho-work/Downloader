#!/usr/bin/env node
'use strict';

// Collect pinned source trees and a local-input build recipe. No compilation,
// binary replacement, public upload, or browser operation is performed here.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DATE = '2025-01-07T10:13:14Z';
const USER_AGENT = 'Downloader-third-party-source-collector/1.0.1';
let totalDownloaded = 0;
let maxDownloaded = 500 * 1024 * 1024;

function digest(bytes, algorithm = 'sha256') { return crypto.createHash(algorithm).update(bytes).digest('hex'); }
async function fileDigest(file, algorithm = 'sha256') { return digest(await fs.readFile(file), algorithm); }
function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve(stdout);
      else { const error = new Error(`${program} exited ${code}: ${stderr.slice(-1500)}`); error.stderr = stderr; reject(error); }
    });
  });
}
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';

async function api(relative) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch('https://api.github.com/' + relative, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}: ${relative}`);
      return await response.json();
    } catch (error) { last = error; }
  }
  throw last;
}

async function download(url, target, previous) {
  if (previous && await fs.stat(target).then(() => true, () => false)) {
    const stat = await fs.stat(target);
    if (stat.size === previous.bytes && await fileDigest(target) === previous.sha256) return previous;
    throw new Error(`Existing archive hash mismatch: ${path.basename(target)}`);
  }
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const partial = target + '.part';
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body) throw new Error(`Download HTTP ${response.status}: ${url}`);
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      const counter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        totalDownloaded += chunk.length;
        if (totalDownloaded > maxDownloaded) { callback(new Error('Download budget exceeded')); return; }
        hash.update(chunk);
        callback(null, chunk);
      } });
      const handle = await fs.open(partial, 'w');
      try { await pipeline(Readable.fromWeb(response.body), counter, handle.createWriteStream()); }
      finally { await handle.close().catch(() => {}); }
      await fs.rename(partial, target);
      return { url, bytes, sha256: hash.digest('hex') };
    } catch (error) {
      last = error;
      await fs.rm(partial, { force: true });
      if (totalDownloaded >= maxDownloaded) throw error;
    }
  }
  throw last;
}

async function extract(archive, destination) {
  const names = await command(tar, ['-tzf', archive]);
  for (const name of names.split(/\r?\n/).filter(Boolean)) {
    if (path.posix.isAbsolute(name) || name.split('/').includes('..') || /^[A-Za-z]:/.test(name)) throw new Error('Unsafe archive path');
  }
  await fs.mkdir(destination, { recursive: true });
  try { await command(tar, ['-xzf', archive, '-C', destination, '--strip-components', '1']); }
  catch (error) {
    if (process.platform !== 'win32' || !error.stderr || error.stderr.split(/\r?\n/).filter(Boolean).some(line => !/Can't create .*: Invalid argument|Error exit delayed from previous errors/.test(line))) throw error;
    // Windows may lack symlink privilege. The original archive is retained
    // intact; restore-sources.sh reconstructs authoritative trees on Linux.
    return 'Windows could not materialize symlink(s); use preserved source archive and restore-sources.sh on Linux.';
  }
  return null;
}

function githubRepo(url, parentRepo) {
  if (url.startsWith('../')) {
    const owner = parentRepo.split('/')[0];
    return `${owner}/${url.slice(3)}`.replace(/\.git$/, '');
  }
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match) throw new Error('Unsupported submodule URL: ' + url);
  return match[1];
}

function submoduleUrls(text) {
  const result = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[submodule\s+/.test(line)) { current = {}; continue; }
    const pair = /^\s*(path|url)\s*=\s*(.+?)\s*$/.exec(line);
    if (current && pair) {
      current[pair[1]] = pair[2];
      if (current.path && current.url) result.set(current.path, current.url);
    }
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  let out = path.join(ROOT, 'dist', 'source-bundle');
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--output' && args[i + 1]) out = path.resolve(ROOT, args[i + 1]);
    else if (args[i] === '--max-download-mb' && args[i + 1]) maxDownloaded = Number(args[i + 1]) * 1024 * 1024;
    else throw new Error('Usage: node tools/collect-third-party-sources.cjs [--output dist/source-bundle] [--max-download-mb 500]');
  }
  const dist = path.join(ROOT, 'dist');
  if (!out.startsWith(dist + path.sep)) throw new Error('Output must be a directory inside the project dist directory');
  if (!Number.isFinite(maxDownloaded) || maxDownloaded < 1 || maxDownloaded > 500 * 1024 * 1024) throw new Error('Download limit must be between 1 byte and 500 MiB');
  await fs.mkdir(path.join(out, 'archives'), { recursive: true });
  const provenance = JSON.parse(await fs.readFile(path.join(ROOT, 'third-party-licenses', 'provenance.json'), 'utf8'));
  const manifestFile = path.join(out, 'manifest.json');
  const manifest = await fs.readFile(manifestFile, 'utf8').then(JSON.parse, () => ({
    format: 1, preparedAt: new Date().toISOString(), buildExecuted: false,
    sourceCorrespondence: 'Pinned release-source candidate; original upstream build inputs/cache and byte-for-byte reproduction are not independently attested.',
    archives: [], sources: [], skippedSubmodules: [], historicalBranchChecks: [], binaries: [],
  }));
  const save = () => fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  async function collect(component, repo, commit, destination, depth = 0) {
    if (!/^[0-9a-f]{40}$/.test(commit) || !/^[\w.-]+\/[\w.-]+$/.test(repo) || depth > 5) throw new Error('Invalid pinned source reference');
    const archiveName = `${repo.replace('/', '--')}--${commit}.tar.gz`;
    const archivePath = path.join(out, 'archives', archiveName);
    const previous = manifest.archives.find(item => item.file === 'archives/' + archiveName);
    const record = await download(`https://codeload.github.com/${repo}/tar.gz/${commit}`, archivePath, previous);
    if (!previous) { manifest.archives.push({ ...record, file: 'archives/' + archiveName }); await save(); }
    const fullDestination = path.join(out, ...destination.split('/'));
    if (!manifest.sources.some(item => item.destination === destination)) {
      const extractionNote = await extract(archivePath, fullDestination);
      manifest.sources.push({ component, repo, commit, destination, archive: 'archives/' + archiveName, ...(extractionNote ? { extractionNote } : {}) });
      await save();
    }
    const modules = await fs.readFile(path.join(fullDestination, '.gitmodules'), 'utf8').catch(() => '');
    if (modules) {
        const tree = await api(`repos/${repo}/git/trees/${commit}?recursive=1`);
        if (tree.truncated) throw new Error('Truncated submodule tree: ' + repo);
        const urls = submoduleUrls(modules);
        for (const entry of tree.tree.filter(item => item.mode === '160000')) {
          if (['ffmpeg-wasm', 'ffmpeg-wrapper'].includes(component) && entry.path === 'testdata') {
            if (!manifest.skippedSubmodules.some(item => item.component === component && item.path === entry.path)) manifest.skippedSubmodules.push({ component, path: entry.path, commit: entry.sha, reason: 'External media test fixtures; not used by Dockerfile or production build scripts.' });
            continue;
          }
          const subRepo = githubRepo(urls.get(entry.path) || '', repo);
          await collect(component + '/' + entry.path, subRepo, entry.sha, destination + '/' + entry.path, depth + 1);
        }
    }
    await save();
    process.stdout.write(`Collected ${component} ${commit.slice(0, 12)}\n`);
  }

  for (const name of ['x264', 'lame']) {
    if (manifest.historicalBranchChecks.some(item => item.component === name)) continue;
    const item = provenance.components.find(component => component.component === name);
    const commits = await api(`repos/${item.repo}/commits?sha=${encodeURIComponent(item.declaredRef)}&until=${RELEASE_DATE}&per_page=1`);
    if (commits[0]?.sha !== item.resolvedCommitAtAudit) throw new Error('Historical branch differs from recorded source: ' + name);
    manifest.historicalBranchChecks.push({ component: name, branch: item.declaredRef, asOf: RELEASE_DATE, commit: commits[0].sha, commitDate: commits[0].commit.author.date,
      meaning: 'GitHub reachable branch history as of release date matches this pin; not an attestation of the original build cache or inputs.' });
    await save();
  }
  for (const item of provenance.components) await collect(item.component, item.repo, item.resolvedCommitAtAudit, 'upstream/' + item.component);

  const corePackage = provenance.npmSources.find(item => item.name === '@ffmpeg/core' && item.version === '0.12.10');
  const packageName = 'ffmpeg-core-0.12.10.tgz';
  const packageFile = path.join(out, 'archives', packageName);
  const previousPackage = manifest.archives.find(item => item.file === 'archives/' + packageName);
  const binaryArchive = await download(corePackage.tarball, packageFile, previousPackage);
  const integrity = 'sha512-' + crypto.createHash('sha512').update(await fs.readFile(packageFile)).digest('base64');
  if (integrity !== corePackage.integrity) throw new Error('npm core package integrity mismatch');
  if (!previousPackage) manifest.archives.push({ ...binaryArchive, file: 'archives/' + packageName, npmIntegrity: integrity });
  const packageDir = path.join(out, 'binary-verification', 'ffmpeg-core-0.12.10');
  await extract(packageFile, packageDir);
  manifest.binaries = [];
  for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
    const bundled = path.join(ROOT, 'lib', 'ffmpeg12-core', 'esm', name);
    const official = path.join(packageDir, 'dist', 'esm', name);
    const localHash = await fileDigest(bundled), officialHash = await fileDigest(official);
    if (localHash !== officialHash) throw new Error('Bundled binary differs from npm @ffmpeg/core@0.12.10: ' + name);
    manifest.binaries.push({ file: 'lib/ffmpeg12-core/esm/' + name, sha256: localHash, bytes: (await fs.stat(bundled)).size,
      matchesNpmPackage: '@ffmpeg/core@0.12.10', packageIntegrity: integrity });
  }

  await fs.cp(path.join(ROOT, 'third-party-licenses'), path.join(out, 'licenses'), { recursive: true });
  await fs.copyFile(path.join(ROOT, 'docs', 'third-party-sources.md'), path.join(out, 'source-audit.md'));
  await fs.copyFile(__filename, path.join(out, 'collect-third-party-sources.cjs'));
  const sourceMap = new Map(provenance.components.map(component => [component.repo, component.component]));
  const recipeDir = path.join(out, 'upstream', 'ffmpeg-wasm');
  let dockerfile = await fs.readFile(path.join(recipeDir, 'Dockerfile'), 'utf8');
  dockerfile = dockerfile.replace(/ADD https:\/\/github\.com\/([^\s#]+)\.git#[^\s]+ \/src/g, (_line, repo) => {
    const component = sourceMap.get(repo);
    if (!component) throw new Error('Unmapped Docker dependency: ' + repo);
    return `COPY upstream/${component}/ /src/`;
  });
  dockerfile = dockerfile.replace(/RUN git clone --recursive -b \$ZIMG_BRANCH https:\/\/github\.com\/sekrit-twc\/zimg\.git \/src/, 'COPY upstream/zimg/ /src/');
  dockerfile = dockerfile.replace(/^COPY build\//gm, 'COPY upstream/ffmpeg-wasm/build/');
  dockerfile = dockerfile.replace(/^COPY src\//gm, 'COPY upstream/ffmpeg-wasm/src/');
  // Seed the SDL2 port cache from the verified local source. Emscripten's
  // supported --use-port option still selects its normal source/build logic.
  dockerfile = dockerfile.replace('RUN embuilder build sdl2 sdl2-mt', [
    'COPY upstream/sdl2/ /tmp/local-sdl2/',
    'ENV EMCC_LOCAL_PORTS="sdl2=/tmp/local-sdl2"',
    'RUN embuilder build sdl2 sdl2-mt',
  ].join('\n'));
  if (/ADD https:\/\/|git clone/.test(dockerfile)) throw new Error('Unresolved network source in local-input Dockerfile');
  await fs.writeFile(path.join(out, 'Dockerfile.local-sources'), '# Derived local-input recipe; original retained under upstream/ffmpeg-wasm/Dockerfile.\n' + dockerfile);
  await fs.writeFile(path.join(out, '.dockerignore'), 'archives\nbinary-verification\nmanifest.json\n');
  await fs.writeFile(path.join(out, 'README-build.md'), `# Pinned FFmpeg source bundle\n\nThis bundle contains full pinned upstream trees, original licenses, original build scripts, recursive build-relevant submodules, a derived local-input Dockerfile, exact downloaded-archive SHA-256 values, and the official npm core package verified against the extension binaries.\n\nSource audit: source-audit.md. Machine evidence: manifest.json. This is a source candidate assembled from the upstream release recipe; no build was executed. The original binary's actual build cache, patched inputs, and exact input revisions are not independently attested.\n\n## Rebuild\n\nPrerequisites: Linux Docker Buildx/BuildKit and make; a locally available emscripten/emsdk:3.1.40 toolchain image; the image's Ubuntu package repositories for pkg-config/autoconf/automake/libtool/ragel/git. Toolchain and OS build tools are not downloaded by this collector. Source trees are local; package installation and Docker frontend/image acquisition may still use the network.\n\nOriginal recipe: upstream/ffmpeg-wasm/Dockerfile, Makefile, build/*.sh, src/bind/, src/fftools/. Original production command from that tree: make prd. That unmodified Dockerfile fetches upstream refs and therefore is evidence, not the pinned-input command.\n\nPinned local-input command from this bundle directory:\n\n\`\`\`sh\nsh restore-sources.sh\ndocker buildx build --file Dockerfile.local-sources --build-arg FFMPEG_ST=yes --build-arg EXTRA_CFLAGS='-O3 -msimd128' --output type=local,dest=./rebuilt .\nsha256sum rebuilt/dist/esm/ffmpeg-core.js rebuilt/dist/esm/ffmpeg-core.wasm\n\`\`\`\n\nThe derived recipe replaces upstream Git downloads with COPY of archived sources and supplies SDL2 through EMCC_LOCAL_PORTS, whose implementation is present in upstream/emscripten/tools/ports/__init__.py. The original recipe and all patches are preserved as separate files. Byte-for-byte reproduction has not been tested; any newly rebuilt artifact requires its own runtime/media validation before replacing the shipped binary. Exact-byte reproduction is not a separate automatic GPL requirement.\n\nThe ffmpeg.wasm testdata media-fixture submodule is not required by the production Docker recipe and new collection runs skip it. All other discovered submodules are recursively collected. Original source archives are authoritative; restore-sources.sh preserves symlinks when run on Linux. Windows extraction may omit WASI test symlinks. Archive integrity checks do not establish the original build's full provenance.\n\nTo distribute: provide this source bundle alongside the corresponding extension binary release and retain access to it; update the extension source link to that actual location. No upload or written source offer is created by this script.\n`);
  manifest.collectedDownloadBytesThisRun = totalDownloaded;
  manifest.sourceInputsCollected = true;
  manifest.localBuildRecipe = 'Dockerfile.local-sources';
  manifest.buildExecuted = false;
  const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  const restore = ['#!/bin/sh', 'set -eu', 'cd "$(dirname "$0")"', '# Restore original tar archives, preserving symlinks on Linux.'];
  for (const source of manifest.sources) {
    restore.push(`mkdir -p ${shellQuote(source.destination)}`);
    restore.push(`tar -xzf ${shellQuote(source.archive)} -C ${shellQuote(source.destination)} --strip-components=1`);
  }
  await fs.writeFile(path.join(out, 'restore-sources.sh'), restore.join('\n') + '\n');
  await save();
  const bundleName = 'Downloader-1.0.1-third-party-sources.tar.gz';
  const bundle = path.join(path.dirname(out), bundleName);
  await command(tar, ['-czf', bundle, '-C', path.dirname(out), path.basename(out)]);
  const bundleInfo = { file: path.basename(bundle), bytes: (await fs.stat(bundle)).size, sha256: await fileDigest(bundle), buildExecuted: false };
  await fs.writeFile(bundle + '.json', JSON.stringify(bundleInfo, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ ...bundleInfo, components: manifest.sources.length, downloadedBytes: totalDownloaded }) + '\n');
}

main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
