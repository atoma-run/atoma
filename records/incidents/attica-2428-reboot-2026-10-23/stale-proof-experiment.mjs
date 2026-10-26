// Offline counterexample using the recorded compiled UI, not a product repair.
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('./control.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./control.html', import.meta.url), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const browser = await puppeteer.launch({headless: true});
const outcomes = [];
try {
  for (const mutation of [false, true]) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => request.abort());
    await page.setContent(html);
    await page.evaluate(() => {
      window.__pending = [];
      window.__history = [];
      window.setInterval = callback => { window.__tick = callback; return 1; };
      window.fetch = async (url) => {
        if (url === '/api/status') return new Promise(resolve => window.__pending.push(resolve));
        if (url === '/api/cancel') return {ok: false, status: 503, json: async () => ({error: 'Arrêt refusé hors ligne'})};
        throw new Error('Unexpected network request: ' + url);
      };
      new MutationObserver(() => window.__history.push({state: document.getElementById('state').textContent, rows: document.getElementById('announcements').textContent})).observe(document.body, {subtree: true, childList: true, characterData: true});
    });
    const needle = 'if (requestVersion === viewVersion && !resumeInFlight) {';
    assert.equal(source.split(needle).length, 2);
    await page.addScriptTag({content: mutation ? source.replace(needle, 'if (!resumeInFlight) {') : source});
    await page.click('#cancel');
    await page.waitForFunction(() => document.getElementById('explanation').textContent.includes('Arrêt refusé hors ligne'));
    const snap = () => page.evaluate(() => ({state: document.getElementById('state').textContent, rows: document.getElementById('announcements').textContent, error: document.getElementById('explanation').textContent, count: document.querySelectorAll('#announcements .listing').length}));
    const before = await snap();
    await page.evaluate(async () => {
      const resolve = window.__pending.shift();
      if (!resolve) throw new Error('Initial status request missing');
      resolve({ok: true, status: 200, json: async () => ({status: 'idle', label: 'Ancien état', reason: 'ancienne réponse', rows: [{identifiant: 'old'}]})});
      await new Promise(done => setTimeout(done, 0));
    });
    // A deterministic assertion here rejects the mutation before any fresh reply.
    const afterOld = await snap();
    const deterministicPassed = before.state === afterOld.state && before.rows === afterOld.rows && before.error === afterOld.error;
    await page.evaluate(async () => {
      window.__tick();
      const resolve = window.__pending.shift();
      if (!resolve) throw new Error('Fresh status request missing');
      resolve({ok: true, status: 200, json: async () => ({status: 'idle', label: 'État actualisé', reason: 'données fraîches', rows: [{identifiant: 'new'}, {identifiant: 'newer'}]})});
      await new Promise(done => setTimeout(done, 0));
    });
    const afterFresh = await snap();
    // Both recorded test versions permit observations after the fresh response.
    const recordedPredicatesPassed = !afterFresh.state.includes('Ancien état') && !afterFresh.rows.includes('old') && afterFresh.state.includes('État actualisé') && afterFresh.rows.includes('newer') && afterFresh.error.includes('Arrêt refusé hors ligne') && afterFresh.count === 2;
    const history = await page.evaluate(() => window.__history);
    assert.equal(recordedPredicatesPassed, true);
    assert.equal(deterministicPassed, !mutation);
    assert.equal(history.some(row => row.state.includes('Ancien état')), mutation);
    outcomes.push({mutation, recordedPredicatesPassed, deterministicPassed, before, afterOld, afterFresh, history});
    await page.close();
  }
} finally { await browser.close(); }
writeFileSync(new URL('./stale-proof-results.json', import.meta.url), JSON.stringify({scope: 'Controlled offline schedule with the recorded compiled UI; counterexample to assertion sufficiency, not an exact Playwright/Vitest replay or measurement of production timing.', outcomes}, null, 2) + '\n');
console.log(JSON.stringify(outcomes.map(({mutation, recordedPredicatesPassed, deterministicPassed}) => ({mutation, recordedPredicatesPassed, deterministicPassed}))));
