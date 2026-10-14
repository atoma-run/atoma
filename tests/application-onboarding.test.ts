// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { localDockerSchema } from '../src/contracts/localDocker.js';
import { ApplicationAccessible } from '../src/viz/client-gl/ApplicationAccessible.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import { localDockerLaunchers } from '../src/viz/client-gl/local-docker.js';

const legacy = { version: 1, runtime: 'docker-compose', composeFile: 'compose.yaml',
  appUrl: 'http://127.0.0.1:3310/', files: ['compose.yaml'] };
const onboarding = { whyLocal: 'Read files selected on your computer.', runsOnComputer: 'A file organiser.',
  dataAndConnections: 'Selected files stay on disk. Updates require internet access.', firstSteps: ['Choose a folder.'] };
const t = (key: string) => translate('en', key);
afterEach(cleanup);

it('preserves older immutable descriptors and rejects incomplete or unbounded explanations', () => {
  expect(localDockerSchema.parse(legacy).onboarding).toBeUndefined();
  expect(localDockerSchema.parse({ ...legacy, onboarding }).onboarding).toEqual(onboarding);
  for (const value of [{}, { ...onboarding, whyLocal: ' ' }, { ...onboarding, firstSteps: [] },
    { ...onboarding, dataAndConnections: 'x'.repeat(601) }, { ...onboarding, runCommand: 'sh unknown' }]) {
    expect(localDockerSchema.safeParse({ ...legacy, onboarding: value }).success).toBe(false);
  }
});
it('renders delivery prose as text, keeps the platform in charge of actions and carries prose into the offline guide', () => {
  const config = localDockerSchema.parse({ ...legacy, onboarding: { ...onboarding, whyLocal: '<img src=x onerror=alert(1)>' } });
  const onActivate = vi.fn();
  const { container, rerender } = render(createElement(ApplicationAccessible, { local: { config, status: 'ready' }, t, onActivate }));
  expect(screen.getByText(config.onboarding!.whyLocal)).toBeVisible();
  expect(container.querySelector('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Guide me through setup' }));
  expect(onActivate).toHaveBeenCalledWith('localDocker.step.prepare');
  rerender(createElement(ApplicationAccessible, { local: { config, status: 'downloading', step: 'launch' }, t, onActivate }));
  expect(screen.getByRole('button', { name: 'Download my application' })).toBeDisabled();
  rerender(createElement(ApplicationAccessible, { local: { config, status: 'ready', step: 'use' }, t, onActivate }));
  expect(screen.getByText('1. Choose a folder.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Open website verification' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open my application' }));
  expect(onActivate).toHaveBeenLastCalledWith('localDocker.open');
  const files = localDockerLaunchers(config, 'a'.repeat(36), 'b'.repeat(36));
  expect(files['START-HERE.txt']).toContain(onboarding.dataAndConnections);
  expect(files['START-HERE.txt']).toContain('1. Choose a folder.');
  expect(files['Start.command']).not.toContain(config.onboarding!.whyLocal);
});
it('does not invent an explanation for older deliveries or offer execution for invalid configurations', () => {
  const { rerender } = render(createElement(ApplicationAccessible, { local: { config: localDockerSchema.parse(legacy), status: 'ready' }, t }));
  expect(screen.getByText(/does not yet include an explanation/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'I already set this up' })).toBeEnabled();
  rerender(createElement(ApplicationAccessible, { local: { config: null, status: 'invalid' }, t }));
  expect(screen.queryByRole('button', { name: 'Open my application' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Go to the project conversation' })).toBeEnabled();
});
