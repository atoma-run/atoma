import React from 'react';

// Exact values from the authenticated production snapshot of 26 October 2026.
// Draw the chart and labels at output resolution instead of enlarging a 400px crop.
const groups = [
  {name:'L1 · Molecules · 2 models',value:'$109.92 · 34.9%',color:'#71cd9d',models:[['gpt-5.6-luna','$73.36 · 23.3%','#71cd9d',73.36],['haiku','$36.55 · 11.6%','#47856a',36.55]]},
  {name:'L2 · Cells · 2 models',value:'$71.67 · 22.8%',color:'#ffac42',models:[['gpt-5.6-terra','$70.74 · 22.5%','#ffac42',70.74],['sonnet','$0.93 · 0.3%','#a96928',0.93]]},
  {name:'L3 · Tissues · 2 models',value:'$130.55 · 41.5%',color:'#7c83ff',models:[['gpt-6-astra','$128.76 · 40.9%','#7c83ff',128.76],['opus','$1.79 · 0.6%','#4c559a',1.79]]},
];
export function CostPanel(){
  let offset=0;
  return <div style={{fontFamily:'Arial, sans-serif',color:'#dce8ef'}}>
    <div style={{fontSize:21,fontWeight:700,color:'#9eb9c9',marginBottom:10}}>API-eq. cost by model tier</div>
    <svg viewBox="0 0 650 340" width="650" height="290">
      <g transform="translate(325 170) rotate(-90)">
        {groups.flatMap(g=>g.models).map(([name,,color,n])=>{
          const fraction=Number(n)/314.57, start=offset; offset+=fraction;
          return <circle key={String(name)} r="126" fill="none" stroke={String(color)} strokeWidth="58" pathLength="1" strokeDasharray={`${Math.max(0,fraction-.003)} ${1-Math.max(0,fraction-.003)}`} strokeDashoffset={-start}/>;
        })}
      </g>
      <text x="325" y="164" textAnchor="middle" fill="#dce8ef" fontSize="32" fontWeight="700">$314.57</text>
      <text x="325" y="195" textAnchor="middle" fill="#9eb9c9" fontSize="23">total</text>
    </svg>
    {groups.map(g=><div key={g.name} style={{marginTop:10}}>
      <div style={{display:'flex',alignItems:'center',gap:12,fontSize:23,marginBottom:10}}><span style={{width:16,height:16,borderRadius:3,background:g.color}}/>{g.name}<span style={{marginLeft:'auto',color:'#9eb9c9',fontSize:22}}>{g.value}</span></div>
      {g.models.map(([name,value,color])=><div key={String(name)} style={{display:'flex',alignItems:'center',gap:12,paddingLeft:30,fontSize:22,color:'#9eb9c9',marginBottom:6}}><span style={{width:12,height:12,borderRadius:2,background:String(color)}}/>{name}<span style={{marginLeft:'auto'}}>{value}</span></div>)}
    </div>)}
  </div>;
}
