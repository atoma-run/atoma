import { z } from 'zod';

/** Explicit delivery capability; Dockerfiles alone do not establish local usability. */
export const LOCAL_DOCKER_FILE = 'atoma.local.json';
export const LOCAL_DOCKER_MAX_BYTES = 64 * 1024 * 1024;
const filePath = z.string().max(240).regex(/^[A-Za-z0-9_. -]+(?:\/[A-Za-z0-9_. -]+)*$/)
  .refine(value => value.split('/').every(part => part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    && !/^(\.env(?:\..*)?|\.git|node_modules|\.local-browser|browser-state|browser-demo-state|profiles?|cookies|login data|web data|local state)$/i.test(part)));
const localUrl = z.string().max(300).regex(/^http:\/\/127\.0\.0\.1:\d{1,5}(?:\/[A-Za-z0-9_./?=&-]*)?$/)
  .refine(value => { try { const port = Number(new URL(value).port); return port >= 1024 && port <= 65535; } catch { return false; } });
export const localDockerSchema = z.object({
  version: z.literal(1),
  runtime: z.literal('docker-compose'),
  composeFile: filePath.refine(value => !value.includes('/')),
  appUrl: localUrl,
  verificationUrl: localUrl.optional(),
  // A source-only allowlist: never implicitly package a workspace's browser profile.
  files: z.array(filePath).min(1).max(2_000),
}).strict().superRefine((value, ctx) => {
  if (!value.files.includes(value.composeFile) || new Set(value.files).size !== value.files.length) {
    ctx.addIssue({ code: 'custom', message: 'Compose must be included exactly once; duplicate paths are forbidden' });
  }
  if (new Set(value.files.map(file => file.toLowerCase())).size !== value.files.length) {
    ctx.addIssue({ code: 'custom', message: 'Paths must be distinct on case-insensitive filesystems' });
  }
  const names = new Set(value.files.map(file => file.toLowerCase()));
  if (value.files.some(file => {
    const parts = file.toLowerCase().split('/');
    return parts.slice(0, -1).some((_, index) => names.has(parts.slice(0, index + 1).join('/')));
  })) ctx.addIssue({ code: 'custom', message: 'A file cannot also be a directory' });
});
export type LocalDocker = z.infer<typeof localDockerSchema>;
export const DOCKER_DESKTOP_URL = 'https://www.docker.com/products/docker-desktop/';
