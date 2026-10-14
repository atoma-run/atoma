import type { LocalDockerState } from './local-docker.js';

export type ApplicationGuideItem =
  | { kind: 'heading' | 'text' | 'status'; text: string }
  | { kind: 'action'; text: string; id: string; disabled: boolean };

/** The canvas and accessible twin share content, order and available actions. */
export function applicationGuide(local: LocalDockerState, t: (key: string) => string): ApplicationGuideItem[] {
  const items: ApplicationGuideItem[] = [];
  const line = (key: string, kind: 'heading' | 'text' | 'status' = 'text') => items.push({ kind, text: t(key) });
  const action = (id: string, key: string, disabled = false) => items.push({ kind: 'action', id, text: t(key), disabled });
  const detail = (key: string, text: string) => { line(key, 'heading'); items.push({ kind: 'text', text }); };
  const step = local.step ?? 'about';
  const config = local.config;
  if (!config) {
    line(`localDocker.status.${local.status}`, 'status');
    if (local.status === 'invalid') action('project.section.conversation', 'application.help');
    return items;
  }
  line(`application.step.${step}`, 'heading');
  if (step === 'about') {
    if (config.onboarding) {
      detail('application.why', config.onboarding.whyLocal);
      detail('application.runs', config.onboarding.runsOnComputer);
      detail('application.data', config.onboarding.dataAndConnections);
    } else line('application.legacy');
    action('localDocker.step.prepare', 'application.setup');
    action('localDocker.step.use', 'application.alreadyInstalled');
  } else if (step === 'prepare') {
    line('application.dockerExplanation');
    line('application.dockerInstructions');
    action('localDocker.install', 'localDocker.install');
    action('localDocker.step.launch', 'application.dockerOpened');
    action('localDocker.step.about', 'application.back');
  } else if (step === 'launch') {
    line('application.downloadInstructions');
    action('localDocker.download', 'localDocker.download', local.status === 'downloading');
    if (local.status !== 'ready') line(`localDocker.status.${local.status}`, 'status');
    line('application.launchInstructions');
    line('application.launchWait');
    action('localDocker.step.use', 'application.startOpened');
    action('localDocker.step.prepare', 'application.back');
  } else {
    action('localDocker.open', 'application.open');
    line('application.openHelp');
    if (config.onboarding) {
      line('application.firstSteps', 'heading');
      config.onboarding.firstSteps.forEach((text, i) => items.push({ kind: 'text', text: `${i + 1}. ${text}` }));
    }
    if (config.verificationUrl) {
      line('application.verificationHelp');
      action('localDocker.verify', 'localDocker.verify');
    }
    line('localDocker.localOnly');
    line('application.restart');
    action('localDocker.step.launch', 'application.setupHelp');
    action('localDocker.step.about', 'application.about');
    action('project.section.conversation', 'application.help');
  }
  return items;
}
