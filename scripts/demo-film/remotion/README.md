# Atoma film — revision 11

English film, 1920 × 1080, 30 fps, 239.73 seconds. Run `npm ci`, then `npm run studio`. Export with `npm run render` for a ProRes 4444 master with PNG intermediate frames.

Approved distribution video: [Atoma presentation v11](../../../screenshots/demo-film-v11/atoma-presentation-v11.mp4). The multi-gigabyte ProRes master is retained locally and excluded from Git.

## Current sources

- `src/business.tsx`: composition and scene layout.
- `src/ProductionTimeline.tsx`: sharp timeline and model settings panels.
- `src/production-events-v11.json`: selected real events with original event IDs and UTC timestamps, from the 105-event ForgeFlow trace.
- `src/ReviewPanel.tsx`: verbatim final review.
- `src/CostPanel.tsx`: production cost snapshot rendered as native text and SVG.
- `narration-v11.json`, `public/voice-v11`, `src/timing-v11.json`: English narration and timing.

## Provenance and capture limits

The timeline is an editorial rendering of selected recorded production events, in chronological order. Its right-hand review preserves the actual recorded explanation. It is not a newly recorded browser video. The settings panel is a faithful native-text recreation of the original production crop. The MCP scene is a purpose-built connection explainer. No new run was started and no production result was fabricated.

A fresh 1920 CSS-pixel / DPR 2 browser capture was attempted on 27 October 2026. Chrome repeatedly closed during native interaction; no usable high-resolution recapture was obtained. This revision replaces the affected low-resolution panels with native text/vector layouts instead of upscaling them. Original production captures remain under public/v5, v6 and v10. Source screenshots and videos must not be described as newly captured in 4K.

Northstar is a fictional business product introduced with “Imagine”. Its two versions demonstrate a possible project progression, not an executed Atoma run. Its existing navigation footage is retained. The original Jitter coordination animation remains 720p; no claim that all footage is native 4K.

## Audit and optimization

Comparison reruns use `rerunOf` and tier `models`, retaining the original goal, acceptance criteria and recorded seed. Imported projects are not eligible, and retained starting context is required. The film does not promise deterministic results or guaranteed savings. Recorded traces, checks and files support auditing; a comparison rerun is a new execution, not a blind replay of arbitrary tool commands.

Only generic narration is sent to Edge TTS. Regenerate with `python narrate-v11.py public/voice-v11` and `python retime-v11.py`. Speech begins after 14 frames, with about 1.05 seconds after narration.

Previous revision notes are preserved under archive-v10.
