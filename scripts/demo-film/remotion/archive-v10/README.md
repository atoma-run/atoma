# Atoma — A project that evolves

Revision 10: **3:29**, 1920 × 1080, 30 fps. English narration and visible text.

## Preview and render

Use Node 24.20.0:

```sh
npm ci
npm run studio
npm run render
```

The fifteen named scenes live in `src/business.tsx`. `src/index.tsx` registers the composition, and `src/timing-v7.json` owns the frame offsets and lengths. All media needed for rendering is included in `public/`; no live account is required. Remotion may download its render browser on first use.

The output of `npm run render` is a ProRes 4444 editing master, rendered through lossless PNG frames. This avoids the default JPEG intermediate (quality 80). The delivered MP4 additionally normalizes narration to -16 LUFS with a -1.5 dB true-peak target and enables fast start:

```sh
ffmpeg -i atoma-presentation-master.mov -c:v libx264 -crf 10 -preset slow -pix_fmt yuv420p -af loudnorm=I=-16:TP=-1.5:LRA=11 -ar 48000 -c:a aac -b:a 192k -movflags +faststart atoma-presentation-final.mp4
```

## Story and source boundaries

The opening introduces Northstar with “Imagine a distributor…”. Northstar Supply Operations is a fictional business scenario and a locally authored interactive demo. No Atoma execution, completed run, acceptance result, or measured project cost is claimed for Northstar. Run 01 and Run 02 express the proposed project requests and the resulting product progression in the story. There is no on-screen illustrative badge.

- **Run 01 / Version 1:** reconcile stock, sales and supplier files; match SKUs; inspect stock positions and shortage risks.
- **Run 02 / Version 2:** extend the same workspace with demand and supplier-delay scenarios, purchase proposals, a budget, finance approval and an activity trail.
- The local browser interactions were captured from `business-demo/index.html`. The demo includes inventory filters, detail drawers, version switching, scenario controls, approval state and CSV export. Its data and scenario calculations are synthetic; it is not an inventory forecasting engine or a production backend.

The Atoma settings and cost screenshots are actual authenticated production captures from **26 October 2026**:

- Organisation model defaults: actual L1/L2/L3 selectors, with no fabricated selected values.
- Atoma MCP connection guide: actual endpoint and Codex setup instructions. Credentials and private access tokens are excluded.
- Project cost breakdown: the Atoma view for project `07864f7c-d8f2-4023-9fca-afd8a7a51e52`, Attica property flipping collector. Only the Atoma cost panel is used; no Attica application interface or scraped listings appear. The snapshot says 152 runs have readable traces. These are API-equivalent estimates, not an invoice or a Northstar cost claim.

Production source: https://atoma.run/#/projects/07864f7c-d8f2-4023-9fca-afd8a7a51e52

Model availability depends on credentials and deployment. The models scene presents per-tier selection and lists the available providers on screen, with Ollama highlighted. Narration refers collectively to all major model providers and explicitly mentions local models through Ollama, without reading the provider list. Local models are described as a **self-hosted** option. MCP compatibility is stated for compatible clients; client names in the connection guide are interface context. Product features were checked against the current repository and production interface. Acceptance and deployment remain explicit choices.

## Recorded run added in revision 6

The new sequence shows the actual production run **ForgeFlow — Verify tests, server split, and OEE checks**, dated 7 October 2026:

https://atoma.run/#/runs/2f63b887-3894-4560-811b-670aec78bd8c

The run was located using the production Atoma MCP. All 105 summary events were read to the end. The displayed final review is event `8952df6d-ddc1-4641-9388-5d57737b2aca`. Its explanation mentions 13 passing domain assertions, HTTP behavior, the OEE calculation, the order lifecycle, reload persistence, Reset removal, and successful corrected probes. The earlier rejection remains part of the trace; the film does not imply there were no intermediate failures.

The browser capture uses All event types and All roles, with three positions along the real timeline: supervision depth, routing, planning, trust and execution; recipe learning and the initially rejected review; then result validation, success recording and the approved final review. The recorded final review stays open in the right panel. This sequence was recaptured on 27 October 2026. The cursor is parked outside the capture after each scroll. In revision 10, the second shot recomposes that exact review text at native output resolution. The left timeline and right panel are cropped from the same screen recording; only the navigation chrome and minimap/cursor gutter are omitted. No run content or result is fabricated or translated. Narration describes the interface generically; private run results were not sent to the TTS service.

The cost panel was recaptured with the pointer moved out of the crop, and the film now places 42 pixels of vertical and 59 pixels of horizontal padding around it. Its data is unchanged from revision 5. The surrounding card uses #112834. Revision 10 renders the cost chart and labels directly at output resolution, preserving the snapshot values. The provider list is shown but not read aloud on the model-choice slide; the authentic model names remain in the requested production cost breakdown.

## Coordination animation

The approved Jitter sequence explains the generic three-tier process, not a specific run trace. Its original 720p resolution and Jitter watermark are preserved in the 1080p film.

Editable source: https://jitter.video/file/?id=t6ngBQeHcUDHGu2isTfH0RMg

## Narration and timing

Narration source: `narration-v7.json`. Engine: Microsoft Edge TTS, `en-US-AndrewNeural`, natural rate, 0.22-second pauses between sentences. Regenerating speech sends only the narration text to the TTS service; Python `edge-tts` and FFmpeg are required:

```sh
python narrate-v7.py public/voice-v7
python retime-v7.py
```

Each scene starts speech after 14 frames. After speech, the picture remains for about 1.05 seconds (1.5 on the closing scene). Normal inter-scene silence is approximately 1.5 seconds, with no seven-second hold. Navigation cuts and focused zooms provide time to read without long empty pauses.

## Explore the business demo

The editable bundle includes `business-demo/index.html`. Open it directly or serve it locally:

```sh
python3 -m http.server 3099 --bind 127.0.0.1 --directory business-demo
```

Then visit http://127.0.0.1:3099 . Version 1 and Version 2 can be explored with the switch at the top. The demo never sends real purchase orders or writes to Atoma production.

## Revision 10 — sharp close-ups and consistent backgrounds

The enlarged review is now native text, transcribed verbatim from the actual production review identified above. Its layout follows the recorded panel, and both the content and padding share #112834. The cost panel uses native text and an SVG chart with the exact values from the existing production screenshot. These two editorial close-ups are recomposed from recorded content; they are not new screenshots or new run results. The original captures remain in the editable bundle as evidence.

The real scrolling timeline and Northstar navigation clips are rebuilt from their original captured frames at H.264 CRF 8, instead of transcoding the previously encoded clips. All final frames use PNG, and the distribution MP4 uses H.264 CRF 10. The ProRes 4444 master preserves full chroma detail for further editing. Duration and narration are unchanged.

Resolution limits: the live navigation sources were captured around 1920 pixels wide; the model and MCP settings remain original production crops. The approved Jitter animation remains its original 720p export. This revision does not invent detail by claiming a 4K recapture.
