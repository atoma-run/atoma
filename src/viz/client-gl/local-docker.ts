import { strToU8, zip, type Zippable } from 'fflate';
import { localDockerSchema, LOCAL_DOCKER_MAX_BYTES, DOCKER_DESKTOP_URL, type LocalDocker } from '../../contracts/localDocker.js';
import type { WorkspaceIndex } from '../../contracts/workspaceBrowser.js';

export interface LocalDockerState {
  config: LocalDocker | null;
  step?: 'about' | 'prepare' | 'launch' | 'use';
  status: 'loading' | 'ready' | 'invalid' | 'downloading' | 'downloaded' | 'failed';
}

export function localDockerFiles(config: LocalDocker, index: WorkspaceIndex) {
  const parsed = localDockerSchema.parse(config);
  if (index.status !== 'delivered') throw new Error('A completed delivery is required');
  const files = parsed.files.map(path => {
    const entry = index.files.find(file => file.path === path);
    if (!entry) throw new Error('A declared installation file is unavailable');
    return entry;
  });
  if (files.reduce((sum, file) => sum + file.size, 0) > LOCAL_DOCKER_MAX_BYTES) throw new Error('Installation package is too large');
  return files;
}

/** No shell fragments come from the delivery. All interpolated values are schema-checked. */
export function localDockerLaunchers(raw: LocalDocker, projectId: string, runId: string): Record<string, string> {
  const config = localDockerSchema.parse(raw);
  if (!/^[a-f\d-]{36}$/i.test(projectId) || !/^[a-f\d-]{36}$/i.test(runId)) throw new Error('Invalid package identity');
  const name = `atoma-${projectId.toLowerCase()}`;
  const shell = (stop: boolean) => `#!/bin/bash
set -euo pipefail
export PATH="$HOME/.docker/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/app"
fail() { echo "$1"; read -r -p "Press Enter to close."; exit 1; }
command -v docker >/dev/null || fail "Install Docker Desktop first: ${DOCKER_DESKTOP_URL}"
docker info >/dev/null 2>&1 || fail "Open Docker Desktop, wait until it is running, then try again."
docker compose version >/dev/null 2>&1 || fail "Docker Compose is required. Update Docker Desktop."
export ATOMA_LOCAL_DATA_DIR="$HOME/.atoma/apps/${projectId}"
export ATOMA_LOCAL_UID="$(id -u)" ATOMA_LOCAL_GID="$(id -g)"
mkdir -p "$ATOMA_LOCAL_DATA_DIR"
chmod 700 "$ATOMA_LOCAL_DATA_DIR"
docker compose --project-name '${name}' -f '${config.composeFile}' ${stop ? 'stop' : 'up -d --build --wait --wait-timeout 120'} || fail "Docker could not ${stop ? 'stop' : 'start'} this project. Read the message above; check for a port already in use."
${stop ? 'echo "Stopped. Project data was preserved."' : `open '${config.appUrl}'`}
`;
  const windows = (stop: boolean) => `@echo off\r
setlocal\r
cd /d "%~dp0app"\r
where docker >nul 2>&1\r
if errorlevel 1 (echo Install Docker Desktop first: ${DOCKER_DESKTOP_URL}& pause& exit /b 1)\r
docker info >nul 2>&1\r
if errorlevel 1 (echo Open Docker Desktop, wait until it is running, then try again.& pause& exit /b 1)\r
docker compose version >nul 2>&1\r
if errorlevel 1 (echo Update Docker Desktop to include Docker Compose.& pause& exit /b 1)\r
set "ATOMA_LOCAL_DATA_DIR=%LOCALAPPDATA%/Atoma/apps/${projectId}"\r
set "ATOMA_LOCAL_UID=1000"\r
set "ATOMA_LOCAL_GID=1000"\r
if not exist "%ATOMA_LOCAL_DATA_DIR%" mkdir "%ATOMA_LOCAL_DATA_DIR%"\r
docker compose --project-name "${name}" -f "${config.composeFile}" ${stop ? 'stop' : 'up -d --build --wait --wait-timeout 120'}\r
if errorlevel 1 (echo Docker could not ${stop ? 'stop' : 'start'} this project. Check the message above and whether a port is in use.& pause& exit /b 1)\r
${stop ? 'echo Stopped. Project data was preserved.' : `start "" "${config.appUrl}"`}\r
`;
  return {
    'Start.command': shell(false), 'Stop.command': shell(true),
    'Start.cmd': windows(false), 'Stop.cmd': windows(true),
    'START-HERE.txt': `Run this project on your computer\n\n${config.onboarding ? `Why this application runs locally: ${config.onboarding.whyLocal}\n\nWhat runs: ${config.onboarding.runsOnComputer}\n\nData and connections: ${config.onboarding.dataAndConnections}\n\n` : ''}1. Install and open Docker Desktop: ${DOCKER_DESKTOP_URL}\n2. Extract the entire ZIP to a permanent folder.\n3. On macOS, open Start.command; on Windows, open Start.cmd. The first build can take several minutes.\n4. Open ${config.appUrl}\n\n${config.verificationUrl ? `If the application asks for website verification, open ${config.verificationUrl} and complete it yourself, then resume in the application.\n\n` : ''}Keep Docker running while you use the project. Stop.command / Stop.cmd stops only this project and retains its data. Different projects use separate Compose names and data directories. If a port is occupied, stop the conflicting project before retrying.\n\nDownloaded code runs locally when you choose Start. Atoma does not remotely start Docker or monitor this installation. Profiles and local data are not uploaded by this installer. Application-specific synchronization is separate.\n\nUpdates: stop the existing version, extract the new ZIP to a separate folder, then start it. Keep the old folder for rollback; both versions use the same project data directory. Do not run both simultaneously.\n\n${config.onboarding ? `Getting started:\n${config.onboarding.firstSteps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n\n` : ''}Project: ${projectId}\nSaved delivery: ${runId}\n`,
  };
}

export async function localDockerPackage(config: LocalDocker, index: WorkspaceIndex, projectId: string,
  read: (path: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  const files = localDockerFiles(config, index);
  const archive: Zippable = {};
  for (const file of files) {
    const bytes = await read(file.path);
    if (bytes.length !== file.size) throw new Error('Installation file differs from saved inventory');
    archive[`app/${file.path}`] = bytes;
  }
  for (const [name, content] of Object.entries(localDockerLaunchers(config, projectId, index.runId))) {
    archive[name] = [strToU8(content), { os: 3, attrs: (name.endsWith('.command') ? 0o100755 : 0o100644) << 16 }];
  }
  return new Promise((resolve, reject) => { zip(archive, { level: 6 }, (error, data) => error ? reject(error) : resolve(data)); });
}
