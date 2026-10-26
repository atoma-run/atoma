"""Render the saved investigation without fetching data or running models."""
import html
import json
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent
analysis = json.loads((root / 'analysis.json').read_text())
findings = [
    ('Trois refus Git sans travail utile', 'La synchronisation a déjà été faite par l’hôte, journal 6872. Le validateur exige pourtant que le worker la refasse. Git est absent du conteneur. Ces trois couples plan/revue occupent 35,120 s, puis provoquent des inspections et un changement de molécule.', 'd221878b · 2daf0a57 · 3c791849'),
    ('Dépendances absentes, vérifications lancées trop tôt', 'Le premier npx prend 46,693 s, télécharge Vitest 5.0.5 au lieu du 3.2.4 du projet, puis échoue. TypeScript, ESLint et Playwright manquent aussi. Les installations utiles n’arrivent qu’au second passage.', '2394817d · 38adcc3d · b07f7910'),
    ('Le test ne prouve pas la protection temporelle', 'Le bon état final peut masquer un ancien état affiché brièvement. Les assertions négatives ajoutées restent des observations ponctuelles. Notre contre-épreuve dans Chromium accepte ces prédicats avec la protection retirée ; une assertion avant libération de la réponse fraîche détecte la régression.', '0ac58129 · a0a6c19a · stale-proof-results.json'),
    ('Une reprise trop large pour une correction de test', 'Le critère unique regroupe plusieurs comportements. Après son refus, l’agent refactorise encore le code fonctionnel, relit le contexte et rejoue les quatre cas du fichier. Le test précis n’est sélectionné qu’à la fin, après un passage réussi sans nouvelle modification.', '1fe793e6 · 4b1cc0cf · 8fe6a014'),
    ('Recette de reprise mal adaptée', 'Une recette demandant de rejouer toutes les baselines est injectée après un défaut de dépendances, malgré la demande ciblée. Son injection est certaine ; son rôle causal dans les appels ultérieurs n’est pas démontré.', '9ea3ae43'),
    ('Un contrôle remplacé par une preuve plus faible', 'Le grep sur les noms de variables échoue dans le bundle minifié. Il est remplacé par un grep de « human verification », qui réussit mais ne prouve pas la correction du rafraîchissement. Les deux appels restent dans la trace.', '12b59a9a · 3d5c1cb9'),
    ('La revue automatique manque des faits', 'Le verdict « sound » affirme qu’aucun nouveau verdict de validation n’a été terminé avant la coupure. Le dernier refus est pourtant enregistré. Le compteur refusals=0 concerne les skills ; six verdicts de validation sont négatifs.', 'a0a6c19a · supplemental-evidence.json'),
    ('Le reboot explique la coupure, pas les reprises précédentes', 'Fermeture locale à 10:46:57, arrêt confirmé localement à 10:46:59, reconnexion et statut final à 11:05:47 (Athènes). L’intervalle de 18 min 50 s correspond à la finalisation après déconnexion. La trace ne montre aucun travail d’agent pendant cet intervalle.', 'compute-client-excerpt.log'),
]

def inline(text):
    return re.sub(r'`([^`]+)`', r'<code>\1</code>', html.escape(text))

def markdown(text):
    blocks = []
    for block in text.split('\n\n'):
        if not block.strip():
            continue
        match = re.match(r'^(#{1,3}) (.*)$', block)
        if match:
            level = min(len(match[1]) + 1, 4)
            blocks.append(f'<h{level}>{inline(match[2])}</h{level}>')
        elif block.startswith('- '):
            items = re.split(r'\n(?=- )', block)
            blocks.append('<ul>' + ''.join('<li>' + inline(s[2:]) + '</li>' for s in items) + '</ul>')
        else:
            blocks.append('<p>' + inline(block) + '</p>')
    return '\n'.join(blocks)

payload = json.dumps(analysis['events'], ensure_ascii=False).replace('<', '\\u003c')
rows = ''.join(f'<tr><td>{html.escape(role)}</td><td>{r["calls"]}</td><td>{r["seconds"]:.3f}</td><td>{r["costEquivalentUsd"]:.6f}</td></tr>' for role, r in analysis['metrics']['roles'].items())
cards = ''.join(f'<details class="finding" open><summary>{i + 1}. {html.escape(title)}</summary><p>{html.escape(body)}</p><small>Preuves : {html.escape(ref)}</small></details>' for i, (title, body, ref) in enumerate(findings))
document = '''<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Attica 2428d930 — analyse avant relance</title>
<style>
:root{color-scheme:light dark;--paper:light-dark(#fcfcfa,#171919);--ink:light-dark(#202725,#e6eae7);--muted:light-dark(#56635d,#aab7b0);--line:light-dark(#d5ddd7,#3a4540);--accent:light-dark(#176347,#8ed5b0)}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 system-ui,sans-serif}main{max-width:1100px;padding:32px 28px 80px;margin:auto}h1{font-size:24px;line-height:1.3}h2{font-size:21px;margin-top:36px}h3{font-size:18px}h4{font-size:16px}small,.muted{color:var(--muted)}a{color:var(--accent)}.lead{font-size:18px;max-width:900px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;padding:24px 0;border-block:1px solid var(--line)}.metrics strong{display:block;font-size:23px;font-variant-numeric:tabular-nums}.metrics span{font-size:13px;color:var(--muted)}.finding{padding:18px 0;border-bottom:1px solid var(--line)}summary{font-weight:650;cursor:pointer}.finding p{margin:8px 0}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted)}code{font:13px ui-monospace,monospace;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:480px;overflow:auto;font:12px/1.5 ui-monospace,monospace}.controls{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}input,select{padding:10px;font:inherit;background:var(--paper);color:var(--ink);border:1px solid var(--line)}input{flex:1;min-width:240px}.ledger{overflow-x:auto}.ledger summary{font-weight:400}.bar{display:flex;height:30px;margin:16px 0;background:var(--line)}.bar span{display:block;border-right:2px solid var(--paper)}.active{background:var(--accent)}.appendix{max-width:900px}.appendix p{white-space:normal}nav{display:flex;gap:18px;flex-wrap:wrap;margin:20px 0}@media(max-width:650px){main{padding:20px 16px}.metrics{grid-template-columns:repeat(2,1fr)}td,th{padding:6px}.lead{font-size:16px}}
</style><main>
<p class="muted">Investigation du 23 octobre 2026 · run 2428d930 · aucun redémarrage lancé</p>
<h1>Des reprises évitables, et un refus de test justifié</h1>
<p class="lead">La trace couvre 7 min 06 s de travail. Le run affiche 26 min 42 s parce que sa finalisation attend le retour de Compute. Avant la coupure, des blocages Git artificiels et une préparation incomplète du runtime ralentissent la correction ; le test temporel reste insuffisant après deux versions.</p>
<nav><a href="#findings">Constats</a><a href="#proof">Contre-épreuve</a><a href="#events">168 événements</a><a href="#full">Rapport technique</a><a href="trace-evidence.json.gz">Capture complète</a></nav>
<div class="metrics"><div><strong>7 min 06 s</strong><span>durée de la trace</span></div><div><strong>3</strong><span>passages d’exécution</span></div><div><strong>6</strong><span>verdicts négatifs</span></div><div><strong>$0,208</strong><span>équivalent abonnement, hors Decision</span></div></div>
<h2>Temps de cycle : trois intervalles distincts</h2><div class="bar" aria-label="45,7 secondes avant trace, 425,7 secondes de trace, 1130,1 secondes jusqu’à la finalisation"><span style="width:2.855%"></span><span class="active" style="width:26.583%"></span><span style="width:70.562%"></span></div>
<p class="muted">45,7 s avant trace · <strong>425,7 s de trace (vert)</strong> · 1 130,1 s entre fin de trace et statut final. Source : horodatages MCP. Les outils sont inclus dans les durées d’exécution ci-dessous.</p>
<table><thead><tr><th>Rôle</th><th>Appels logiques</th><th>Durée cumulée (s)</th><th>Équivalent USD</th></tr></thead><tbody>__ROWS__</tbody></table>
<h2 id="findings">Constats étayés</h2>__FINDINGS__
<h2 id="proof">La contre-épreuve qui distingue répétition et vérification utile</h2>
<p>Sur une copie du JavaScript enregistré, deux bras tournent hors ligne dans Chromium. La mutation retire uniquement la garde de version du rafraîchissement. Les prédicats enregistrés restent satisfaits après arrivée de la réponse fraîche. Une observation déterministe entre l’ancienne réponse et la fraîche refuse la mutation.</p>
<table><thead><tr><th>Code testé</th><th>Prédicats du test enregistré</th><th>Assertion avant réponse fraîche</th></tr></thead><tbody><tr><td>Garde conservée</td><td>Satisfaits</td><td>Réussit</td></tr><tr><td>Garde retirée volontairement</td><td>Satisfaits malgré l’ancien état affiché</td><td>Échoue comme attendu</td></tr></tbody></table>
<p class="muted">Contre-exemple sous ordonnancement contrôlé, pas rejeu exact du runner Playwright/Vitest ni mesure de fréquence. <a href="stale-proof-results.json">Résultats et historique DOM</a> · <a href="stale-proof-experiment.mjs">Source reproductible</a></p>
<h2>Ordre proposé avant toute relance</h2><ol><li>Transmettre aux agents le reçu de synchronisation détenu par l’hôte.</li><li>Préparer une seule fois les dépendances racine et navigateur requises.</li><li>Corriger le test d’ordonnancement ; conserver le correctif source déjà présent.</li><li>Utiliser la configuration navigateur et sélectionner le seul nouveau cas.</li><li>Rendre explicite l’état « exécution arrêtée, confirmation distante attendue ».</li></ol>
<p>Aucun correctif moteur n’a été appliqué dans cette investigation. Une nouvelle relance ne doit pas supposer que le workspace interrompu sera automatiquement repris : le run échoué n’a ni livraison ni manifeste accepté.</p>
<h2 id="events">Journal intégral consultable</h2><p>Les résumés couvrent la trace entière. Déplier une ligne affiche les commandes, résultats ou verdicts. Les prompts complets sont dans la capture compressée.</p>
<div class="controls"><input id="search" aria-label="Filtrer les événements" placeholder="Git, erreur, identifiant, commande…"><select id="kind" aria-label="Type d’événement"><option value="">Tous les types</option><option>llm</option><option>tool</option><option>context</option><option>acceptance</option><option>registry</option><option>skill</option><option>jev</option><option>llm-start</option></select></div><p id="count" class="muted"></p><div class="ledger"><table><thead><tr><th>Depuis trace (s)</th><th>Type / acteur</th><th>Preuve</th></tr></thead><tbody id="body"></tbody></table></div>
<h2 id="full">Rapport technique et limites</h2><article class="appendix">__REPORT__</article><p><a href="HASHES.sha256">Empreintes des fichiers</a> · <a href="analysis.json">Données de l’analyse</a> · <a href="README.md">Rapport source</a></p>
</main><script>
const events=__EVENTS__;
const search=document.getElementById('search'),kind=document.getElementById('kind'),body=document.getElementById('body');
function draw(){const q=search.value.toLowerCase();const rows=events.filter(e=>(!kind.value||e.kind===kind.value)&&(!q||JSON.stringify(e).toLowerCase().includes(q)));body.replaceChildren();document.getElementById('count').textContent=rows.length+' / '+events.length+' événements';for(const e of rows){const tr=document.createElement('tr');const time=document.createElement('td');time.textContent=e.secondsFromTrace.toFixed(1);const type=document.createElement('td');type.textContent=e.kind+' · '+(e.atom||'hôte');const td=document.createElement('td'),details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=(e.role||e.name||e.op||e.kind)+' · '+e.id;pre.textContent=JSON.stringify(e,null,2);details.append(summary,pre);td.append(details);tr.append(time,type,td);body.append(tr)}}search.addEventListener('input',draw);kind.addEventListener('change',draw);draw();
</script></html>'''
document = document.replace('__ROWS__', rows).replace('__FINDINGS__', cards).replace('__REPORT__', markdown((root / 'README.md').read_text())).replace('__EVENTS__', payload)
(root / 'report.html').write_text(document)
print(root / 'report.html')
