import type { PreviewMessages, PreviewToolbarOptions } from '@open-file-viewer/core';
import en from '../client/locales/en.json' with { type: 'json' };

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** Pass every configurable reader string through the client's catalog. */
export function filePreviewTranslations(t: Translate) {
  const group = (name: string) => Object.fromEntries(Object.entries(en)
    .filter(([key]) => key.startsWith(`fileViewer.${name}.`))
    .map(([key, source]) => {
      // The reader substitutes single-brace tokens after i18next resolves the
      // template. Preserve those tokens through our double-brace interpolation.
      // i18next therefore never sees a number and cannot pluralise: word a
      // count so it reads for any value ("Lines: {{count}}", not "… lines").
      const vars = Object.fromEntries([...source.matchAll(/\{\{(\w+)\}\}/g)]
        .map(([, token]) => [token!, `{${token}}`]));
      return [key.slice(`fileViewer.${name}.`.length), t(key, vars)];
    }));
  const messages: Partial<PreviewMessages> = {
    ...group('message'),
    loading: t('workspace.loading'), unsupportedTitle: t('workspace.unsupported'),
    downloadFile: t('workspace.download'), textCopy: t('launch.copy'), textCopied: t('launch.copied'),
  };
  const toolbar: PreviewToolbarOptions = { labels: group('labels'), titles: group('titles') };
  return { messages, toolbar };
}
