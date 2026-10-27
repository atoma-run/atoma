import React from 'react';

// Verbatim production review, event 8952df6d-ddc1-4641-9388-5d57737b2aca.
// Native text avoids enlarging the original 518-pixel screenshot.
export const reviewBackground = '#112834';
export function ReviewPanel() {
  const box: React.CSSProperties = {background:'#172e3f',border:'1px solid #345263',borderRadius:14,padding:'22px 24px'};
  return <div style={{background:reviewBackground,color:'#dce8ef',fontFamily:'Arial, sans-serif',fontSize:27,lineHeight:1.42}}>
    <div style={{fontSize:31,fontWeight:700,color:'#e6cf48',marginBottom:25}}>Reviewing the delivery against the request</div>
    <div style={{fontSize:25,marginBottom:30}}>This is Atoma's recorded final review of the delivery. It is separate from your acceptance or publication.</div>
    <div style={{...box,marginBottom:16}}>
      <div style={{color:'#9eb9c9',fontWeight:700,fontSize:25,marginBottom:12}}>What happened</div>
      <div>The recorded final review approved this delivery</div>
    </div>
    <div style={box}>
      <div style={{color:'#9eb9c9',fontWeight:700,fontSize:25,marginBottom:12}}>Explanation</div>
      <div>Current file read-back and observed executions support the requested restructuring, 13 passing domain assertions, HTTP behavior, OEE calculation, responsive order lifecycle, reload persistence, and Reset removal. A failed intermediate probe was superseded by successful corrected probes.</div>
    </div>
  </div>;
}
