/* global document, getComputedStyle, requestAnimationFrame, ScrollShadows, stopShadows */
import assert from 'node:assert/strict';
import { build } from 'esbuild';

/** Real DOM geometry, native keyboard/wheel and lifecycle of the shared decorator. */
export async function verifyNativeScrollShadows(browser) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 768, height: 700 });
    await page.setContent(`<style>
      body { margin:24px; background:#132a36; color:#dce7f0; font:16px system-ui; }
      section { display:grid; grid-template-columns:180px 180px; gap:24px; }
      .pane { height:140px; overflow:auto; padding:16px; border:1px solid #516879; border-radius:8px; }
      section > * { margin-top:8px; }
      p { height:50px; margin:0; background:#1c3542; }
      pre { margin:0; background:#1c3542; }
      textarea { height:140px; width:160px; padding:12px; resize:both; }
      #fixed { position:fixed; left:440px; top:24px; width:180px; }
    </style><section id="grid"><div id="panel" class="pane"><div id="content">${'<p>Scrollable content</p>'.repeat(12)}</div></div>
      <div id="fit" class="pane"><p>Fits</p></div>
      <div id="horizontal" class="pane"><pre>${'Wide content '.repeat(20)}</pre></div>
      <div id="rtl" class="pane" dir="rtl"><pre>${'RTL '.repeat(100)}</pre></div>
      <textarea id="input">${'Long text\n'.repeat(80)}</textarea>
      </section><div id="fixed" class="pane"><div>${'<p>Fixed panel</p>'.repeat(10)}</div></div>`);
    const bundled = await build({ entryPoints: ['src/viz/client-gl/scroll-shadows.ts'], bundle: true,
      write: false, format: 'iife', globalName: 'ScrollShadows', platform: 'browser' });
    const original = await page.$eval('#panel', el => [el.offsetWidth, el.offsetHeight, el.scrollHeight, el.getBoundingClientRect().x]);
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    await page.evaluate(() => { globalThis.stopShadows = ScrollShadows.installScrollShadows(document, '.pane,textarea'); });
    const edges = async (id, expected) => {
      await page.waitForFunction(({ id, expected }) => {
        const el = document.getElementById(id);
        const overlay = [...el.parentElement.children].find(node =>
          node.classList.contains('atoma-scroll-shadows') &&
          Math.abs(node.getBoundingClientRect().left - el.getBoundingClientRect().left - el.clientLeft) < 1 &&
          Math.abs(node.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop) < 1);
        if (!overlay) return false;
        return Object.entries(expected).every(([edge, visible]) =>
          !overlay.querySelector(`[data-edge="${edge}"]`).hidden === visible);
      }, {}, { id, expected });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    await edges('panel', { top:false, bottom:true, left:false, right:false });
    assert.deepEqual(await page.$eval('#panel', el => [el.offsetWidth, el.offsetHeight, el.scrollHeight, el.getBoundingClientRect().x]), original, 'Decoration must not change layout or scroll extent');
    await edges('fit', {top:false,bottom:false,left:false,right:false});
    await edges('fixed', {top:false,bottom:true});
    await page.evaluate(() => {
      const grid=document.querySelector('#grid');
      grid.append(document.querySelector('#fixed'));
      grid.style.transform='perspective(1000px) rotateY(8deg) scale(.9)';
    });
    await page.waitForFunction(() => document.querySelectorAll('#grid > .atoma-scroll-shadows').length === 6);
    // Compare projected interiors rather than untransformed CSS dimensions.
    await page.waitForFunction(() => ['panel','fixed'].every(id => {
      const el=document.getElementById(id), r=el.getBoundingClientRect();
      return [...el.parentElement.children].some(node=>node.classList.contains('atoma-scroll-shadows') &&
        !node.hidden && Math.abs(node.getBoundingClientRect().left-r.left)<3 &&
        Math.abs(node.getBoundingClientRect().top-r.top)<3 &&
        Math.abs(node.getBoundingClientRect().width-r.width)<3);
    }));
    await page.evaluate(() => {document.querySelector('#grid').style.transform='';});

    await page.focus('#panel');
    await page.keyboard.press('End');
    await edges('panel', {top:true,bottom:false});
    await page.keyboard.press('Home');
    await edges('panel', {top:false,bottom:true});
    const point = await page.$eval('#panel', el => {const r=el.getBoundingClientRect();return {x:r.x+30,y:r.y+40};});
    await page.mouse.move(point.x,point.y);
    await page.mouse.wheel({deltaY:100});
    await edges('panel',{top:true,bottom:true});
    await page.screenshot({path:'/tmp/atoma-panel-shadows-middle.png'});
    await page.evaluate(() => {document.querySelector('#content').replaceChildren(document.createTextNode('Now fits'));});
    await edges('panel',{top:false,bottom:false});
    await page.evaluate(() => {document.querySelector('#content').innerHTML='<p>Content appended</p>'.repeat(20);});
    await edges('panel',{top:false,bottom:true});
    await page.evaluate(() => {document.querySelector('#panel').style.height='1200px';});
    await edges('panel',{top:false,bottom:false});
    await edges('horizontal',{left:false,right:true});
    await page.$eval('#horizontal', el => {el.scrollLeft=el.scrollWidth;});
    await edges('horizontal',{left:true,right:false});
    await edges('rtl',{left:true,right:false});
    await page.$eval('#rtl', el => {el.scrollLeft=-el.scrollWidth;});
    await edges('rtl',{left:false,right:true});
    await edges('input',{top:false,bottom:true});
    await page.focus('#input');
    // Native platform shortcuts differ; ordinary wheel must also reach the end.
    const inputPoint = await page.$eval('#input', el => {el.scrollIntoView();const r=el.getBoundingClientRect();return{x:r.x+40,y:r.y+40};});
    await page.mouse.move(inputPoint.x,inputPoint.y);
    await page.mouse.wheel({deltaY:10000});
    await edges('input',{top:true,bottom:false});
    assert.equal(await page.$eval('#input', el => getComputedStyle(el).scrollbarWidth),'none');
    await page.evaluate(() => stopShadows());
    assert.equal(await page.$$('.atoma-scroll-shadows').then(nodes=>nodes.length),0);
    assert.equal(await page.$eval('#panel',el=>el.getAttribute('tabindex')),null);
    assert.equal(await page.$eval('#grid',el=>el.style.position),'');
    console.log('viz native scroll shadows: grid/fixed/textarea, RTL/horizontal, keyboard, wheel, resize, content and cleanup passed');
  } finally { await page.close(); }
}

/** Exercise a shipped native panel without changing its content or form values. */
export async function verifyPanelEdges(page, selector, name) {
  const check = async expected => {
    await page.waitForFunction(({selector,expected}) => {
      const panel=document.querySelector(selector);
      if (!panel || getComputedStyle(panel).scrollbarWidth !== 'none') return false;
      const p=panel.getBoundingClientRect();
      const overlay=[...panel.parentElement.children].find(el=>el.classList.contains('atoma-scroll-shadows') &&
        !el.hidden && Math.abs(el.getBoundingClientRect().left-p.left-panel.clientLeft)<1 &&
        Math.abs(el.getBoundingClientRect().top-p.top-panel.clientTop)<1 &&
        Math.abs(el.getBoundingClientRect().width-p.width*(panel.clientWidth/panel.offsetWidth))<2);
      if(!overlay)return false;
      return ['top','bottom'].every(edge=>!overlay.querySelector(`[data-edge="${edge}"]`).hidden===expected[edge]);
    },{}, {selector,expected}).catch(async error => {
      await page.screenshot({path:`/tmp/atoma-${name}-edge-failure.png`});
      const detail=await page.$eval(selector,panel=>{
        const r=panel.getBoundingClientRect();
        return {top:panel.scrollTop,max:panel.scrollHeight-panel.clientHeight,rect:r.toJSON(),
          target:document.elementFromPoint(r.right-8,r.y+r.height/2)?.outerHTML.slice(0,300),
          overlays:[...panel.parentElement.children].filter(el=>el.classList.contains('atoma-scroll-shadows')).map(el=>({
            hidden:el.hidden,rect:el.getBoundingClientRect().toJSON(),style:el.style.cssText,
            edges:[...el.children].map(span=>[span.dataset.edge,!span.hidden]),
          }))};
      });
      throw new Error(`${name} edge check ${JSON.stringify(expected)} failed: ${JSON.stringify(detail)}`,{cause:error});
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await page.$eval(selector,el=>{el.scrollTop=0;});
  const max=await page.$eval(selector,el=>Math.max(0,el.scrollHeight-el.clientHeight));
  await check({top:false,bottom:max>1});
  if(max>1){
    const point=await page.$eval(selector,el=>{const r=el.getBoundingClientRect();return{x:r.x+r.width*.75,y:r.y+r.height/2};});
    await page.mouse.move(point.x,point.y);
    await page.mouse.wheel({deltaY:100000});
    await check({top:true,bottom:false});
    await page.screenshot({path:`/tmp/atoma-${name}-shadows-bottom.png`});
    await page.mouse.wheel({deltaY:-100000});
    await check({top:false,bottom:true});
    await page.screenshot({path:`/tmp/atoma-${name}-shadows-top.png`});
    // Focus and End used to scroll the hidden-overflow camera crop by 50px,
    // cutting off the title even though the native panel reached its own end.
    await page.focus(selector);
    await page.keyboard.press('End');
    await check({top:true,bottom:false});
    const cameraScroll=await page.$eval('.gpu-cube',el=>({x:el.scrollLeft,y:el.scrollTop}));
    assert.deepEqual(cameraScroll,{x:0,y:0},'Keyboard focus must not scroll the camera crop');
    await page.keyboard.press('Home');
    await check({top:false,bottom:true});
    assert.deepEqual(await page.$eval('.gpu-cube',el=>({x:el.scrollLeft,y:el.scrollTop})),{x:0,y:0});
  }
  console.log(`viz shipped ${name}: native scroll edges and hidden scrollbar verified (max ${max}px)`);
}
