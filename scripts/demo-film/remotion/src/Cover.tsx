import React from 'react';
import {AbsoluteFill, CanvasImage, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';

/** Fully visible at frame zero so embedded video players have a useful poster. */
export function Cover() {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return <AbsoluteFill style={{
    background: 'radial-gradient(ellipse at 85% 10%, #193a3d, #071018 65%)',
    color: '#f4f7f4', fontFamily: 'Arial, sans-serif', padding: '100px 120px',
    opacity: interpolate(frame, [1.8 * fps, 2.2 * fps], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
  }}>
    <div style={{position: 'absolute', inset: 0, opacity: 0.09, backgroundImage: 'radial-gradient(#b4c8c6 1px, transparent 1px)', backgroundSize: '48px 48px'}}/>
    <div style={{display: 'flex', alignItems: 'center', gap: 24, fontSize: 66, fontWeight: 700, letterSpacing: -2}}>
      <CanvasImage src={staticFile('media/atoma.svg')} style={{width: 96, height: 96}}/>atoma
    </div>
    <div style={{marginTop: 98, color: '#b4e6cd', fontSize: 25, letterSpacing: 4}}>THREE-TIER AGENT ORCHESTRATION</div>
    <h1 style={{margin: '30px 0', fontSize: 112, lineHeight: 1.06, letterSpacing: -5}}>Coordinated AI.<br/>Continuous progress.</h1>
    <div style={{fontSize: 32, color: '#9eafb6', marginTop: 12}}>From a business goal to a project that keeps evolving.</div>
    <div style={{position: 'absolute', left: 120, right: 120, bottom: 100, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #2b424a', paddingTop: 34}}>
      <div style={{display: 'flex', gap: 54, fontSize: 25, color: '#b4e6cd'}}><span>Plan & delegate</span><span>Verify & deliver</span><span>Audit & optimize</span></div>
      <div style={{fontSize: 26, color: '#9eafb6'}}>atoma.run</div>
    </div>
  </AbsoluteFill>;
}
