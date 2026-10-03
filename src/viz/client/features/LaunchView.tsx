import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import {
  Box,
  Button,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../data-api.js';
import { useI18n } from '../i18n.js';
import { launchCommand } from '../launch-utils.js';
import { CodeBlock, ErrorPane, LoadingPane } from '../shared.js';
import type { GoalGuidance } from '../types.js';

export function LaunchView({ refreshKey }: { refreshKey: number }) {
  const { t } = useI18n();
  const [guidance, setGuidance] = useState<GoalGuidance | undefined>();
  const [goal, setGoal] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setLoading(true);
    void api.goalGuidance()
      .then((payload) => {
        setGuidance(payload.guidance);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const command = useMemo(() => launchCommand(guidance, goal), [goal, guidance]);
  if (loading) return <LoadingPane />;
  if (error) return <Box sx={{ p: 2 }}><ErrorPane error={error} /></Box>;

  return (
    <Box sx={{ p: 2, maxWidth: 960, mx: 'auto' }}>
      <Paper sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6">{t('nav.launch')}</Typography>
            <Typography color="text.secondary">{t('launch.help')}</Typography>
          </Box>
          {guidance ? (
            <>
              <Typography color="text.secondary">
                {t('launch.guidance') === 'launch.guidance' ? guidance.help : t('launch.guidance')}
              </Typography>
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('launch.examples')}</Typography>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {guidance.examples.map((example) => (
                    <Button key={example} size="small" variant="outlined" onClick={() => setGoal(example)}>
                      {example}
                    </Button>
                  ))}
                </Stack>
              </Box>
            </>
          ) : null}
          <TextField
            label={t('launch.goal')}
            placeholder={t('launch.goal.placeholder')}
            value={goal}
            onChange={(event) => {
              setGoal(event.target.value);
              setCopied(false);
            }}
            multiline
            minRows={4}
          />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t('launch.command')}</Typography>
            <CodeBlock>{command || t('launch.empty')}</CodeBlock>
          </Box>
          <Button
            variant="contained"
            startIcon={<ContentCopyIcon />}
            disabled={!command}
            onClick={() => {
              void navigator.clipboard.writeText(command).then(() => setCopied(true));
            }}
            sx={{ alignSelf: 'flex-start' }}
          >
            {copied ? t('launch.copied') : t('launch.copy')}
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
