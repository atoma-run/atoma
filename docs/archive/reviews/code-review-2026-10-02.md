# Revue critique — fenêtre 2026-09-25 → 2026-10-01 (170 commits)

Date : 2026-10-02.
Référence examinée : `cc631bb6301e31664bafcaa6455aac5250aebe22` (= `origin/main`
au début de la revue, CI verte, déployé en production le 2026-10-01 à 21:04 UTC).
Fenêtre : `149f141..cc631bb6`, 170 commits (dont un merge, 8 commits de
traduction du bot et 6 commits de dépendances), 411 fichiers, +45 986 / −2 785 ;
hors catalogues traduits et lockfile, 397 fichiers, +45 203 / −2 741 ; source
seule (src, tests, scripts, deploy, CI), 312 fichiers, +38 111 / −2 412.

La précédente revue générale est celle du
[25 septembre](code-review-2026-09-25.md), qui examinait `149f141` et dont les
corrections (section 9, commits `654c404`…`c252885` plus la passe adverse) sont
les premiers commits de cette fenêtre. Cette revue vérifie ces fermetures
(section 6) avant d'examiner le reste.

Méthode : quinze relectures indépendantes par domaine (fermetures du 25/09 ;
Jev ; MCP deux ères ; run/approfondissement/replays ; acceptation et preuves ;
superviseur ; déploiement/CI/limites plateforme ; compile-at-learn ; catalogue
de modèles et transports ; viz ; OAuth ; projets/preview ; vérité
documentaire ; qualité des tests ; balayage sécurité transversal), chacune
lisant le AGENTS.md de son sous-système, le diff complet de son périmètre et le
code environnant à `cc631bb6`. **Chaque piste a ensuite été soumise à un
vérificateur adverse indépendant chargé de la réfuter** (lecture des gardes
amont, des invariants d'appelants et des arbitrages documentés ; reproduction
exécutée pour les HIGH/MEDIUM). Un critique de complétude a relu les commits et
fichiers qu'aucune relecture ne déclarait couverts. Sur 46 pistes, 41 ont été
confirmées, 5 réfutées (et une piste du critique écartée par l'auteur comme
arbitrage documenté dans le code) ; les pistes réfutées ne figurent pas comme
findings. Les reproductions des HIGH/MEDIUM dont les fichiers n'avaient pas
bougé après la fenêtre ont été **rejouées par l'auteur** (dix scripts, tous
reproduisent) ; les autres sont attestées par l'exécution des vérificateurs à
la référence.

Convention : **✓ = lu dans le code à cette référence ; reproduit = expérience
locale exécutée, scripts dans
l'[annexe de preuves](../../incidents/code-review-2026-10-02-evidence.md)**.
Les lignes citées sont celles de `cc631bb6`. Aucun correctif n'est appliqué par
cette revue. Le dépôt a continué d'avancer pendant la revue (`cc631bb6..` :
Jev dans le routage des tissues, coûts projet dans la viz…) ; ces commits sont
hors fenêtre et relèvent de la prochaine revue.

## Vue d'ensemble

La fenêtre est la plus grosse depuis le 24 septembre : la fermeture complète de
la revue du 25/09, puis six chantiers — Jev (le décideur mécanique TypeSafe,
actif par défaut dans les runs de toutes les organisations), la bascule MCP
deux ères (SDK v2, zod 4, protocole 2026-07-28 à côté de 2025-11-25, tâches qui
survivent aux sessions et aux déploiements), le mender qui ouvre enfin des
pull requests, le pipeline de déploiement sans interruption (préparation
pendant que l'ancienne génération sert, attente du travail en cours), les
limites de run re-statables à chaud par un admin plateforme, et le replay des
checks navigateur hérités (l'exception bornée à « verification is read-only »,
décision propriétaire du 2026-10-01).

**Les fermetures du 25 septembre tiennent, pour la classe et pas seulement pour
le scénario reproduit** — c'est la première fenêtre où la vérification des
fermetures ne rouvre aucun finding (section 6). Les recommandations de
conception 4.A–4.D sont actées dans le code et les contrats écrits.

Les défauts confirmés de cette fenêtre relèvent de trois classes déjà
connues : **des contrats corrects localement mais incompatibles entre couches**
(un schéma de sortie fermé que le payload déborde, 1.1 ; une valeur acceptée à
l'écriture CLI puis refusée par le schéma HTTP et droppée à la relecture,
1.8 ; une erreur de bail que le test d'identité de préemption ne reconnaît
pas, 1.3) ; **un silence qui redevient une approbation** (un judgement de
critère à l'id mal orthographié est perdu et l'approbation tient, 1.5 ; un
replay hérité qui n'a rien gardé rend un bloc vide et aucune revue n'est
forcée, 1.10 ; un fichier au-delà du cap de relecture est présenté
« REMOVED », 1.9) ; et **des instruments de mesure biaisés précisément là où
ils décident** (les audits Jev perdus sur le chemin d'échec du runner, 1.4 ;
les clients 2025 repris jamais comptés par la métrique qui décide la fin de
l'ère, 1.2).

**Bilan : un finding HIGH et onze MEDIUM, dix reproduits et rejoués ; quinze
LOW ; douze constats documentaires ou décisions propriétaire en attente.** Le
HIGH est en production et actif : deux outils MCP du tier platform sont
refusés par tout client SDK validant à chaque appel — la classe exacte que
`cb5e1246` a corrigée la veille pour `atoma_ledger_tail`, présente sur ses
deux voisins.

## 1. Bugs confirmés, par gravité

### 1.1 ✓ HIGH (reproduit, rejoué) — `atoma_costs` et `atoma_sentinel_health` émettent des champs hors de leur outputSchema fermé : chaque appel est refusé par un client SDK validant

**Sites :** `src/mcp/tools.ts:947-957` (schéma d'`atoma_costs` sans
`unparseable` ni `note`) ; `src/mcp/readers.ts:1024,1038-1039` (`costs()` les
émet inconditionnellement) ; `src/mcp/tools.ts:1008-1023` (schéma
d'`atoma_sentinel_health` sans `note`, handler qui l'émet dans les deux
branches).
**Introduction :** `d4934674` (pré-fenêtre) ; rendue active par `70d80ec1`
(SDK v2 publie les schémas zod 4 en mode output, `additionalProperties:false`) ;
`cb5e1246` a corrigé le même défaut pour `atoma_ledger_tail` seul, avec un
commentaire décrivant le mécanisme (« seen live 2026-10-01 ») et un test SDK
réel qui ne couvre que cet outil.

Le serveur valide `structuredContent` en mode strip (les clés en trop passent
et le payload original est envoyé) ; le client SDK compile le JSON Schema
publié et refuse le résultat entier : « Structured content does not match the
tool's output schema: data must NOT have additional properties ». Reproduit
avec le vrai serveur et le vrai client SDK du dépôt (InMemoryTransport,
schémas et payloads copiés verbatim) : les deux outils sont refusés à chaque
appel, y compris sur un corpus vide. `src/mcp/AGENTS.md` énonce la règle
inverse (« loose, passthrough-shaped, so an additive field never fails the
host's validation … Never add an outputSchema a payload can miss ») : le code
contredit la règle écrite du sous-système.

**Conséquence :** un platform admin sous Claude Code — le client qui a motivé
`cb5e1246` — ne peut lire ni la courbe de coûts ni la santé du
sentinel/analyste par MCP.

**Fermeture proposée :** déclarer `unparseable` et `note` (et balayer les 41
outils : chaque champ émis par un reader doit être dans le schéma, ou le
schéma doit rester passthrough) ; étendre le test SDK réel de `cb5e1246` à
tout le catalogue plutôt qu'à un outil nommé.

### 1.2 ✓ MEDIUM (reproduit, rejoué) — `health().clients` ne compte jamais une session 2025 reprise après un déploiement : la métrique qui décide la fin de l'ère 2025 sous-compte précisément les clients 2025

**Sites :** `src/mcp/http.ts:373-375` (reprise sans `countClient`),
`:413` (seul comptage 2025 : un initialize neuf), `:431` (un client 2026 est
compté à chaque requête), `:612-634` (`initialiseResumed`, clientInfo
synthétique jamais compté).
**Introduction :** `e66c7b13` × `1c5bfb79`.

Les compteurs sont en mémoire et repartent à zéro à chaque déploiement
(plusieurs par jour). Un client 2025 longue durée reprend sa session après
chaque redéploiement (`resumed` croît) sans jamais réapparaître dans
`clients`. Or `src/mcp/AGENTS.md` et
[docs/mcp-two-eras-2026-09-30.md](../../mcp-two-eras-2026-09-30.md) font de ce
comptage LE critère de suppression de l'ère 2025, et la note de
`atoma_mcp_health` affirme « A client appears once it opened a session
(2025) ». **Reproduit** : initialize (clients = `{2025-11-25 repro-client: 1}`),
restart du host, tools/list avec l'ancien session id → 200, `resumed=1`,
`clients={}`.

**Fermeture proposée :** compter le client à la reprise (le clientInfo d'origine
peut être rejoué dans `initialiseResumed`, ou la reprise comptée sous un nom
dédié), ou corriger la règle de fin d'ère pour lire `resumed` aussi.

### 1.3 ✓ MEDIUM (reproduit, rejoué) — Préempté pendant l'attente du bail Codex HOME, l'analyste perd le run au lieu de le rendre à la file

**Sites :** `src/core/codexHomeLease.ts:41-43,74,95-100,181-203` (toute
annulation rejette une Error NEUVE « Codex profile access was cancelled »,
jamais `signal.reason`) ; `src/supervisor/codexSession.ts:85-88` ;
`src/supervisor/analyst.ts:373-378` (la préemption n'est reconnue que par
identité ou égalité de message avec `signal.reason`) ;
`src/supervisor/resident.ts:158-159,186-190` (le catch compte `failed` sans
remettre le run en file).
**Introduction :** `1fa73133`.

Le contrat (« the analysed run keeps its place and its attempt ») tient sur le
chemin où la session est en vol, pas pendant l'attente du bail du Codex HOME —
or les runs produit `sub:openai` prennent le même bail, précisément au moment
où `yieldForRun` aborte l'analyste. Le mender teste `signal.aborted` seul
(`mender.ts:783`) ; l'asymétrie confirme le filtre trop étroit. **Reproduit** :
l'erreur réellement rejetée par le bail échoue le test d'identité de
l'analyste → rethrow → run définitivement sorti de la file, sans verdict ni
finding mender, récupérable seulement par `analyst --run <id> --force`.

**Fermeture proposée :** reconnaître la préemption par `options.signal.aborted`
(comme le mender), ou faire rejeter `signal.reason` par le bail.

### 1.4 ✓ MEDIUM (reproduit) — Les audits Jev en vol sont perdus sur le chemin d'échec du runner : l'échantillon des fausses approbations est biaisé vers les runs réussis

**Sites :** `src/run/runner.ts:1277` (settle sur le seul chemin de succès),
`:1353,1390` (catch → `endRun` sans settle), `:1249` (watchdog), `:1176`
(shutdown) ; `src/viz/trace.ts:656,731` (`record()` jette tout événement après
`endRun`).
**Introduction :** `4f686a71`.

`atoma_jev_calibrate({auditsOnly})` est le seul instrument qui mesure les
fausses approbations de Jev depuis que le modèle ne les voit plus. Les runs qui
échouent — ceux où une fausse approbation a le plus de chances d'avoir
contribué — sont systématiquement sous-représentés : `falseApprovalShare` est
tiré vers le bas, et c'est sur ces chiffres que les seuils se calibrent.
`src/core/AGENTS.md:223-228` affirme sans condition que le runner attend les
audits en vol avant de fermer la trace. **Reproduit** avec les vrais
`createJevAudit` et `TraceRecorder` : avec settle, 1 événement `jev-audit` ;
sans (chemin d'échec), 0.

**Fermeture proposée :** le même `settle` borné sur les quatre chemins
d'`endRun` (succès, catch, watchdog, shutdown).

### 1.5 ✓ MEDIUM (reproduit, rejoué) — La garde d'auto-contradiction par critère est inerte quand les judgements manquent ou que leurs ids ne s'apparient pas

**Sites :** `src/atoms/rootAcceptance.ts:284` (Map par id exact, sans
normalisation), `:297-314` (`consistentWithCriteria` : zéro unmet apparié =
approbation), `:503` (`criteria` absent → couverture nue) ;
`src/atoms/json.ts:1239-1250` (`coerceCriteria` garde l'id tel quel) ;
`src/contracts/acceptanceChecklist.ts:45,110,120` (ids canoniques `c<n>`
minuscules).
**Introduction :** `29abe272`.

Une liste USER est promise jugée critère par critère, et une approbation qui
juge un critère unmet doit se refuser elle-même. **Reproduit sur le chemin de
production (`acceptRootResult`)** : un verdict `approved:true` portant
`criteria:[{"id":"C1","met":false,…}]` (majuscule) ou omettant le tableau est
APPROUVÉ — l'unmet explicite est perdu, rien n'ouvre de remédiation ; le
contrôle en `c1` exact refuse correctement. La classe « id sensible à la
casse » a un précédent dans ce dépôt (lecteur de l'analyste, PR mender #6,
corrigé par `4468d705` — dans ce même cycle).

**Fermeture proposée :** normaliser l'id (casse, espaces, `c` optionnel) à la
coercition, et re-demander (ou refuser) quand une liste USER reçoit une
approbation sans aucun judgement apparié.

### 1.6 ✓ MEDIUM (reproduit, rejoué) — Le refus d'un pin ChatGPT retiré « avant dépense » ne couvre pas les lancements opérateur

**Sites :** `src/contracts/runPayers.ts:69-80`
(`assertServedHostChatGptModels` : deux seuls appelants —
`src/projects/coordinator.ts:1484` et `src/viz/server.ts:3159`) ;
`src/contracts/modelSelector.ts:228-238` (grammaire seule) ;
`src/core/llmCodexCli.ts:147-179` (slug transmis verbatim) ;
`src/run/runner.ts:527-560` ; `src/mcp/run.ts` (environnement hôte sans
garde).
**Introduction :** `8efc96fd`.

Le garde n'existe que pour les runs projet et l'écriture Settings. Un pin hôte
`ATOMA_MODEL_L1=sub:openai:gpt-5.4-mini` (un `.env` d'avant le retrait)
traverse `run:build`, `atoma_operator_run_start`, burn-in et curriculum :
sélecteur grammaticalement valide, slug verbatim au transport — et reproduit
l'incident R8/`d019cfe8` que le commit corrige (planner payé, chaque appel L1
`request-rejected`). Le CHANGELOG, `src/auth/AGENTS.md:120-127` et le
commentaire de `providerCatalog.ts:380-385` énoncent la règle sans la réserve.
`doctor` ne vérifie pas non plus les slugs des pins.

**Fermeture proposée :** appeler le garde dans `startTask` (ou `doctor`) pour
tout sélecteur `sub:openai`, puisque la dépense est celle de l'hôte.

### 1.7 ✓ MEDIUM (reproduit, rejoué) — `models refresh --apply` perd le `cacheWrite: 0` des vendeurs qui ne facturent pas l'écriture de cache

**Sites :** `src/cli/modelCatalogUpdate.ts:255-270` (`pricePointFromSource` :
repli `current?.cachedInput` mais aucun repli `current?.cacheWrite`),
`:201-208` (`diffCatalog` ne compare `cacheWrite` que déclaré des deux côtés) ;
`src/core/metrics.ts:199-206` (défaut : 1,25 × input) ;
`src/core/modelCatalog.json` (14 points `cacheWrite: 0` — Z.ai, DeepSeek,
revus par un humain le 2026-09-27).
**Introduction :** `3dc8b75c`.

**Reproduit** : un changement de prix d'entrée Z.ai sur `glm-4.7` via la
référence LiteLLM (qui ne déclare pas de coût cache-creation) écrit un nouveau
point SANS `cacheWrite` ; le coût d'1 M de tokens cache-creation passe de 0 à
0,875 USD. La perte est auto-entretenue : une fois `cacheWrite` absent du
point courant, `diffCatalog` ne le propose plus jamais. `priceLabel` n'affiche
pas `cacheWrite`, donc le dry run ne montre rien. L'argument « over-stating is
preferred » du commentaire couvre l'inconnu, pas la perte d'un fait connu —
l'asymétrie avec `cachedInput` (conservé) confirme l'oubli.

**Fermeture proposée :** même repli que `cachedInput`, et `cacheWrite` dans
`priceLabel` ; un test sur les 14 points à zéro.

### 1.8 ✓ MEDIUM (reproduit, rejoué) — Un « 0 = illimité » accepté à l'écriture CLI est refusé par le schéma HTTP et silencieusement perdu à la relecture du store

**Sites :** `src/contracts/platformSettings.ts:285-302` (l'exception zéro vit
dans `assertPlatformSettingValue` seul), `:227-239` (le schéma HTTP dérivé
`base.min(spec.min)` refuse 0) ; `src/platform/settings.ts:100` (`rows()`
droppe toute ligne `value < spec.min`) ; `src/cli/settings.ts:199-230`.
**Introduction :** `d1c4d060` (premières clés où `zeroMeansUnlimited`
coexiste avec `min > 0` : `llm.callTimeoutMs`, `llm.codexCallTimeoutMs`).

La classe exacte « un schéma de requête réutilisé pour relire du stockage
persisté » (4.B du 25/09), au sein du commit qui fermait la revue adverse des
limites. **Reproduit** : `settings set llm.callTimeoutMs 0` réussit et écrit la
ligne ; `rows()` = [], `overrides()` = {}, `list` affiche « default (nothing
stated) », le même 0 depuis le formulaire répond 400, chaque re-set
re-journalise « 0→0 ». L'effet runtime est correct aujourd'hui par coïncidence
(fallback = 0) ; un futur fallback non nul ignorerait le 0 staté sans signal —
le « pin » que `d1c4d060` revendique ne tient pas pour 0.

**Fermeture proposée :** porter l'exception `zeroMeansUnlimited` dans le schéma
dérivé et dans `rows()` (une seule définition de la validité d'une valeur).

### 1.9 ✓ MEDIUM (reproduit, rejoué) — Un fichier de départ relu au-delà des caps du snapshot livré est présenté « REMOVED » à l'accepteur

**Sites :** `src/run/workspace.ts:193-196` (`snapshotFile` : undefined
au-delà de 8 Mo ou du budget, comme pour un fichier disparu), `:253` (le
chemin disparaît de `now.files` sans drapeau) ;
`src/contracts/startingWorkspace.ts:90-92,122` (`!after` ⇒ 'removed' ⇒
« REMOVED (N bytes at the start) »).
**Introduction :** `586a22ca` × `07bdea32`.

Le côté départ marque `truncated` quand il saute un fichier ; le côté livré
n'a aucun équivalent pour les chemins de départ (`addedTruncated` ne couvre
que les nouveaux fichiers), et le commentaire du code affirme l'intention
inverse. **Reproduit** : un fichier seedé de 6 Mo étendu légitimement à 9 Mo
pendant le run est rendu « app.html: REMOVED (6291456 bytes at the start) » —
pour une tâche « garde/étends X », l'accepteur refuse sur une suppression qui
n'a pas eu lieu, et le run suivant hérite d'une raison fausse.

**Fermeture proposée :** distinguer « au-delà du cap » de « absent » dans le
snapshot livré (un statut `unverified (too large)` plutôt que `removed`).

### 1.10 ✓ MEDIUM (reproduit) — Un start replay qui n'a rien gardé rend un bloc hérité vide : le silence redevient une approbation

**Sites :** `src/run/inheritedChecks.ts:284-285` (serveur en échec ⇒
`stopped:'server'`, kept=0), `:415-416,444-448` (kept=0 ⇒ notReplayed=0) ;
`src/contracts/inheritedChecks.ts:515-520` (bloc '' quand items/notReplayed/
earlier vides — ne lit jamais `baseline.stopped`) ;
`src/atoms/rootAcceptance.ts:471-475` (la revue n'est forcée que par
items/notReplayed/unrechecked).
**Introduction :** `a697acaa` × `f6399103` × `5f5535d7`.

Le principe de `5f5535d7` (« silence is never a pass ») n'est appliqué qu'aux
checks GARDÉS non rejoués. Si `start_static_server` échoue au démarrage (ou le
cap tombe avant le premier check), kept=0, le bloc rendu est vide, et sur un
run au floor couvert sans autre déclencheur l'approbation est MÉCANIQUE (« No
mechanical finding requires review ») : la régression de classe `b9dc4d0b`
passe sans qu'aucun lecteur n'ait su que le filet n'a pas tourné. Seule la
trace l'enregistre. **Reproduit** sur le vrai `inheritedChecksFor` avec un
exécuteur dont le serveur échoue.

**Fermeture proposée :** `baseline.stopped`/`kept=0` doit se dire dans le bloc
et forcer la revue, comme `notReplayed>0` le fait déjà.

### 1.11 ✓ MEDIUM (reproduit) — Le scope mono-critère de la remédiation racine ignore les checks hérités contredits

**Sites :** `src/run/depth.ts:55-61` (`soleRefusalReason` : gates, probe,
floor, autres critères — jamais `acceptance.inheritedChecks`), `:92-106`
(scope 'single-criterion', « Keep the deliverables behind the criteria it
judged met ») ; `src/atoms/rootAcceptance.ts:322-338`
(`consistentWithInherited` ne renomme pas l'item hérité quand les critères ont
déjà refusé).
**Introduction :** `349e8f0c` (2026-09-28) × `a697acaa` (2026-10-01), relevé
indépendamment par trois relectures.

`a697acaa` a ajouté une cinquième source de refus postérieure au garde, sans
l'étendre — `src/run/AGENTS.md:200-213` énumère toujours les quatre raisons.
Un refus qui tient à la fois à un critère unique et à une régression héritée
prend le scope mono-critère, avec l'instruction de conserver les livrables des
critères jugés met — potentiellement la page qui porte la régression.
**Reproduit** sur `remediationTask`. Atténuations réelles : les items voyagent
en `EARLIER_LISTED_INPUT` et la seconde acceptation échoue fermée
(`consistentWithRecheck`) — rien de faux n'est publié ; le coût est une passe
de remédiation gaspillée et un atterrissage partial là où la passe large
aurait pu livrer, exactement la pathologie que le docstring du garde dit
éviter.

**Fermeture proposée :** `acceptance.inheritedChecks.items` non vide garde la
passe large, comme les quatre autres sources.

### 1.12 ✓ MEDIUM (reproduit) — Le garde anti-jumeaux compare un brouillon de recette de tâche aux recettes de récupération d'événement

**Sites :** `src/skills/lifecycle.ts:687-688` (jevTwinOf 'task' sur le
namespace entier, non filtré), `:839-840` (le chemin événement, lui, filtre
`.filter((s) => s.trigger)`), `:1331` (le prefilter de tâches exclut les
recettes à trigger), `:367` (`whenToUse: skill.trigger ?? skill.whenToUse`).
**Introduction :** `e461fb65`.

Le contrat (`src/skills/AGENTS.md`, « the visible catalog for a task recipe,
the namespace's recovery recipes for an event one ») est contredit : les
candidats offerts à Jev pour un brouillon de tâche contiennent des recettes
qui ne concourront jamais contre lui, avec leur trigger en guise de
« quand l'utiliser ». **Reproduit** : `recover-missing-ground-truth-evidence`
figure dans l'ensemble `existing` d'un brouillon de tâche. Si Jev le nomme
jumeau, le brouillon n'est pas sauvé — et chaque run similaire ré-apprend et
re-perd la même leçon, visible seulement dans les événements jev (fail-open
voulu, mais récurrent).

**Fermeture proposée :** filtrer les recettes à trigger de l'ensemble 'task',
symétriquement au chemin événement.

## 2. Défauts mineurs (LOW)

Tous confirmés par le vérificateur adverse ; « reproduit » renvoie à l'annexe.

| # | Défaut | Sites | Commit | Statut |
|---|---|---|---|---|
| 2.1 | La carte d'un run partiel « supplanté » promet que le prochain run continuera du run plus récent et masque la reprise, sans voir que le serveur exige que le workspace de ce run existe encore (`lstatSync`) et que `bytesExpiredAt` refuse — l'index ne porte pas l'état du workspace. | `src/viz/client-gl/partial-run.ts:73-83` ; `views/runs.ts:1416-1424,1537-1539` ; `src/projects/coordinator.ts:794-818` | `c2528856` | ✓ lu |
| 2.2 | Le marqueur de gel SANS nom (mode fallback : `ATOMA_DEPLOY_WAIT_SECONDS=0`, release de transition, dossier non inscriptible) survit à un reboot : toutes les écritures (login compris) répondent 503 jusqu'au prochain déploiement ou une suppression manuelle — le message de `55e9229d` (« a reboot no longer refuses every write ») ne distingue pas les deux modes. | `deploy/host-deploy.sh:296-299` ; `src/viz/deployment.ts:40-49` ; `src/viz/server.ts:2276-2281` | `55e9229d` | ✓ lu |
| 2.3 | La garde surveille son activateur root par pid seul (EPERM ⇒ vivant) : un SIGKILL de l'activateur suivi d'un recyclage du pid laisse lease et gel tenus par une garde immortelle — alors que `registerDeploymentPending` refuse précisément de fonctionner sans empreinte de naissance pour cette raison. Fenêtre de 250 ms, probabilité très faible. | `src/cli/deploy-preflight.ts:190,386` ; `src/mcp/runLock.ts:161-174,617-622` | `55e9229d`, `0d8998d5` | ✓ lu |
| 2.4 | Re-exécuter un vieux run CI de main (ou un CI lent croisant un plus récent — `cancel-in-progress` est désactivé sur main) redéploie une révision ANTÉRIEURE par-dessus la courante : aucun contrôle de monotonie entre `head_sha` et la génération servie. Pré-fenêtre (`7c5b4952`), exposition élargie par les déploiements longs. | `.github/workflows/deploy.yml:4,22,44` ; `deploy/host-deploy.sh:66` ; `ci.yml:15` | pré-fenêtre | ✓ lu |
| 2.5 | `partialUsage` est estampillé sur la raison d'abort PARTAGÉE du run : deux lanes qui expirent ensemble peuvent échanger/écraser leurs tokens payés (observabilité seulement). La fenêtre ajoute une instance (`llmChatCompletions`) d'un patron pré-existant (`llm.ts`, `codexToolLoop.ts`). | `src/core/llmChatCompletions.ts:170-177,191` ; `src/core/metrics.ts:252-266` | `3dc8b75c` (classe `e15d810`) | ✓ lu |
| 2.6 | Cache prefilter gardé : une décision du modèle prise sur un catalogue rétréci par un `withhold` NON DÉTERMINISTE (probabilités vivantes de Jev) est mise en cache sous la clé du catalogue complet, puis servie sans re-consulter Jev — « the key includes every decision input » (`src/atoms/AGENTS.md:136`) est contredit. Borné par l'expiration et le taux mesuré (1,7 %). | `src/atoms/cost.ts:744,760,782-788,809-830` ; `src/core/jev.ts:671-679` | `8ecfed53`, `ff7242bb` | ✓ lu |
| 2.7 | Les réponses d'APPROBATION de Jev ne sont pas bornées à [0,1] : une probabilité 1.4 ou un noul −0.4 passe les seuils et crédite trust — alors que `readCompilation` valide exactement ces bornes. Suppose un service TypeSafe mal calibré. | `src/core/jevQuestions.ts:712-736` vs `:906-911` ; `src/core/jev.ts:135-142` | `e83f5ce7`, `3eae5b06` | ✓ lu |
| 2.8 | `calibrate()` : sous annulation client, un worker interrompu laisse un trou tandis qu'un index supérieur a abouti ; `resumeAt` = premier trou ⇒ le rappel re-demande et re-paye des décisions déjà répondues (doublons dans deux `resultIds`). | `src/atoms/jevCalibration.ts:651-706` ; `src/mcp/jevCalibrate.ts:276-286` | `8a046366` | ✓ lu |
| 2.9 | TOCTOU : `atoma_run_trace` d'un run de projet répond « no trace at `<chemin hôte absolu>` » si la trace disparaît entre la résolution et la lecture (rotation/archivage) — la seule branche de `runTraceFile` que la rédaction `289a70fc`/`1a3770d6` a manquée ; le paramètre `label` existe précisément pour cela. Reproduit. | `src/mcp/readers.ts:598` ; `src/mcp/tools.ts:461-469` ; `src/projects/store.ts:537-549` | `289a70fc`, `1a3770d6` | reproduit |
| 2.10 | Sur darwin (mode chemins — la production Linux passe par `/proc` et n'est pas exposée), un échec de restauration read-only injecte le chemin hôte ABSOLU dans la raison rendue au summary et au bloc accepteur, lus par le tenant. | `src/run/readOnlyPhase.ts:187-193,203-209,167-170` ; `src/contracts/readOnlyPhase.ts:185-199` | `527b3b55` | ✓ lu |
| 2.11 | Le budget processus des fetches CIMD (30/min) est épuisable anonymement (6 adresses × 5/min, ids jetables, l'échec consomme sans remboursement) : le PREMIER consentement d'un nouveau client CIMD est refusable par un tiers ; les clients déjà vérifiés survivent (stale). DCR reste le contournement. | `src/auth/clientMetadata.ts:31-33,277-290` ; `src/auth/mcpOAuth.ts:188-190` | `bfee277c` | ✓ lu |
| 2.12 | La rédaction des chemins hôte ne couvre que l'orthographe BRUTE : un chemin Windows échappé par `JSON.stringify` (`C:\\Users\\…`), percent-encodé (`%20`) ou à séparateurs avant traverse `redactHostPaths` — exposition réelle limitée à un hôte Windows ou un texte encodé. Reproduit. | `src/projects/hostPaths.ts:24-41` ; `src/projects/service.ts:90-91` ; `src/mcp/readers.ts:571` | `1a3770d6` | reproduit |
| 2.13 | Reprise de session MCP : un id de session inconnu de forme UUID présenté par N'IMPORTE QUEL appelant authentifié est ré-ouvert lié à CE présentateur ; le vrai propriétaire reçoit 401 (et la session est droppée — déni par rejeu actif, pas fixation durable ; exige la fuite de l'id + un token valide). | `src/mcp/http.ts:135,373-374,380-385` | `e66c7b13` | ✓ lu |
| 2.14 | Le budget d'un run projet est re-résolu DANS la closure `launch()`, après la préparation (jusqu'à 10 min) : un resserrement admin des limites entre réservation et lancement fait échouer un run déjà réservé — la forme exacte que le commentaire de la porte (« never a row left to fail at launch ») dit avoir éliminée. | `src/projects/coordinator.ts:1357,1551-1553,1038-1070` | fenêtre (série run-limits) | ✓ lu |
| 2.15 | Le marquage `[STALE]` (lecture réécrite ensuite) échoue silencieusement dans la direction dangereuse : clé = orthographe brute du modèle (`././x` vs `x`), et le chemin est relu par `JSON.parse` d'un extrait TRONQUÉ (> 800 octets ⇒ jamais stale). Reproduit (A vrai, B/C faux). | `src/contracts/attestation.ts:180-185,199-205,325-353` | `1809922f` | reproduit |

Écarté après vérification de l'auteur : le TOCTOU du port de `start_node_server`
(`57f64b61`) est un arbitrage documenté dans le code même (« the close→spawn
race window is real but tiny, and the EADDRINUSE retry path covers exactly
that loss », `builtin.ts:935-940`).

## 3. Documentation, contrats écrits et décisions en attente

- **D1 — 4.E (visibilité des payeurs) toujours non actée.** La docstring de
  `getRunPayers` (`src/projects/store.ts:1772-1776`) qualifie encore cette
  visibilité d'« open product decision » pendant que `publicRun` sert le ledger
  payeur à tout rôle de l'org, et que la surface s'étend (`d945421`, puis
  `bee2e2cf` hors fenêtre). À acter ou retirer avant qu'elle ne s'élargisse.
- **D2 — 4.F (persistance des listes rédigées) non actée.** Un run ordinaire ne
  persiste toujours pas sa liste rédigée ; 2.1 du 25/09 reste fermé par refus
  (409 après rétention), comportement voulu par `654c404` mais que 4.F aurait
  évité. Décision propriétaire.
- **D3 — Fermeture 2.6 du 25/09 partielle sur le sélecteur de production,
  assumée.** Un refus de quota Codex reste `session-failed` (pas de pause, run
  sorti de la file) — arbitrage documenté à `src/supervisor/AGENTS.md:139-141`
  « until its app-server reports a typed status to read ». Signalé pour le
  suivi, pas comme défaut.
- **D4 — Commentaire périmé de `jevCalibration.ts:47-50`** (« reads only the
  organisations the host admits to Jev ») : faux depuis `76e1c517` (toutes les
  organisations). Une fenêtre `since` antérieure au 2026-09-30 envoie à
  TypeSafe des décisions d'organisations qui ne lui avaient jamais rien
  transmis — acte d'opérateur plateforme journalisé, mais la phrase qui le
  justifie est fausse ; réécrire ou borner la fenêtre.
- **D5 — `atoma_jev_calibrate` : rétention « per principal » annoncée, FIFO
  GLOBAL de 10 implémenté** (`jevCalibrate.ts:45,127-134` vs l'en-tête du
  fichier et `src/mcp/AGENTS.md`) : deux admins qui calibrent en parallèle
  s'évincent, la relecture « gratuite » redevient payante.
- **D6 — Caps du replay dupliqués hors `webCheck.ts`**
  (`inheritedChecks.ts:187,193,195` redéclare 3000/120/500) contre la règle
  que `src/contracts/AGENTS.md` énonce (« webCheck.ts holds that reading …
  which the tool, the merge and the inherited-check replay all import »).
- **D7 — Un point de prix FUTUR ne prend effet qu'au prochain démarrage de
  processus** (`DEFAULT_PRICES` figé au chargement, documenté dans le code) ;
  `src/core/AGENTS.md:115-117` présente le point futur sans cette réserve, et
  `pricesAt`, promis comme « re-prices old usage », n'a aucun appelant de
  production.
- **D8 — Colonnes du ledger catalogue en constantes** (`ledger.ts:35-36` :
  118/170 px) contre la règle viz « widths are measured, never a constant » ;
  même constante préexistante dans `journal-row.ts:95`. Dégradation propre
  (ellipse + bulle) ; à mesurer ou à exempter explicitement.
- **D9 — `ATOMA_MENDER_GIT_AUTHOR` : le check CLA devient vert sur un commit
  que l'auteur nommé n'a pas encore relu.** Décision propriétaire documentée
  (« A PERSON AUTHORS, THE HARNESS COMMITS » ; défaut non résoluble, committer
  = harness, trailer, PR = porte humaine) — observation d'attestation : rien ne
  vérifie le consentement de la personne que `mender.env` nomme.
- **D10 — `localhost` admis comme graphie loopback** (`clientMetadata.ts:51,
  60-61`), arbitrage commenté dans le code, mais `docs/mcp-oauth.md` cite
  RFC 8252 §7.3 sans signaler l'écart avec §8.3 (préférer `127.0.0.1`/`[::1]`).
- **D11 — Un timeout de recherche documentaire tue le processus Haystack
  partagé** : toutes les recherches suivantes du run répondent `unavailable`.
  `ab93554a` a élargi le budget (2 s → 10 s, 5× le coût mesuré) sans changer la
  cascade — mode résiduel assumé par le message de commit, non documenté dans
  un AGENTS.md.
- **D12 — Les suites restore/lock critiques ne s'exécutent jamais sur la
  machine de développement** (10+ gardes `skipIf` win32/posix ajoutées dans la
  fenêtre : read-only-phase, mcp-run-lock, shared-learning-acceptance,
  analyst/mender). Arbitrage technique raisonnable (modes POSIX, process
  groups) ; un `npm test` Windows vert prouve moins que ce que la fenêtre a
  ajouté — la CI Linux reste le gate du déploiement.

Vérifié exact par la relecture documentaire, entre autres : 41 outils
`atoma_*` (README, AGENTS.md racine et `docs:check` alignés) ; chaque script
npm annoncé existe ; 13 catalogues de locales et contrat i18n tenu sur toute
la fenêtre (seuls les 8 commits bot touchent les catalogues non-EN) ; douze
critères max ; `server.json` aligné sur la version packagée et testé ;
`scripts/demo-film` présenté comme outillage de dev uniquement (narrate.py :
edge-tts, aucune clé d'API, le texte de narration seul quitte la machine) ;
les liens des 59 documents et de l'archive `d795bcfc` résolvent tous ;
l'entrée du 25/09 dans `docs/code-reviews.md` est exacte ; les récits
d'incidents de la fenêtre citent des commits qui existent (byte-honest) ;
`01e90c91` (retrait du cooling-off) est cohérent de bout en bout. La relecture
documentaire n'a produit AUCUN finding — une première.

## 4. Incohérences et limites de conception

### A. Un schéma de sortie est un contrat de compatibilité, pas une décoration

1.1 est la troisième occurrence de la même classe en deux jours
(`ledger_tail` le 2026-10-01, `costs` et `sentinel_health` ici). La règle
existe (`src/mcp/AGENTS.md` : « loose, passthrough-shaped … Never add an
outputSchema a payload can miss ») ; ce qui manque est le test mécanique qui
la tient : un test qui appelle CHAQUE outil à schéma de sortie via le vrai
client SDK, plutôt qu'un test par outil incriminé.

### B. Les instruments de mesure doivent être exacts là où ils décident

1.2 (clients 2025 repris) et 1.4 (audits Jev du chemin d'échec) biaisent tous
deux une métrique de DÉCISION (fin de l'ère 2025 ; calibration des seuils
Jev), dans la direction qui pousse à la décision. Une mesure qui alimente une
règle documentée mérite le même traitement qu'un contrat : un test qui la
prouve sur le chemin défavorable (restart, échec), pas seulement sur le chemin
nominal.

### C. Chaque nouvelle source de refus doit atteindre les gardes qui énumèrent les sources

1.11 (soleRefusalReason), 1.5 (judgements), et la fermeture du 25/09 montrent
le même motif : un garde qui énumère des cas (quatre raisons de refus, les
sources de couverture) se périme silencieusement quand une couche en ajoute un
cinquième. Les endroits qui énumèrent (`soleRefusalReason`, la condition
`review` de `rootAcceptance`, `renderInheritedChecksBlock`) devraient
consommer une liste que le producteur étend, ou un test devrait recenser les
sources et les gardes ensemble.

### D. Les valeurs sentinelles exigent une définition unique de la validité

1.8 (« 0 = illimité » valide ici, invalide là) est 4.B du 25/09 sous une autre
forme : trois couches re-valident la même valeur avec des règles divergentes.
L'exception doit vivre dans UNE fonction que le schéma HTTP et la relecture
dérivent.

## 5. Ce qui tient bien dans cette fenêtre

- **Les fermetures du 25/09 tiennent pour la classe** — détail en section 6.
  En particulier `storedRunTierModelsSchema` ferme 4.B avec la règle écrite
  dans `src/contracts/AGENTS.md:266` ; la finalisation deadline+45 s couvre
  désormais aussi le plafond de budget (`abortedForLanding`) ; le seam
  d'attestation par acteur a tenu face aux replays d'octobre (toutes les
  lectures superviseur passent par `baseExecutorOf`, le replay hérité n'est
  jamais attesté, `hostReplay` est dépouillé des surfaces modèle sur les trois
  tiers).
- **Jev est fail-open borné, coupable et attribuable.** Toute défaillance rend
  null (le modèle décide), délai 2 s + un retry, disjoncteur à 3 échecs par
  run ; `ATOMA_JEV=0` coupe tout (runner, coordinator, calibrate) ; le prix vit
  dans la formule unique ; la clé est scrubbed de tout texte d'erreur ; les
  événements portent `failure`, jamais `error`, pour ne pas devenir des
  verdicts d'analyste ; un withhold qui vide le catalogue escalade au lieu de
  servir un catalogue vide.
- **La bascule deux ères est propre côté sessions et tâches.** Les fermetures
  1.3/2.11 du 25/09 ont survécu au portage SDK v2 ; la tâche d'un run de
  projet EST le run persisté (liée org + principal, échec fermé, lisible après
  éviction et redéploiement, lease libéré par le run lui-même) ; le gel
  d'écriture est jugé par ce que FAIT le message, côté serveur ; l'admission
  réserve avant d'allouer et l'anneau de replay est borné en frames et en
  octets.
- **Le pipeline de déploiement est défendu en profondeur.** L'annonce pending
  meurt avec l'identité de naissance de son gardien ; le préflight 75 distingue
  refus, garde cassée et usage ; aucune écriture du store produit avant le
  stop ; échec de préparation = ancienne génération intacte, échec de santé =
  restauration complète ; la CI exige les deux moitiés explicitement
  (`if: always()`, un job sauté ne lit jamais vert).
- **CIMD OAuth : l'anti-SSRF est fermé en profondeur** (HTTPS canonique, pas
  d'IP littérale/décimale/hex, lookup vérifié DANS le socket — pas de TOCTOU
  rebinding —, adresses privées et propres refusées, pas de redirection, 5 KiB,
  budgets), le client_id est vérifié contre le contenu du document, un client
  CIMD ne peut pas obtenir platform par lui-même (rôle relu en direct à chaque
  `resolveApiToken`), et les raisons de révocation sont un enum fermé qui ne
  sort que dans le journal plateforme.
- **Le mender est réellement sous porte humaine.** Aucun chemin de merge dans
  le code, branche toujours `mender/`, ruleset serveur, modèle sans credential
  ni socket engine, commandes réseau-none ; l'idle gate tient (bail réel sans
  récupération pendant tout le mend, le coordinateur ne préempte que
  `analyst:`) ; un verdict ancien n'est pas perdu (`--verdict` ne filtre pas
  par date).
- **Les salvages de parsing sont bornés et mesurés** (fuzz 20 000 : 0 fusion
  pour la version livrée), ne concurrencent jamais un parse sans perte, lisent
  les noms de membres dans la SOURCE, et l'AGENTS interdit de les élargir sans
  observation.
- **La qualité des tests de la fenêtre est réelle** : aucune assertion
  affaiblie (les 69 `expect` retirés correspondent tous à des décisions
  documentées), aucun `.only`, les deux ères testées via de vrais serveurs et
  les deux clients SDK, les tâches prouvées sur un host RECONSTRUIT, la revue
  adverse des limites encodée en une-régression-par-finding, l'anti-SSRF
  couvert en profondeur.
- **La vérité documentaire est tenue** — zéro finding sur README, CHANGELOG,
  AGENTS.md et les récits d'incidents de la fenêtre (section 3, dernier
  paragraphe).

## 6. Fermetures des findings du 25 septembre

| # du 25/09 | Verdict | Justification |
|---|---|---|
| 1.1 schéma de rerun vs catalogue | **fermé (classe)** | Relecture par orthographe seule (`storedRunTierModelsSchema`), autorité redemandée au lancement, règle 4.B écrite dans `src/contracts/AGENTS.md:266`. Aucune autre relecture zod de données persistées nommant un modèle ne casse (cherchée). |
| 1.2 travail fini perdu à la deadline | **fermé (classe), élargi** | `finalizationSignal` absolu pour tout travail en main ; remédiation coupée atterrit sur le premier refus ; `synthesizeOrKeep` garde les sous-résultats ; le plafond de budget est désormais un atterrissage aussi. `349e8f0c`/`81276fa9` n'y ouvrent pas de travail non borné. |
| 1.3 éviction d'un appel en cours | **fermé (classe)** | GET repreneur épinglé tant que la réponse est due, `reclaim` n'évince jamais une session qui répond (503), le plafond ferme l'appel seul ; porté intact sur SDK v2 et RENFORCÉ par `254cf198` (la tâche projet survit aux sessions). Réserve : 1.2 de cette revue (comptage), et 2.13 (reprise par un tiers). |
| 1.4/1.6/2.4/2.10 contrat de preuve | **fermé (classe), tenu sous pression** | Acteur attesté partout (`baseExecutorOf` sur les six chemins superviseur), `record_probe` attesté, viewport dans l'observation/la ligne/la clé d'oscillation, 8 lignes navigateur réservées. Les replays d'octobre (`a697acaa`) passent par le base executor et ne sont jamais attestés. |
| 1.5/2.3 grammaire des critères | **fermé** | Statuts lus sous `404`/`→`/`(404)`/`.`, second statut refusé, ligne à statut hors position refusée, taille encodée bornée à la porte. Réserve nouvelle, autre couche : 1.5 de cette revue (appariement des judgements). |
| 1.7 recherche doc après approfondissement | **fermé** | Le service appartient au run, seul `cleanup` dispose ; test de restart ajouté. |
| 2.1 checklist irrécupérable | **fermé (par refus)** | 409 sur origine irrécupérable, `bytesExpiredAt` consulté, `ATOMA_ACCEPTANCE_SOURCE=none` pour une origine jugée sans liste. 4.F reste une décision propriétaire (D2). |
| 2.2 chemins hôte vers les tenants | **fermé** sur les surfaces citées (module unique `hostPaths.ts`, log rédigé, erreurs run/publication rédigées). Deux résidus de bord nouveaux : 2.9 (branche TOCTOU) et 2.12 (orthographes échappées). |
| 2.6 quota de l'analyste résident | **partiel, assumé** | Fermé pour le wrapper `claude -p` ; le chemin Codex (production) reste `session-failed`, arbitrage documenté (D3). |
| 2.7/2.8/2.9/2.11/2.12/2.13/2.14 | **fermés** | Vérifiés un à un : `rerunOf` porté partout, `direct` sans exécution (tient face à `ee727736`), entrée harnais réparée pas supprimée, plafond par appel + `ATOMA_MCP_MAX_REQUEST_MS`, journal avant teardown, pins par tier dans le client GL, compte `--once` corrigé. |
| D1–D11 | **fermés** | Spot-checks tenus (conteneur = runs projet, incomplets/reruns/confinement dits tels quels). |
| D12 compilation des recettes | **fermé** | `ee727736` + décision propriétaire `compile-at-learn-2026-09-26.md` ; README, racine et skills alignés. Le zéro `kind:script` en production est une politique du compilateur (recettes de build irréductibles), pas une régression de chemin ; `7367f975` rend l'éligibilité retryable sans boucle non bornée. |
| 4.A–4.D | **actées** | Finalisation = un contrat (`cost.ts`), 4.B écrite dans contracts/AGENTS, acteur dans le journal de preuve, grammaire refuse-ou-capture. |
| 4.E, 4.F | **toujours ouvertes** | D1, D2 de cette revue — décisions propriétaire. |

La passe adverse des corrections du 26/09 (`94aec19`…`c252885`) tient aussi :
vérifiée site par site dans la relecture des fermetures.

## 7. Vérification exécutée

Environnement : dépôt de travail Windows (hôte de développement), Node
v24.16.0, npm 11.13.0, dépendances en place. Un agent pair commitait sur main
pendant la revue ; toutes les citations ont été prises via `git show cc631bb6:`
et les reproductions rejouées uniquement sur des fichiers identiques entre
`cc631bb6` et le HEAD du moment (vérifié par diff). Aucun appel modèle payant,
aucun conteneur, aucun store utilisateur modifié, serveurs sur ports éphémères
loopback uniquement.

- **`npm run docs:check` : VERT** (41 outils MCP, 18 sous-systèmes, 500 lignes
  racine, liens résolus). **Typecheck (les deux tsconfig) : VERT. Lint :
  VERT. `npm audit` : 0 vulnérabilité.**
- **`npm test` sur l'hôte Windows : 390 des 394 fichiers terminés, 5 117
  tests, 0 échec, 101 ignorés** (gardes plateforme win32/posix, cf. D12). La
  suite ne se TERMINE pas sur cet hôte : les trois suites d'isolation
  conteneur (`container-isolation`, `preview-egress`, `preview-isolation`)
  attendent indéfiniment le moteur Docker, arrêté sur la machine — sous WSL
  elles sautent, sous Windows le CLI Docker bloque quand Docker Desktop est
  éteint (constat d'environnement, deux passes identiques). Le quatrième
  fichier restant, `reasoning-delivery`, passe en isolation (6/6 ; un rouge
  unique observé immédiatement après l'arrêt forcé de la suite, sous
  contention, repassé vert). La CI Linux, qui exécute l'intégralité —
  isolation worker comprise — est la preuve de référence.
- **CI GitHub : verte sur toute la fenêtre.** Chaque push de la fenêtre a
  déployé sa révision en production (`ATOMA_DEPLOY_ENABLED`), `cc631bb6`
  compris (2026-10-01 21:04 UTC).
- **Reproductions : dix scripts rejoués par l'auteur** (1.1, 1.2, 1.3, 1.5,
  1.6, 1.7, 1.8, 1.9, 2.9-annexe, 2.15, plus le contrôle positif de 1.5) —
  tous reproduisent ; trois autres (1.4, 1.10, 1.11, 1.12) exécutées par les
  vérificateurs à la référence, fichiers modifiés ensuite par le pair hors
  fenêtre. Scripts et sorties dans l'annexe.
- **Non exécutés :** smoke navigateur, isolation Docker/gVisor, exercices de
  production, appels TypeSafe réels.

La suite verte ne contredit aucun finding : aucun test n'exerce les
compositions en cause (schéma de sortie validé par le CLIENT, reprise après
restart comptée, bail Codex pendant une préemption, id de judgement dévié,
kept=0 à l'acceptation…), comme l'indique chaque section.

## 8. Priorités et statut

**P1 :** 1.1 (deux outils platform inutilisables depuis le client principal,
en production aujourd'hui ; le balayage des 41 schémas et le test SDK
catalogue-entier avec lui). Puis 1.5 (la garde d'acceptation des listes USER
est le contrat le plus visible du produit) et 1.10 (un filet qui ne dit pas
qu'il n'a pas tourné).

**P2 :** les instruments de mesure (1.2, 1.4) ; la perte d'analyses (1.3) ; le
catalogue et les pins (1.6, 1.7, 1.8) ; le snapshot livré (1.9) ; le scope de
remédiation (1.11) ; le twin guard (1.12).

**P3 :** les LOW de la section 2 (notamment 2.2/2.3 côté déploiement et
2.9/2.12 côté rédaction) et les constats D4–D8, D10–D11.

**Décisions propriétaire :** D1 (4.E, visibilité des payeurs — la surface
s'étend), D2 (4.F, persistance des listes), D9 (attestation CLA du mender,
déjà documentée — à confirmer en connaissance de cause), 2.4 (contrôle de
monotonie du déploiement).

Statut : findings ouverts, aucun correctif appliqué. Cette revue ajoute ce
rapport, son [annexe de preuves](../../incidents/code-review-2026-10-02-evidence.md)
et son entrée dans l'[index des revues](../../code-reviews.md).
