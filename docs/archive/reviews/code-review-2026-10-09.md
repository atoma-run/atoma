# Revue critique — fenêtre 2026-10-02 → 2026-10-09 (275 commits)

Date : 2026-10-09.
Référence examinée : `c07e3548e3702a2f5fc50f67cd55778c9dd03753` (HEAD de `main` au
début de la revue, ancêtre de `origin/main`). Fenêtre : `cc631bb6..c07e3548`,
275 commits (21 merges, 37 commits de traduction du bot, 2 commits de
dépendances), 1 112 fichiers, +182 066 / −6 527. Sur ce total, `benchmark/` et
`docs/incidents/` (preuves d'expériences archivées) comptent 525 fichiers et
+125 355 lignes ; la source seule (src, tests, scripts, deploy, docker, CI,
plugins, hors catalogues traduits) compte 524 fichiers, +38 841 / −5 830.

La précédente revue générale est celle du [2 octobre](code-review-2026-10-02.md),
qui examinait `cc631bb6`. Ses corrections (section 9 de ce rapport, `0b02fa7c`,
`48afbb4e`) sont dans cette fenêtre ; la section 6 vérifie ces fermetures.

Méthode : seize relectures indépendantes par domaine (fermetures du 2 octobre ;
atoms ; run ; MCP ; projets et GitHub ; core ; tools ; skills et registre ;
auth ; assistant intégré ; viz serveur ; viz client ; preview ; déploiement, CI
et scripts ; contrats, docs et tests ; balayage sécurité transversal). Chacune
a lu le `AGENTS.md` de son sous-système et sa section « Intentional choices and
rejected shortcuts », le diff de son périmètre et le code environnant, dans un
worktree propre de la référence. **Chaque piste a ensuite été soumise à un
vérificateur adverse chargé de la réfuter** : gardes amont, invariants
d'appelants, arbitrages écrits ; reproduction réexécutée pour les HIGH et
MEDIUM, et réécrite de bout en bout quand la repro d'origine construisait un
état à la main (1.2, 1.3, 1.1, 1.8). Les vérificateurs ont été groupés par
domaine (sept) plutôt qu'un par piste, et une première vague de relecteurs,
coupée par le quota de session, a été relancée pour ses neuf domaines perdus.
Sur 69 pistes, 45 ont été confirmées, 15 reclassées, 8 réfutées, une est restée
non vérifiable ; les pistes réfutées ne figurent pas comme findings. Une piste
(1.5) a été trouvée par un vérificateur, puis vérifiée par l'auteur. Les
reproductions des HIGH et MEDIUM ont été **rejouées par l'auteur** à la
référence (onze scripts et trois variantes, tous reproduisent) ; 1.10 a été
reproduit par l'auteur dans un export propre.

Convention : **✓ = lu dans le code à cette référence ; reproduit = expérience
locale exécutée, scripts dans
l'[annexe de preuves](../../incidents/code-review-2026-10-09-evidence.md)**.
Les lignes citées sont celles de `c07e3548`. Aucun correctif n'est appliqué par
cette revue. Le dépôt a continué d'avancer pendant la revue
(`c07e3548..fc970829`, six commits) ; ces commits relèvent de la prochaine
revue.

## Vue d'ensemble

La fenêtre livre six chantiers : la **continuation durable** (checkpoints de
phase, pause et reprise, reprise après crash depuis des snapshots scellés,
questions client durables et replan après réponse) ; l'**acceptation client
avant publication**, avec contexte projet versionné, synchronisation du dépôt et
protection des éditions client ; l'**app MCP** (revue de livraison, visionneuse
de fichiers, décisions client) sur le SDK 2.3.0 et les tâches 2026 ;
l'**assistant intégré**, avec modèles financés par le client et abonnement
Claude Code personnel (bêta) ; le **transport Codex app-server** en un seul
thread et le **routage des tissues par Jev** avec un auteur L3 plateforme ; la
**vitrine publique**, le **terminal CLI de preview**, les thèmes et la
navigation du client GPU. S'y ajoutent de nombreux correctifs de validation
(revue ciblée des critères, revue des livraisons texte, preuves héritées).

**Les fermetures du 2 octobre tiennent** : aucune n'est rouverte, 18 sont
fermées pour la classe et 7 pour le scénario seulement (section 6). La classe
du HIGH 1.1 du 2 octobre, un schéma de sortie fermé que le payload déborde, est
tenue sur les 14 outils à `outputSchema`, prouvée par les vrais clients
validants des deux ères.

Les défauts confirmés se concentrent sur **la continuation durable**, ajoutée
dans cette fenêtre. Sa doc promet que le checkpoint ne fait jamais échouer un
run valide ; quatre findings montrent l'inverse : une pause dont les processus
écrivent à l'arrêt (1.1, HIGH), un contrôle d'identité placé après la
consommation de la source (1.4), un semis qui déforme les liens que le
checkpoint doit copier tels quels (1.5), une frontière de question sans la
dégradation de sa voisine (1.6). Trois classes déjà connues reviennent :
**un silence qui redevient un verdict** (une revue de critères aveugle à la
réponse texte, 1.2 ; un replay hérité qui n'a rien pu rejouer et ne le dit pas,
2.1) ; **un plafond écrit que le mécanisme n'applique pas** (le cap de serveurs
node, 1.8 ; le budget de refus Codex, 1.7 ; la copie du terminal plus grande
que son tmpfs, 2.10 ; deux bornes d'historique dont une seule est vérifiée,
2.4) ; **une règle établie que le chemin suivant ignore** (le consentement
« la personne décide » posé le 4 octobre et absent de l'acceptation le 8, 2.2 ;
la rédaction des messages de bail inter-organisations, corrigée pour le
démarrage et réintroduite sur la publication, 2.3 ; l'isolation des stores de
test écrite dans AGENTS.md et contredite par un test modifié dans la fenêtre,
1.10). Enfin, l'acceptation client est liée aux octets exacts, ce qui tient,
mais pas à la lignée : publier dans l'ordre chronologique deux livraisons
acceptées peut perdre les éditions de la seconde (1.3).

**Bilan : un finding HIGH et dix MEDIUM, tous reproduits et rejoués par
l'auteur sauf 1.11, établi par lecture du matcher de Claude Code ; trente et un
LOW ; quinze constats documentaires et trois décisions propriétaire
nouvelles.** Le HIGH est en production depuis le 8 octobre : une pause,
demandée ou automatique, sur une phase dont le serveur persiste son état à
l'arrêt termine le run en échec.

## 1. Bugs confirmés, par gravité

### 1.1 ✓ HIGH (reproduit, rejoué) — Une pause sur une phase dont un processus du run écrit à l'arrêt fait échouer le run, et la question client posée à cette frontière devient irrépondable

- **Fichiers** : `src/run/checkpoint.ts:409-415` (`afterPhase` scelle le
  snapshot pendant que les serveurs de la phase tournent) et `:332-345` (même
  scellement pour une question client dans `beforePhase`) ; `:436-443`
  (`release()` re-digère tout l'arbre et lève « Workspace changed during
  shutdown ») ; `src/run/runner.ts:1531-1541` (sur `PhaseBoundaryPause` :
  `backend.drain()` puis `checkpoint.release()`, et en cas d'erreur
  `finalizing()` puis le chemin d'échec, `outcome: 'failed'` à `:1609`) ;
  `src/tools/sandbox.ts:306-309`, `:331-361` (`drain` : SIGTERM de groupe,
  150 ms, puis SIGKILL) ; `src/run/clientQuestions.ts:46-47` (une réponse exige
  `state='ready' AND released=1`). Commits : `05713a6b`, `c1274236`, `36d0b23c`.
- **Mécanisme** : `start_node_server` laisse ses serveurs vivre jusqu'à la fin
  du run (`src/tools/builtin.ts:1526-1532`) et aucune garde ne refuse une pause
  quand des processus vivent. La frontière scelle un digest de tout l'arbre,
  sans exclusion de journaux, de WAL ni de caches
  (`src/run/checkpointWorkspace.ts:8-66`). Le runner draine ensuite : SIGTERM
  d'abord, donc les handlers d'arrêt de l'application s'exécutent. Le même ordre
  vaut dans le worker conteneur (`remoteWorker.ts:112-114`,
  `localWorker.ts:230-249`, `worker.ts:55-61`). Une application qui persiste
  son état à l'arrêt, ou une base SQLite en WAL fermée proprement, change
  l'arbre ; `release()` refuse, et l'erreur suit le chemin d'échec générique :
  les phases validées sont jetées, sans résultat partiel ni atterrissage. Pour
  une question client, la ligne est déjà insérée dans la transaction du
  scellement (`checkpoint.ts:180`), puis `answerClientQuestion` la refuse pour
  toujours.
- **Scénario** : run projet profond dont la phase 1 démarre et vérifie une API
  de notes, avec persistance JSON sur SIGTERM ou `better-sqlite3` en WAL fermé
  à l'arrêt. Le client clique « Pause after the current phase », ou
  l'évaluateur pose une question avant la phase 2, ou il reste moins de 60 s de
  budget de phase, ce qui déclenche la pause automatique (`checkpoint.ts:422`).
  Le run finit `failed`. La pause automatique rend le déclencheur fréquent sur
  les runs longs.
- **Preuve** : reproduit avec le vrai drain (`localToolBackend`,
  `start_node_server`, `backend.drain()`, puis `release()` dans l'ordre de
  `runner.ts:1531-1541`) et rejoué par l'auteur. Serveur sans handler :
  `release OK`, état `paused`. Persistance JSON sur SIGTERM : « Workspace
  changed during shutdown », état `unavailable`. WAL fermé sur SIGTERM : même
  échec. WAL sans handler : `release OK`.
- **Pourquoi ce n'est pas un choix documenté** :
  `docs/run-checkpoints-2026-10-08.md:37-38` vise les éditions de l'utilisateur
  (« refuses user edits »), pas les écritures d'arrêt des processus du run, et
  promet que le contenu non supporté désactive le checkpoint « without failing
  an otherwise valid project run ». `src/run/AGENTS.md` (« Run accounting »)
  veut qu'un run qui a du travail réel atterrisse. `tests/run-checkpoint.test.ts`
  ne met en pause que des phases sans serveur.
- **Vérification adverse** : HIGH maintenu, avec une condition plus étroite que
  « un serveur vivant » : il faut une écriture d'un processus du run après le
  scellement. Nuance : la question n'est pas présentée comme en attente
  (`src/projects/service.ts:257` exige `paused`) ; elle reste lisible, sans
  réponse possible.

### 1.2 ✓ MEDIUM (reproduit de bout en bout, rejoué) — En profondeur `short`, une réponse texte est jugée par une revue de critères qui ne voit pas la réponse : une bonne réponse est refusée

- **Fichiers** : `src/atoms/rootAcceptance.ts:551-556` (le garde
  `args.delivery !== 'text'` envoie la revue focalisée par critères dès que
  `delivery` est absent, et son évidence ne contient jamais `result.output`) ;
  `src/atoms/criteriaReview.ts:12` (« You are not shown the candidate success
  report ») ; `src/atoms/L2Atom.ts:441-455` (le plan préfiltre est construit en
  code, sans `delivery`) ; `src/atoms/json.ts:1047` (seul producteur de
  `delivery` : le plan modèle, `nullish`). Commits : `738cf801`, `196e6bbb`,
  `fc65f617`.
- **Mécanisme** : `delivery` n'est posé que par le plan du modèle ; rien en
  amont ne le déduit, pas même la classification de livrable de `src/preview`,
  qui vient après le run. Le raccourci préfiltre de `L2Atom.plan`, chemin
  nominal de la profondeur `short` (`tests/depth-runner.test.ts:315-316`),
  construit un plan sans ce champ. À l'acceptation racine, `delivery` vaut
  `undefined`, le garde le traite comme une livraison de fichiers, et la revue
  focalisée juge chaque critère USER sans voir la réponse texte : elle répond
  « unverified » et refuse. La référence texte et le modèle L2 de revue texte
  (`196e6bbb`) ne tournent pas non plus.
- **Scénario** : `atoma_run_start` en profondeur `short` (option publique,
  `src/mcp/tasks.ts:359`) avec une liste de critères USER, pour une question
  dont la réponse est un texte. En passe 1, le relecteur global approuve et la
  revue par critères refuse. La remédiation consomme l'unique passe racine
  (`MAX_ROOT_REMEDIATIONS`). Si le plan de la remédiation pose
  `delivery: "text"`, le run livre au double du coût ; s'il l'omet aussi, le run
  finit refusé sur « c1: unverified: no answer text supplied ».
- **Preuve** : reproduit de bout en bout par le vérificateur
  (`runDepthTask('short')` et le handle exact de `runner.ts:1186-1189`, vrai
  `L2Atom.plan` préfiltre, vrai `L1Atom`, modèle simulé qui ne juge un critère
  satisfait que s'il voit la réponse) et rejoué par l'auteur. Bras A : 14
  appels, refus en passe 1, livraison en passe 2. Bras B, même plan avec
  `delivery: "text"` : 7 appels, livré. Bras A avec un plan de remédiation sans
  `delivery` : refus définitif d'une réponse correcte.
- **Pourquoi ce n'est pas un choix documenté** : `src/atoms/AGENTS.md:89-96`
  distingue les livraisons fichier et texte, mais aucune règle ne traite un
  `delivery` absent, et « Intentional choices » n'en dit rien.
  `tests/criteria-review.test.ts` n'utilise que des livraisons `{ files: [...] }`.
- **Vérification adverse** : MEDIUM confirmé. La direction « approbation
  complaisante » est faible, car l'approbation globale voit la réponse : le
  défaut est un refus faux et une passe payée. Aggravation lue, non
  reproduite : sans liste USER, une réponse texte approuvée sans `delivery` ni
  fichier tombe sur `ArtifactPolicyError('empty')` (`src/projects/artifacts.ts:406`).

### 1.3 ✓ MEDIUM (reproduit de bout en bout, rejoué) — Publier un run accepté plus ancien après la synchronisation d'un run plus récent non accepté fait perdre les éditions acceptées du second

- **Fichiers** : `src/projects/publisher.ts:725-731` (porte de lignée : un run
  ultérieur ne bloque que s'il est `queued`, `running`, ou livré ET accepté) ;
  `:705-723` (porte d'ordre : seul le dernier run PUBLIÉ compte) ; `:430`,
  `:736`, `:747-749` (base de sync enregistrée, faux conflit) ;
  `src/projects/coordinator.ts:888-912` (`previousSeedRun` prend le run livré
  le plus récent, accepté ou non) ; `src/projects/store.ts:2222-2238` (tout run
  livré retenu est acceptable, pas seulement le plus récent). Commits :
  `73e251f1`, `a5733590`.
- **Mécanisme** : un run Y lancé après un run X livré mais non accepté a X pour
  graine, et sa base de sync est l'état distant au démarrage de Y. Le client
  accepte X, qui est publié, puis accepte Y. Pour Y, le commit d'Atoma qui
  publie X ressemble à une édition client sur les fichiers communs : la sync
  déclare un conflit et n'écrit pas les modifications acceptées de Y sur ces
  fichiers. Le run suivant part de Y mais relit le dépôt : la valeur de X
  revient, celle de Y sort de la lignée.
- **Scénario** : ordre d'acceptation chronologique, le plus naturel pour un
  client qui teste ses livraisons dans l'ordre. Seuls l'événement `conflict`,
  qui met en cause le client, et le workspace de Y, jusqu'à son expiration,
  gardent la trace des octets perdus.
- **Preuve** : reproduit de bout en bout par le vérificateur
  (`ProjectService.acceptDelivery`, coordinateur et `GitHubPublisher` de
  production, faux GitHub des tests) et rejoué par l'auteur. W publié avec
  F=f0 ; X (F=f1) livré non accepté ; Y hérite de X et écrit F=f2 ; X accepté,
  dépôt F=f1 ; Y accepté, « published » mais dépôt toujours F=f1 ; Z, semé de
  Y, lit F=f1.
- **Pourquoi ce n'est pas un choix documenté** :
  `docs/repository-sync-2026-10-07.md:375-381` nomme ce risque (« fake a
  conflict ») et exige un refus « unless the run is the project's current seed
  run » ; X n'est pas la graine courante et passe.
  `src/projects/AGENTS.md:403-404` autorise la publication de X, pas la perte
  des éditions de Y.

### 1.4 ✓ MEDIUM (reproduit, rejoué) — La reprise vérifie l'identité de la tissue racine après avoir consommé la source : quand Meristem a changé de version, la continuation est perdue

- **Fichiers** : `src/run/runner.ts:1029-1032` (le constructeur de
  `SequentialCheckpoint` appelle `continueProject`) ;
  `src/run/checkpoint.ts:122-128`, `:287` (la source passe à `finished` et le
  successeur est réclamé dans une transaction) ; `src/run/runner.ts:1120-1128`
  (`seedTissueCatalog`, puis `tissueFor` lève « Saved root actor has changed;
  resume refused ») ; `src/run/tissues.ts:32-43` (Meristem patché à chaque run
  selon les outils hôte présents). Commits : `05713a6b`, `c1274236`, `958d4219`.
- **Mécanisme** : le checkpoint fige `actor.version`. Le contrôle de politique
  d'avant consommation (`runner.ts:867-877`) ne couvre pas l'acteur. Quand la
  version de Meristem a changé entre la pause et la reprise, la source est déjà
  consommée au moment du refus : elle devient `unavailable`, et le successeur
  reste `running`, bloqué `host_mutation` parce que son propre semis a écrit le
  registre.
- **Déclencheurs réels** : (1) un run opérateur MCP, benchmark ou CLI sur le
  store de production entre la pause et la reprise (`src/mcp/run.ts:439` retire
  `ATOMA_HAYSTACK_CONFIG`, donc l'outil `search_project_docs`, ce qui fait
  monter la version, et le successeur le rajoute) ; (2) un déploiement qui
  modifie `MERISTEM_SYSTEM_PROMPT` (trois fois en deux mois : `1d42b6ab`,
  `cfc5814c`, `958d4219`) ou ajoute un nom d'outil ; (3)
  `atoma_registry_rollback` de Meristem. Le déploiement étant armé à chaque push
  sur `main`, le cas (2) touche toute pause ou question en attente au moment
  d'un tel déploiement.
- **Preuve** : reproduit avec les vraies classes `AtomRegistry`,
  `seedTissueCatalog`, `RunCheckpointStore` et `SequentialCheckpoint`, rejoué
  par l'auteur : pause à v1, run sans corpus v2, successeur v3, refus, source
  `unavailable`, seconde reprise refusée. Limite : le contrôle de `tissueFor`
  est recopié (closure de `startTask`, inatteignable sans Docker pour un run
  tenant) ; l'ordre est établi par lecture.
- **Pourquoi ce n'est pas un choix documenté** :
  `docs/run-checkpoints-2026-10-08.md:101,158` promet que les changements de
  politique refusent « before model calls » et laissent les fichiers intacts ;
  rien ne prévoit un refus après consommation.
- **Vérification adverse** : reclassé de HIGH à MEDIUM. Le relecteur annonçait
  un déclenchement par n'importe quel run d'une autre organisation ; c'est
  faux, car tout run projet porte `search_project_docs`, même avec un corpus
  vide (`coordinator.ts:1915-1924`).

### 1.5 ✓ MEDIUM (reproduit, rejoué ; trouvé par la vérification adverse) — Le semis d'un run rend absolus les liens relatifs : pause, questions client et reprise sont désactivées en silence pour tout projet qui a des dépendances installées

- **Fichiers** : `src/run/workspace.ts:132-134` (`seedWorkspace` :
  `cpSync(seedRoot, workspaceRoot, { recursive: true })`, sans
  `verbatimSymlinks`) ; `src/run/checkpointWorkspace.ts:61-65` (un lien qui
  sort du workspace est refusé) ; `src/projects/coordinator.ts:1850` (`--seed`
  à chaque continuation de projet). Le semis date de `10f866f2` (2026-09-25) ;
  le défaut naît de sa rencontre avec les checkpoints de la fenêtre
  (`05713a6b`, `c1274236`).
- **Mécanisme** : sans `verbatimSymlinks`, `cpSync` réécrit chaque lien
  relatif en lien absolu vers la graine. `node_modules/.bin/vite ->
  ../vite/bin/vite.js` devient un lien vers le workspace du run précédent, que
  le digest de checkpoint refuse comme lien sortant. À chaque frontière,
  `afterPhase` dégrade avec un simple avertissement, « Durable continuation
  unavailable ».
- **Conséquence** : pour tout run semé dont la graine contient des dépendances
  installées, cas normal d'un projet Node continué, la pause, les questions
  client et « Recover » sont indisponibles sans erreur visible. Une question
  posée avant la phase 1 fait échouer le run (1.6).
- **Preuve** : vrais `seedWorkspace`, `checkpointWorkspaceDigest` et
  `SequentialCheckpoint` automatique, rejoué par l'auteur. Le lien relatif est
  absolu après semis ; sans question, l'avertissement s'affiche et le
  checkpoint est désactivé ; avec une question à la phase 0, « Checkpoint
  workspace contains an escaping link or special file ».
- **Pourquoi ce n'est pas un choix documenté** :
  `docs/run-checkpoints-2026-10-08.md:38` : « Relative internal dependency
  links are hashed and copied verbatim ». La copie de semis les déforme avant
  que le checkpoint les voie.

### 1.6 ✓ MEDIUM (reproduit, rejoué) — La frontière « question client » n'a pas la dégradation de `afterPhase` : un workspace non capturable à la phase 0 fait échouer le run

- **Fichiers** : `src/run/checkpoint.ts:344` (`beforePhase` appelle
  `store.boundary(..., question)` sans `try`), à comparer avec `:415-421`
  (`afterPhase` rattrape et dégrade) ; `src/atoms/dispatch.ts:116` (appel hors
  du `try` de la phase) ; `src/run/checkpointWorkspace.ts` (refus : fichier de
  plus de 10 MiB, plus de 100 000 fichiers ou 512 MiB, lien sortant, hardlink,
  arbre « still changing »). Commits : `e632dbcc`, `6a02e2c6`, `36d0b23c`,
  `c1274236`.
- **Mécanisme** : à la phase 0, le workspace est la graine. Si l'évaluateur pose
  une question avant la phase 1 et que le snapshot refuse son contenu, l'erreur
  sort de `dispatchSubtasks` et le run échoue (`src/run/depth.ts:263-290`
  relance toute erreur hors pause et budget). La transaction annule
  l'insertion de la question : le client ne voit qu'un run `failed`. Aux
  frontières suivantes ne reste que le cas « still changing », car un contenu
  non capturable aurait déjà désactivé le checkpoint à la frontière précédente.
- **Scénario** : projet continué dont le but est ambigu et dont la graine
  contient un lien relatif (1.5), un binaire de plus de 10 MiB (SWC, esbuild,
  sharp), une base SQLite de plus de 10 MiB ou un hardlink pnpm.
- **Preuve** : rejoué par l'auteur. `afterPhase` sans question : le run
  continue avec l'avertissement. Frontière de question à la phase 0 :
  « Checkpoint workspace exceeds file limits ». Même effet avec le lien de 1.5.
- **Pourquoi ce n'est pas un choix documenté** :
  `docs/run-checkpoints-2026-10-08.md:36-38` : « Unsupported workspace contents
  disable checkpointing without failing an otherwise valid project run ».

### 1.7 ✓ MEDIUM (reproduit, rejoué) — Transport Codex app-server : un lot de plus de 16 appels après épuisement du budget fait échouer l'appel au lieu d'ouvrir le tour final

- **Fichiers** : `src/core/codexAppServerToolLoop.ts:88-89` (huit refus avant
  le tour final, seize au maximum), `:446-455` (un seul compteur `refused` pour
  tout l'appel), `:629`. Commits : `dfc540b4`, `dd3386ca`.
- **Mécanisme** : au-delà du budget, chaque `item/tool/call` est refusé. Au
  huitième refus, le loop envoie `turn/interrupt` et attend `turn/completed`
  pour ouvrir le tour de finalisation sans outil. Les appels d'une même réponse
  arrivent ensemble et sont traités en série avant que l'interruption ne se
  termine ; au dix-septième refus, `budgetFailure` est posé et l'appel entier
  est rejeté. Aggravation : avec `maxToolIterations: 1`, une première réponse
  de 29 appels exécute 12 outils sur l'hôte (`MAX_CALLS_PER_RESPONSE`) puis
  échoue. Après un outil hôte, aucun repli exec n'est permis : le travail payé
  finit en erreur de transport, avec son usage partiel.
- **Preuve** : rejoué par l'auteur sur le `CodexCliLlmClient` de production avec
  un faux app-server. 16 appels : tour final, `toolBudgetExhausted`. 17 appels :
  « Codex requested a tool after its tool budget was exhausted »,
  `turnStarts=1`. Première réponse de 29 appels : 12 outils exécutés, puis le
  même échec. Le test du projet n'émet que 12 appels.
- **Pourquoi ce n'est pas un choix documenté** : `src/core/AGENTS.md:83-84` ne
  connaît que « eight refusals end the turn for a tool-free finalizing turn »,
  et le commentaire `:83-86` promet qu'une réponse qui groupe plusieurs appels
  « does not end the session at once ». Le run 96d5c845, cité par le code,
  émettait 25 appels par réponse.
- **Réserve** : la cadence réelle de l'app-server n'est pas observable sans
  appel modèle. Si Codex sérialisait ses requêtes, l'interruption arrêterait le
  lot vers huit ou neuf refus. Le code et ses tests supposent l'envoi groupé.

### 1.8 ✓ MEDIUM (reproduit, rejoué) — Le plafond de quatre serveurs node n'arrête pas un serveur qui gère SIGTERM, et la sonde annonce pourtant son arrêt

- **Fichiers** : `src/tools/builtin.ts:1685-1698` (l'aîné sort de `live` avant
  toute confirmation et reçoit un seul SIGTERM de groupe, sans escalade ni
  attente) ; `src/tools/sandbox.ts:306-325` (seul `drain()` escalade en SIGKILL
  et confirme) ; `src/tools/builtin.ts:113-114` (« STOPPED by the host »).
  Commit : `b5a76a55`.
- **Scénario** : un serveur qui installe `process.on('SIGTERM', ...)` pour
  fermer proprement, forme que le code lui-même reconnaît comme celle des
  « real long-running servers » (`builtin.ts:3519-3521`), et garde un
  `setInterval` ou un pool actif. Au-delà de quatre, chaque démarrage
  « arrête » un aîné qui continue de répondre. La fuite dure jusqu'à la fin du
  run (`sandbox.ts:137`), exactement la durée que l'incident 96d5c845 a
  saturée.
- **Preuve** : rejoué par l'auteur sur le `startNodeServerTool` de production :
  7 démarrages, plafond 4, 7 serveurs qui répondent, 3 « stoppés par l'hôte »,
  aucun sorti. Témoin qui obéit à SIGTERM : 4 serveurs répondent.
- **Pourquoi ce n'est pas un choix documenté** : `src/tools/AGENTS.md:68-71` :
  « a fifth start STOPS the oldest ». Rien dans « Intentional choices ».

### 1.9 ✓ MEDIUM (reproduit, rejoué) — Terminal de preview : la copie du workspace saute tous les liens, donc `npm test` ne trouve pas les exécutables des dépendances

- **Fichiers** : `src/preview/policy.ts:394-397` (`isSymbolicLink()` donne
  `skipped`) ; `docker/preview.Dockerfile:3` (`node:24-slim`, donc `npm` est
  présent) ; `docs/cli-preview.md:10,33`. Commit : `c3e6e7f2`.
- **Mécanisme** : la règle « a symlink is SKIPPED, never followed »
  (`src/preview/AGENTS.md:181-183`) vise les liens qui tireraient des octets
  hors du workspace. Elle saute aussi `node_modules/.bin/*`, liens relatifs
  internes : `npm test` échoue sur « vitest: not found » (code 127), et `npx`
  irait au registre sans egress.
- **Preuve** : rejoué par l'auteur sur `materializePreviewWorkspace` :
  `{ files: 2, skipped: 1 }`, `.bin` vide, le fichier cible présent.
- **Pourquoi ce n'est pas un choix documenté** : `docs/cli-preview.md` promet
  « run tests » et « Delivered Node dependencies are copied with the
  workspace ». Le symptôme est imputé au livrable. Contournements :
  `node node_modules/<pkg>/…`, `node --test`.

### 1.10 ✓ MEDIUM (reproduit par l'auteur dans un export propre) — Les tests MCP créent un `./atoma.db` partiel dans le répertoire courant puis le lisent : la suite dépend de l'ordre, et dans un checkout de développeur elle ouvre le vrai store en écriture

- **Fichiers** : `tests/mcp-http.test.ts:432-441` lit
  `src/mcp/readers.ts:118-121` (`registryList` ouvre `storeDbPath()`, soit
  `./atoma.db`) ; `src/mcp/run.ts:376-386`, `:279` (`startRun` appelle
  `validateStartInput`, puis `platformLimitsFor()` sans chemin, avant le driver
  de test) ; `src/platform/settings.ts:83-86,207-212` (crée le fichier et sa
  seule table `platform_settings`) ; `vitest.config.ts` et
  `tests/setup-store-isolation.ts` (ne fixent que `ATOMA_LEDGER_DB`). Commits :
  `eb24f1c3` (le test passe de `atoma_families` à `atoma_registry_list`),
  `d1c4d060` (écrivain sans chemin, antérieur à la fenêtre).
- **Mécanisme** : trois fichiers de test (`mcp-modern`, `mcp-server`,
  `mcp-http`) démarrent des runs opérateur ; la validation d'entrée ouvre le
  store par défaut en écriture et y crée `platform_settings`. Le fichier
  survit, ignoré par git. Tout `atoma_registry_list` ultérieur dans le même
  répertoire lit ce store partiel et échoue sur « no such table » ; le texte
  d'erreur devient le contenu de l'outil et `JSON.parse` casse.
- **Conséquences** : (a) en CI, échec de la porte requise « Hermetic checks »
  dès qu'un fork crée le store avant la lecture d'un autre ; (b) dans un
  worktree neuf, le mode « agents parallèles » d'AGENTS.md, le second
  lancement de `mcp-http` échoue de façon déterministe ; (c) dans le checkout
  principal d'un développeur, `./atoma.db` est le vrai store : trois fichiers
  de test y ouvrent un handle d'écriture et y exécutent du DDL, et le test lit
  le registre réel. L'assertion est faible aussi : dans un checkout propre,
  `toHaveProperty('types')` est satisfaite par la branche « no agent store
  yet ».
- **Preuve** : suite complète à la référence, 1 échec sur 6 058 tests, ce test
  précisément, vert quand il est relancé seul. Reproduit par le relecteur dans
  une archive propre (`mcp-modern` puis `mcp-http` donnent la même erreur), et
  par l'auteur dans un autre export propre : premier passage vert, `./atoma.db`
  créé avec la seule table `platform_settings`, second passage rouge.
- **Pourquoi ce n'est pas un choix documenté** : AGENTS.md racine, « Testing
  and linting » (« Registry tests use in-memory SQLite… ») et « Safe working
  rules » (« Live traces and stores are evidence, not scratch data ») ;
  l'en-tête de `tests/setup-store-isolation.ts` affirme « ONE FRESH STORE PER
  TEST for every handle-less writer ».
- **Non établi** : les six échecs CI du 8 octobre ne sont pas attribués à ce
  défaut ; un seul de leurs journaux nomme un test, `viz-gpu-bridge`.

### 1.11 ✓ MEDIUM (établi par lecture du matcher de Claude Code, non exécuté) — Les permissions committées laissent un agent fusionner une PR en mode admin sans invite

- **Fichiers** : `.claude/settings.json:10-16` (allow `Bash(gh pr merge *)`,
  deny `Bash(gh pr merge *--admin*)`) ;
  `tests/claude-settings-security.test.ts:13-25,43-47` (décision du
  2026-10-07 ; le test vérifie seulement la présence des chaînes) ;
  `.github/rulesets/protect-main.json:11-15` (contournement pour le rôle
  admin). Commits : `4105ac26`, `ec8a8480`, `c5f241e3`.
- **Mécanisme** : l'allow de `gh pr merge` est une décision écrite ; le défaut
  porte sur le deny dont cette décision dépend. Dans Claude Code 2.1.123 et
  2.1.289, le motif deny est testé sur le texte brut de chaque sous-commande,
  et l'argv désquoté n'entre en jeu qu'après retrait d'affectations
  d'environnement ou d'un enrobeur. `gh pr merge 12 --adm""in` échappe donc au
  deny et passe l'allow sans invite. `$'--admin'` déclenche une demande, et
  `F=--admin; gh pr merge 12 $F` est refusé : ces variantes ne contournent pas.
- **Scénario** : session sur un compte admin, modèle qui contourne un refus, ou
  injection via une page `github.com` lisible sans invite. Une PR rouge est
  fusionnée en admin sur `main`, puis déployée en production
  (`ATOMA_DEPLOY_ENABLED`).
- **Preuve** : appariement lu par le vérificateur dans les deux binaires
  installés ; non exécuté, car lancer Claude Code coûte un appel modèle.
- **Pourquoi ce n'est pas un choix documenté** : la décision du 2026-10-07
  suppose que le deny bloque `--admin` ; AGENTS.md traite `git push origin main`
  comme une action de production.

## 2. Défauts mineurs (LOW)

Chaque entrée a été confirmée par un vérificateur adverse ; « reclassé » indique
une gravité abaissée par la vérification.

- **2.1 Un replay hérité dont chaque check est `cannot-run` rend un bloc vide
  et ne force aucune revue** (variante de 1.10 du 2 octobre ; reproduit,
  rejoué ; reclassé de MEDIUM). `src/run/inheritedChecks.ts:300-319,340`,
  `src/contracts/inheritedChecks.ts:515-522`, `src/atoms/rootAcceptance.ts:505-509`.
  Le correctif de 1.10 ne lit que `baseline.stopped`. Un replay de départ qui
  va au bout avec `kept=0` (navigateur qui jette, page non liée, au plus deux
  délais dépassés, checks tous trop lents) ne pose pas `stopped` ; le bloc est
  vide et `baselineCannotRun` n'apparaît que dans la trace (`:388`). Un floor
  non couvert ou des critères USER forcent déjà la revue dans une partie des
  cas, et le dossier `docs/inherited-checks-replay-2026-10-01.md:67-69,197-201`
  écrit un traitement « trace seulement ».
- **2.2 `atoma_run_accept`, `atoma_run_answer` et
  `atoma_project_context_update` ne portent pas
  `anthropic/requiresUserInteraction`** (reclassé de MEDIUM).
  `src/mcp/tools.ts:363-370` (`PERSON_DECIDES`, posé par `54a91a9d` sur les
  quatre écritures de catalogue seulement), `:803-810`, `:542`, `:522` ;
  `tests/mcp-modern.test.ts:175-187` n'énumère que ces quatre outils. Seul
  Claude Code honore la clé, qui force la demande malgré les règles allow et
  les modes bypass et auto ; le consentement reste déclaratif côté serveur, par
  conception. Le pire cas, une publication GitHub, était le comportement
  automatique du produit avant le 8 octobre. Correctif d'une ligne et test à
  étendre.
- **2.3 Le refus de publication relaie au locataire le message brut du bail :
  identifiant du run d'une autre organisation, pid hôte, heure de début**
  (reproduit de bout en bout, rejoué ; reclassé de MEDIUM). Bail
  `publication:<id>` sans `orgId` (`src/projects/coordinator.ts:2292`) ;
  `src/projects/service.ts:959-964` ne reconnaît pas `RunLockBusyError` et rend
  un 502 avec `error.message`, par MCP (`tools.ts:345`) et par HTTP
  (`server.ts:4822-4824`). C'est la classe corrigée par `b01df478` pour le
  démarrage (`tenantBusyMessage`, `coordinator.ts:297-304`). L'acceptation est
  gardée et une relance publie ; le commentaire « The publisher already
  recorded the failure » (`service.ts:959-960`) est faux ici. L'exclusivité
  elle-même est une décision (section 3, DP2).
- **2.4 Historique des réponses client : seule la borne en nombre est vérifiée
  avant de poser une question.** `src/run/checkpoint.ts:337-338` (32 réponses),
  `src/contracts/clientQuestion.ts:35-39` (32 réponses ET 24 000 caractères),
  `src/run/clientQuestions.ts:55` (message qui redéfinit le littéral 24000).
  Avec quelques réponses longues dans la lignée, la question suivante est posée
  et aucune réponse ne passe, même un simple choix d'option ; le run ne peut
  plus qu'être annulé. ✓ lu (`36d0b23c`).
- **2.5 Une échéance pendant l'évaluation de la question client fait atterrir
  le run sur « Nothing was accepted » alors que des phases sont acceptées**
  (reproduit ; reclassé de MEDIUM). `src/atoms/dispatch.ts:116` appelle
  `beforePhase` hors du `try` qui atterrit (`:117-131`) ; `src/run/depth.ts:286`
  rend alors `landedBeforeAnyPhase`. Fenêtre étroite : le plancher de 60 s est
  vérifié juste avant (`dispatch.ts:87`). L'échec du run sur une évaluation
  invalide ou tronquée est, lui, le contrat écrit de
  `docs/client-questions.md:15-17`.
- **2.6 Un plan qui déclare une sous-tâche `reasoning` avec des sorties
  fichier désactive le contrôle « au moins un outil appelé »** sans qu'aucune
  porte ne lise `outputs` (`src/atoms/json.ts:925-940`,
  `src/contracts/taskExecution.ts:21` n'est qu'une consigne de prompt). ✓ lu.
- **2.7 `previousRunResults` est rendu deux fois dans chaque prompt délégué L2
  et L1** (reproduit ; reclassé de MEDIUM). `src/atoms/taskContext.ts:37-42`
  retire les doublons de `projectContext` et `clientAnswers`, pas celui ajouté
  par `51c1574e`. Jusqu'à 24 000 caractères payés deux fois par appel ; le
  cache ne les absorbe qu'à partir de la deuxième itération de la boucle
  d'outils. Coût seul, compté au budget.
- **2.8 Une tissue écrite pendant un run projet reste invisible aux runs
  opérateur, benchmark et CLI** (reproduit ; reclassé de MEDIUM).
  `src/run/tissueRouting.ts:62-64` n'offre que les tissues dont tous les outils
  sont disponibles ; une tissue écrite avec `search_project_docs` est cachée
  aux runs sans cet outil hôte, d'où un appel auteur L3 de plus, payé par la
  plateforme, et un quasi-doublon. Meristem retire les outils hôte
  (`tissues.ts:36`), les tissues écrites les gardent (`tissueRouting.ts:123`) :
  deux définitions des outils d'une tissue.
- **2.9 Le scellement d'une frontière tient le verrou d'écriture du store
  partagé pendant deux parcours complets du workspace** (reproduit ; reclassé
  de MEDIUM). `src/run/checkpoint.ts:176-188`,
  `src/run/checkpointWorkspace.ts:90-98`. Mesuré de 1,6 à 3,6 s par frontière
  pour 20 000 à 50 000 fichiers, et 10,8 s aux limites admises, au-delà du
  `busy_timeout` de 5 s des autres écrivains (`SQLITE_BUSY`). Les arbres JS
  courants s'arrêtent tôt sur un binaire de plus de 10 MiB.
- **2.10 Terminal de preview : le plafond de copie (512 MiB) égale le tmpfs
  qui la reçoit**, donc un livrable admis peut échouer en `ENOSPC`, rapporté
  comme `readiness-timeout` et jamais comme `copy-limit`, le seul code sur
  lequel un membre peut agir (`src/preview/policy.ts:244-247`,
  `src/launcher/docker.ts:709`, `src/preview/terminal/server.ts:56-59`,
  `src/preview/AGENTS.md:241`). ✓ lu.
- **2.11 Le résumé de preview annonce `available` pour toute instance en mode
  terminal, même arrêtée**, alors qu'une ouverture sans mode refuse le même run
  (`src/preview/service.ts:74,90-92`, `src/preview/manager.ts:195-199`). ✓ lu.
- **2.12 Le digest de code serveur ignore les imports calculés, mais les textes
  servis aux modèles disent le contraire** (reproduit ; reclassé de MEDIUM).
  L'en-tête de `src/contracts/serverDigest.ts:19-24` promet « FAILS CLOSED »,
  faux pour `` `${__dirname}/…` `` ; `require(path.join(...))` est une
  exclusion écrite (`src/contracts/AGENTS.md:308`). L'accepteur lit pourtant
  « relative imports … unchanged » (`acceptanceChecklist.ts:459-463`) et le
  planificateur qu'éditer un module importé annule la preuve
  (`src/run/depth.ts:168-170`). La couverture « RECORDED EARLIER » reste jugée
  par l'accepteur, pas mécanique.
- **2.13 La garde argv de `record_probe` compare des mots shell non
  expansés** : `"$(echo --serve)"` démarre le serveur sous `record_probe`
  jusqu'au délai (`src/tools/builtin.ts:3500-3514,3662-3668`). Reproduit. Du
  temps facturé, sans évasion.
- **2.14 Toute ligne JSON `{port: N}` est prise pour le signal de prêt de
  n'importe quel serveur** (`src/tools/builtin.ts:1641-1652`), alors que la
  convention réserve ce marqueur aux CLI de tâche (`src/tools/AGENTS.md:138-141`).
  ✓ lu.
- **2.15 Le chemin « léger » de `tasks/get` relit et reparse la trace à presque
  chaque sondage pendant un run.** `src/mcp/tasks.ts:525-529` (« never a trace
  parse ») appelle `src/projects/service.ts:708-722`, qui calcule
  `projectRunProgress` (`src/projects/runProgress.ts:16-24`). La trace est
  réécrite toutes les 300 ms environ (`src/viz/trace.ts:640`) et le sondage
  passe toutes les 2 s. `99148b4c` a réintroduit ce que `57073e06` avait
  retiré. ✓ lu.
- **2.16 La réponse publique de la vitrine n'est pas rédigée**
  (`src/viz/showcase.ts:158-177` rend `result.output` sans `redactHostPaths`,
  sur une surface anonyme qui promet « never a host path ») (reproduit ;
  reclassé de MEDIUM). Les runs projet tournent en conteneur sous `/workspace`,
  donc le modèle ne voit pas de chemin hôte ; défense en profondeur d'une
  ligne.
- **2.17 La vitrine relit et reparse la trace de chaque épisode à chaque GET
  anonyme**, sans limiteur ni cache (`src/viz/showcase.ts:205-211`,
  `src/viz/server.ts:4283-4285`) ; le commentaire « cached on the server (a
  minute) » (`server.ts:1562`) ne vaut que pour la liste. Mesuré 11 à 13 ms par
  appel sur une trace de 20 Mo.
- **2.18 `atoma_conversation_update` n'a ni plafond journalier ni purge**
  (`src/mcp/tools.ts:703-710`, `src/projects/conversations.ts:34` passe
  `spend=false`). Reproduit : 500 mises à jour, aucun refus, 6,1 Mo de
  journal. Abus authentifié et attribuable.
- **2.19 Assistant : un projet hors des 20 du catalogue arrive sans nom ni
  dépôt dans le contexte du modèle, et la carte de confirmation affiche son
  UUID** (`src/viz/assistant.ts:116-117`, `AssistantPanel.tsx:149`). ✓ lu.
- **2.20 Un appel de titre payé qui ne produit pas de titre n'est enregistré
  nulle part et le backfill le repaie à chaque `--apply`**
  (`src/projects/runTitle.ts:101-105`, `src/projects/store.ts:1745-1753`),
  contre `src/core/AGENTS.md:116` (usage partiel). ✓ lu.
- **2.21 `models refresh` ne propose jamais un `cacheWrite` que seule la source
  déclare** (reste de 1.7 du 2 octobre ; reproduit, rejoué).
  `src/cli/modelCatalogUpdate.ts:206-208` ne compare que si les deux côtés le
  déclarent, alors qu'un point sans `cacheWrite` signifie 1,25 fois l'input.
- **2.22 Le `score` des réponses Jev n'est pas borné et décide seul du
  jumeau** (reste de 2.7 du 2 octobre). `src/core/jev.ts:158`,
  `src/core/jevQuestions.ts:897-917`. Un score hors échelle fait perdre une
  leçon, sans rien approuver. ✓ lu.
- **2.23 La carte d'un partial supplanté promet un nouveau départ là où le
  serveur répond 409** (reste de 2.1 du 2 octobre). `en.json:961` contre
  `src/projects/coordinator.ts:895-910`. ✓ lu.
- **2.24 Le mémo anti-redispatch des scripts compare le seul `summary`**
  (`src/atoms/L2Atom.ts:958-980`) alors que son commentaire dit « keys on the
  OUTPUT » : une autre sortie au même résumé est mise de côté sans validation,
  et depuis `0fbb6c21` la molécule reprend alors la phase sans recette. ✓ lu.
- **2.25 Le fichier scratch `_skill_<id>` n'a ni namespace ni voie**
  (`src/skills/abi.ts:21-23`). Des sous-tâches parallèles partagent le
  workspace ; le nettoyage de l'une peut faire échouer l'autre en `ENOENT`, et
  deux échecs consécutifs rétrogradent le script
  (`DIRECT_DISPATCH_DEMOTE_AFTER = 2`, `src/atoms/cost.ts:116`). ✓ lu.
- **2.26 Import GitHub : les répertoires exclus sont téléchargés et comptés
  dans la borne de 1 GiB de l'archive**, sans repli vers les blobs
  (`src/github/repositoryArchive.ts:72-82`, `src/github/client.ts:1066-1072`,
  `5ffd9b33`), contre `src/github/AGENTS.md:25-29`. Reproduit : 64 MiB exclus
  passent, 1 GiB + 1 MiB exclus font échouer l'import.
- **2.27 La visionneuse de fichiers reste ouverte sur le fichier d'un autre
  projet après Back/Forward ou un clic de notification**
  (`src/viz/client-gl/navigation-history.ts:176-188` ne la ferme pas, ni
  `viewChange`, `selectProject` ou `selectRun`). Pas de fuite inter-org : le
  changement d'organisation recharge la page. ✓ lu.
- **2.28 Le bouton destructif de retrait de clé affiche la clé brute
  `settings.keyRemove` dans toutes les langues**
  (`src/viz/client-gl/OrgModelsForm.tsx:644-655`) ; antérieur à la fenêtre, et
  aucun test ne compare les `t()` du client aux catalogues. ✓ lu.
- **2.29 La visionneuse passe `count` en chaîne à i18next, qui ignore alors le
  pluriel** (« 1 lines », `src/viz/client-gl/file-preview-i18n.ts:13-15`) ; le
  détecteur de pseudo-pluriels (`scripts/i18n-predicates.mjs:58`) est figé sur
  `(s)`, `(es)`, `(ies)`. ✓ lu.
- **2.30 Le clone du mender garde `origin` sur `mgtf/atoma`** : après
  réinstallation de l'activateur, `refresh_mender` arrête le service puis
  échoue, et le remède qu'il indique échoue de même
  (`deploy/host-deploy.sh:46,428-453`, `deploy/install-mender.sh:51-55`,
  `6c450864`). Dépend de l'état réel du clone hôte, non vérifiable ici. ✓ lu.
- **2.31 La sentinelle n'apparie jamais le bail d'un run opérateur**
  (`src/sentinel/watch.ts:252` compare des identifiants qui diffèrent toujours,
  `src/mcp/run.ts:391,395`) : contexte seulement, `src/sentinel/AGENTS.md:81-82`.
  ✓ lu.

## 3. Documentation, contrats écrits et décisions en attente

### Décisions propriétaire nouvelles

- **DP1 — Vitrine : consentement d'une organisation cliente.**
  `listShowcaseRuns` (`src/projects/store.ts:1777-1793`) publie tout run livré
  demandé par un admin plateforme, dans n'importe quelle organisation, avec le
  défaut `listed`. La première exposition n'émet aucun événement à
  l'organisation (`project.showcase_changed` seulement sur bascule explicite,
  `src/projects/service.ts:444-452`), et accorder le drapeau admin publie
  rétroactivement. C'est la règle écrite (`src/viz/AGENTS.md:682-689`,
  `src/projects/AGENTS.md:147-155`), avec un opt-out par l'admin
  d'organisation et un badge « Eligible ». Reste à décider si le projet d'une
  organisation cliente doit être en opt-in.
- **DP2 — Exclusivité de la publication.** Depuis `73e251f1`, chaque
  acceptation publie sous le bail exclusif de plateforme (`src/mcp/runLock.ts:65`,
  `docs/project-maintenance.md:90-91`). Cette règle a été écrite quelques heures
  avant que l'acceptation emprunte ce chemin. Conséquence : la publication
  d'une livraison acceptée échoue en 502 tant qu'un run d'une organisation
  quelconque est en vol ; l'acceptation est gardée et une relance manuelle
  existe. Deux textes sont faux depuis : `docs/project-maintenance.md:77-78`
  et `src/projects/AGENTS.md:480-481`. Message brut : 2.3.
- **DP3 — `gh pr merge` sans invite.** La décision du 2026-10-07 repose sur un
  deny que 1.11 montre contournable. À confirmer en connaissance de cause, ou
  à remplacer par une règle qui ne dépend pas du texte brut.

Restent ouvertes depuis le 2 octobre : 2.4 (monotonie des déploiements), D1
(visibilité des payeurs), D2 (persistance des listes rédigées), D9 (consentement
CLA du mender). D3 et D12 restent des limites assumées.

### Constats documentaires (DOC)

- **D1** — La frontière d'exécution de la visionneuse est mal écrite :
  `src/viz/AGENTS.md:368-371` (« an iframe whose CSP forbids ALL scripts ») et
  `src/viz/client-gl/FilePreview.tsx:11-15`. Mermaid et Markdown sont analysés
  dans le document de l'application, protégés par Mermaid en `securityLevel:
  'strict'` puis DOMPurify ; la CSP du shell ne pose pas de `script-src`. Pas
  d'exploitation trouvée : c'est la frontière écrite qui est fausse.
- **D2** — L'isolation des stores de test affirmée par AGENTS.md racine et par
  l'en-tête de `tests/setup-store-isolation.ts` est démentie par 1.10.
- **D3** — Le scope mono-critère : `src/run/AGENTS.md:223-236` et le docstring
  de `src/run/depth.ts:74-80` énumèrent toujours quatre raisons, alors que le
  code (`depth.ts:84`) compte aussi les régressions héritées. C'est exactement
  la façon dont 1.11 du 2 octobre est née.
- **D4** — `src/mcp/server.ts:56` et `src/mcp/tools.ts:807` demandent
  `artifactManifestHash` là où l'entrée s'appelle `manifestHash` ;
  `src/mcp/prompts.ts:109` dit qu'un run projet « can publish » sans mentionner
  l'acceptation requise.
- **D5** — `src/auth/AGENTS.md:137-139` fait de `claudeProfileForRun` le seul
  lecteur du jeton Claude personnel, pour l'environnement de l'enfant
  seulement ; l'assistant le pose aussi dans l'environnement de son transport
  (`src/viz/assistantModels.ts:112-115`, documenté côté assistant).
- **D6** — La dépense de l'assistant (`assistant_calls`) n'a aucun lecteur hors
  de son store ni plafond hôte agrégé (2 $ par jour et par principal et
  organisation) : lacune d'observabilité à écrire.
- **D7** — `docs/github-app-setup.md:306-307` et `:326-327` donnent 10 000
  entrées et 50 MiB, contre `:313-314` et le code (100 000 fichiers, 400 000
  entrées, 512 MiB, `src/contracts/workspaceLimits.ts:5-8`), et omettent que
  les exclus comptent dans le téléchargement (2.26).
- **D8** — Le budget de l'app-server Codex suppose une notification
  `thread/tokenUsage/updated` par réponse modèle (`src/core/AGENTS.md:79-80`) ;
  aucune session enregistrée ni smoke n'en atteste la cadence.
- **D9** — `withPartialUsage` copie l'erreur (`src/core/metrics.ts:253-264`) :
  les deux gardes par identité (`src/run/runner.ts:1566`, `src/run/depth.ts:46`)
  ne tiennent plus que par le `name`. Aucune raison actuelle ne les atteint par
  la seule identité ; fragilité latente.
- **D10** — Le commentaire de `src/tools/builtin.ts:1580-1585` promet plus que
  l'heuristique : `NODE_OPTIONS=--require=./hook.js` passe pour un fichier
  (« the environment » est une exclusion écrite, `src/contracts/AGENTS.md:308`).
- **D11** — Les serveurs `python3 -m http.server` (`src/tools/builtin.ts:1150-1181`)
  n'ont ni plafond ni registre, contrairement aux serveurs node : conforme au
  texte, mais la pente mémoire de 96d5c845 reste ouverte pour cette moitié.
- **D12** — `src/preview/manager.ts:203-206` : un snapshot en vol `ready` refuse
  le mode terminal (409) mais est remplacé pour le mode app.
- **D13** — `.github/workflows/ci.yml:249-257` justifie encore le PAT admin par
  un dépôt « user-owned », alors que le dépôt appartient à l'organisation
  `atoma-run`.
- **D14** — `HEAD /` sans session reçoit les en-têtes du shell au lieu de ceux
  de la vitrine (`src/viz/server.ts:4198-4258`), sans conséquence de cache.
- **D15** — `src/atoms/fileEvidence.ts:104-105` interdit de juger un critère
  non satisfait sur une partie non montrée sans offrir d'état « unverified »
  dans un champ binaire ; le prompt système le dit déjà (`verdict.ts:612`,
  `prompts.ts:685-690`). Ambiguïté de formulation.

Non vérifiable : la limite `PREVIEW_APP_PIDS = '64'`
(`src/launcher/docker.ts:71`) s'applique aussi au terminal ; un dépassement
sous `npm test` n'a pas été mesuré, et `--cpus 0.5` ainsi que `runsc` jouent
contre.

Faiblesse antérieure à la fenêtre, à suivre : la table OAuth des autorisations
en attente (1 024 entrées partagées, 5 min, 60 requêtes par minute et par
adresse) peut être tenue pleine par environ quatre adresses aux arrivées
calées, ce qui bloque toute nouvelle connexion MCP ; avec 50 ms de gigue, la
plupart des demandes légitimes passent. Le vecteur existait à `cc631bb6` par un
client DCR ; le limiteur n'agrège pas les préfixes IPv6
(`src/auth/mcpOAuth.ts:13,81,195,212-217`, `src/auth/rate-limit.ts:42-66`).

## 4. Incohérences et limites de conception

### A. Un lien symbolique de workspace a trois définitions

Le semis rend absolus les liens relatifs (1.5) ; le checkpoint hache les liens
relatifs internes et refuse ceux qui sortent (`checkpointWorkspace.ts:61-65`),
comme sa doc le promet ; la preview saute tous les liens (1.9). Le même
`node_modules/.bin/vite` est donc un lien vers le workspace précédent après le
semis, un refus pour le checkpoint et une absence dans le terminal. Il faut une
règle unique : un lien relatif qui reste sous la racine est copié tel quel par
toutes les copies (semis, restauration de checkpoint, preview), un lien qui
sort est refusé partout. Un test devrait faire traverser les trois copies à un
même workspace avec dépendances installées.

### B. Une frontière de continuation est un engagement : refuser avant de consommer, sceller un état qui ne dépend plus des processus du run

1.1, 1.4, 1.6 et 2.5 partagent la même forme : la frontière consomme ou scelle
d'abord, vérifie ensuite. L'ordre à adopter : (1) contrôles d'identité et de
politique avant `continueProject`, version de l'acteur racine comprise ; (2)
arrêt des processus du run AVANT le scellement, ou exclusion de leurs écritures
d'arrêt de la comparaison ; (3) `beforePhase` dans le `try` qui atterrit, avec
la même dégradation que `afterPhase`. La promesse « without failing an
otherwise valid project run » devrait devenir un test : une phase dont le
serveur écrit sur SIGTERM, une graine avec un lien relatif et un fichier de
plus de 10 MiB, un changement de version de la tissue racine entre pause et
reprise.

### C. Un plafond écrit doit être appliqué par le mécanisme qui le nomme

Le plafond de quatre serveurs node repose sur un SIGTERM non confirmé (1.8) ;
« eight refusals end the turn » est doublé d'un plafond dur de seize atteint
avant que l'interruption n'aboutisse (1.7) ; un plafond de copie égal au tmpfs
qui la reçoit se remplit avant d'être atteint (2.10) ; deux bornes d'historique
dont une seule est vérifiée avant de poser la question (2.4). C'est la classe
D du 2 octobre (« une définition unique de la validité ») : chaque borne
demande son point d'application et un test à la borne plus un.

### D. Une règle posée dans la fenêtre doit être énumérée par un test, sinon le chemin suivant l'ignore

`PERSON_DECIDES`, posé le 4 octobre, n'est pas appliqué à l'acceptation le 8
(2.2) ; les messages de bail rédigés pour le démarrage par `b01df478` sortent
bruts sur la publication (2.3) ; la vitrine promet de ne jamais publier de
chemin hôte et ne rédige pas la réponse (2.16) ; l'isolation des stores de test
est écrite dans AGENTS.md et contredite par un test modifié dans la fenêtre
(1.10) ; la visibilité d'un replay de départ vide est corrigée pour `stopped`
seulement (2.1). Chaque fois, le test qui épingle la règle énumère les cas
connus le jour où il a été écrit. Mieux vaut un test qui dérive sa liste du
catalogue ou du type d'erreur : chaque outil dont la description parle de
consentement client, chaque `RunLockBusyError` qui atteint une surface
locataire.

### E. L'acceptation est liée aux octets, pas à la lignée

Le contrat d'acceptation tient pour les octets exacts : manifeste écrit une
fois, hash vérifié à l'acceptation et à la publication, octets relus. Mais deux
livraisons acceptées et publiées dans l'ordre chronologique perdent les
éditions de la seconde (1.3), et le consentement reste déclaratif côté serveur
(2.2). La porte de lignée devrait refuser de publier un run qui n'est plus la
graine courante quand une livraison plus récente a déjà synchronisé, comme le
dossier de conception l'écrivait.

## 5. Ce qui tient bien dans cette fenêtre

- **Les fermetures du 2 octobre** : aucune rouverte, et les deux barrières de
  1.5 (un critère USER sans jugement refuse ; la revue ciblée transforme tout
  jugement manquant, dupliqué, inconnu ou sans raison en `met:false`) sont
  indépendantes et testées.
- **La classe du HIGH 1.1 du 2 octobre** : les 14 outils à `outputSchema` ont
  une racine ouverte, et chaque producteur est construit champ par champ ou
  passe par `schema.parse`. `tests/mcp-experience.test.ts` (27 sur 27) le
  prouve avec le serveur HTTP réel et les vrais clients validants des deux ères.
- **L'acceptation liée aux octets exacts** : manifeste écrit une fois, hash
  vérifié sous `BEGIN IMMEDIATE` puis à la publication, octets relus en
  `O_NOFOLLOW` ; jamais de force push, une édition client concurrente n'est
  jamais écrasée.
- **Les réponses client** : liées à la question, au run, à l'organisation et au
  demandeur d'origine, immuables par trigger, rejeu idempotent ; une reprise
  sans réponse est refusée partout ; le replan garde le préfixe accompli ; rien
  n'est repayé ni double-compté à la reprise.
- **La vérification reste en lecture seule** et `superviseLoop` reste l'unique
  protocole : le seul rejeu est celui des checks hérités, exception documentée.
- **Le coût sur le nouveau transport Codex** : modèle servi et formule unique,
  usage partiel sur erreur, repli exec additionné, récupération de capacité
  dans le même thread sans double paiement, un processus et un thread éphémères
  par appel.
- **L'abonnement Claude personnel** : fichier 0600 en `O_EXCL|O_NOFOLLOW`,
  jamais en store ni en journal ; posé dans l'environnement allowlisté de
  l'enfant seulement, absent des outils L1 et de l'auteur de tissues ; mélange
  hôte et personnel refusé ; révocation qui supprime le reçu d'abord.
- **L'assistant intégré** : session re-résolue et atténuée à `org:member` à
  chaque requête MCP ; aucune écriture issue d'un texte modèle sans confirmation
  dans le navigateur, proposition sauvegardée et clé d'idempotence ;
  conversations lues par principal et organisation. La correction de
  `c07e3548` (contexte modèle isolé par projet) est complète.
- **Le terminal de preview** : grant lié au principal, à la session, à
  l'organisation et au run, Origin exact et en-tête dédié ; conteneur en
  lecture seule, `cap-drop ALL`, réseau interne sans egress, image épinglée par
  digest, aucun code du control plane dans l'image.
- **GitHub** : aucun processus git ou gh, segments validés puis encodés, jetons
  seulement dans l'en-tête `Authorization` ; l'archive n'utilise jamais un nom
  d'entrée comme chemin, vérifie SHA-1 git et taille, et borne la
  décompression.
- **Le serveur viz** : lecture de fichiers confinée au manifeste avec relecture
  des octets ; `format=bytes` en pièce jointe sous CSP `sandbox` ; vitrine
  fermée par défaut, CSP épinglée par hash ; le service worker n'encaisse ni
  `/api` ni les réponses `no-store`.
- **Les skills** : aucune approbation par défaut dans la validation d'un script
  compilé, trust plateforme sans clé d'organisation, suppression de la run
  family sans orphelin ; `ef457023` restaure intégralement `77c26924`.
- **Le client GPU** : historique cloisonné par principal et organisation,
  destinations de notification limitées à l'organisation active, résultat lié
  au run affiché, aucun `innerHTML`, aucun test qui mesure un temps de frame.
- **Le déploiement** : preflight cohérent avec la file d'attente, marqueur de
  gel conforme à `processFingerprint`, plugin Claude Code sans secret ni
  logique, pointé sur `https://atoma.run/mcp` en OAuth.

## 6. Fermetures des findings du 2 octobre

| # du 02/10 | Verdict | Justification |
|---|---|---|
| 1.1 | **fermé (classe)** | Racines ouvertes partout, producteurs passés par leur schéma ; 74 objets imbriqués fermés, aucun débordé. Les outils `atoma_conversation*` manquent au test SDK du catalogue. |
| 1.2 | **fermé (classe)** | Reprise comptée sous `atoma-resumed-session` (`src/mcp/http.ts:616,626`) ; règle de fin d'ère corrigée. Repro rejouée. |
| 1.3 | **fermé (classe)** | Tout rejet pendant `signal.aborted` donne `preempted` (`src/supervisor/analyst.ts:373-381`). |
| 1.4 | **fermé (classe)** | Les quatre chemins de `endRun` attendent les audits Jev ; la pause est couverte en amont. |
| 1.5 | **fermé (classe)** | Deux barrières indépendantes (`rootAcceptance.ts:320-321`, `criteriaReview.ts`). Repro : six formes d'ids discordants refusées. |
| 1.6 | **fermé (classe, lancements de run)** | Liste blanche dans `tierSelectors` (`src/contracts/runPayers.ts:69-80`) ; le sélecteur du superviseur n'y passe pas, sans dépense partielle. |
| 1.7 | **fermé (scénario)** | `cacheWrite: 0` préservé ; reste 2.21. |
| 1.8 | **fermé (scénario)** | Trois copies concordantes de la règle (store, HTTP, formulaire), pas une définition unique. |
| 1.9 | **fermé (classe)** | « Removed » seulement sur `ENOENT` prouvé (`src/run/workspace.ts:254-266`). |
| 1.10 | **fermé (scénario)** | `baseline.stopped` force la revue ; la variante `kept=0` sans interruption reste ouverte (2.1). |
| 1.11 | **fermé (classe, code)** | `depth.ts:84` compte les régressions héritées ; le contrat écrit reste en retard (D3). |
| 1.12 | **fermé (classe)** | Les recettes de récupération sont exclues de la recherche de jumeaux. |
| 2.1 | **fermé (scénario)** | La reprise n'est plus masquée ; le texte « starts afresh » reste faux dans un cas (2.23). |
| 2.2, 2.3 | **fermés (classe)** | Marqueur avec identité de naissance, garde suivie pendant l'attente et le maintien. Fragment shell non exécuté (darwin). |
| 2.4 | **décision propriétaire ouverte** | Aucun contrôle de monotonie ajouté. |
| 2.5 | **fermé (classe)** | Une copie par appel ; les gardes d'identité tiennent par le nom (D9). |
| 2.6, 2.8, 2.9, 2.10, 2.13, 2.14, 2.15 | **fermés (classe)** | Vérifiés un à un ; repros de 2.9, 2.13 et 2.15 rejouées. |
| 2.7 | **fermé (scénario)** | Probabilités, confiance et noul bornés ; le `score` reste libre (2.22). |
| 2.11 | **fermé (budget de fetch)** | Le fetch CIMD attend l'authentification. La table des autorisations en attente était déjà épuisable avant la fenêtre (section 3). |
| 2.12 | **fermé (scénario)** | Graphies JSON, URI et Windows rédigées ; casse de lecteur non testée. |
| D1, D2, D9 | **décisions propriétaire ouvertes** | Inchangées. |
| D3, D12 | **limites assumées** | Inchangées. |
| D4–D8, D10, D11 | **fermés** | Spot-checks tenus. |

Aucun commit postérieur de la fenêtre ne rouvre un finding du 2 octobre.

## 7. Vérification exécutée

Environnement : macOS (Darwin 25.5), Node 24.20.0, Docker actif, worktree
propre de `c07e3548`. Aucun appel modèle payant, aucun store utilisateur
modifié, serveurs sur ports éphémères loopback.

- **`npm run docs:check` : VERT** (57 outils MCP, 18 sous-systèmes, 500 lignes
  racine). **Typecheck, les deux tsconfig : VERT. `eslint .` : VERT.
  `npm audit --omit=dev` : 0 vulnérabilité.**
- **`vitest run --maxWorkers=2`** : 434 fichiers passés, 2 ignorés, 1 échec ;
  6 044 tests passés, 13 ignorés, 1 échec. L'échec est celui de 1.10, aggravé
  ici par un `atoma.db` que des scripts de reproduction avaient laissé dans le
  worktree ; il est reproduit sans eux dans un export propre.
- **CI GitHub, 60 derniers runs de `main`** : 17 succès et 6 échecs de « CI » le
  8 octobre, tous dans « Test suite (Node 24) » et donc la porte « Hermetic
  checks ». Un seul journal nomme un test (`viz-gpu-bridge`) ; les autres ne
  sont pas attribués. Les runs suivants sont verts et déployés.
- **Reproductions rejouées par l'auteur** : onze scripts (1.1 à 1.9 et 2.1),
  plus trois variantes (seuil Codex à 16 et 17 appels, première réponse de 29
  appels, remédiation atoms sans `delivery`). Tous reproduisent. 1.10 est
  reproduit dans un export propre. Scripts et sorties dans l'annexe.
- **Non exécutés** : smoke navigateur, isolation Docker et gVisor des previews,
  appels modèle réels (cadence de l'app-server Codex, effet réel de
  `requiresUserInteraction`), fragment shell du déploiement, Claude Code pour
  1.11.

La suite verte ne contredit aucun finding : les tests de la fenêtre passent par
le code de production, mais aucun n'exerce les compositions en cause. Le test
des checkpoints n'a qu'un projet et des phases sans serveur ; celui de la revue
des critères ne livre que des fichiers ; celui de la synchronisation remplace
le bail par un stub.

## 8. Priorités et statut

**P1** : 1.1, le seul HIGH, en production ; puis 1.5 et 1.6, qui se corrigent
ensemble (copie de semis avec liens tels quels, frontière de question qui
dégrade comme `afterPhase`) ; 1.4 (contrôle de l'acteur avant consommation) ;
1.2 (garde `=== 'files'` ou `delivery` déduit) ; 1.3 (porte de lignée).

**P2** : 1.7, 1.8, 1.9, 1.10, 1.11.

**P3** : les LOW de la section 2, en commençant par les corrections d'une ligne
qui ferment une classe connue (2.2, 2.3, 2.16), puis 2.1 et 2.4 ; les constats
D1 à D15.

**Décisions propriétaire** : DP1 (vitrine), DP2 (exclusivité de la
publication), DP3 (`gh pr merge` sans invite), et celles qui restent du 2
octobre (2.4, D1, D2, D9).

Statut : findings ouverts, aucun correctif appliqué. Cette revue ajoute ce
rapport, son [annexe de preuves](../../incidents/code-review-2026-10-09-evidence.md)
et son entrée dans l'[index des revues](../../code-reviews.md).

## 9. Suites — 2026-10-09

Cette section suit les décisions et corrections postérieures à la revue ; elle
ne change ni sa fenêtre ni ses constats à `c07e3548`.

- **DP1 tranchée par le propriétaire** : « Apparaisse ici UNIQUEMENT les runs
  de l'admin plateforme (moi) ». Règle retenue : un run apparaît s'il est
  livré, s'il n'est pas un rerun de comparaison, si son projet n'est pas
  `hidden`, et s'il a été demandé par un admin plateforme qui a FONDÉ
  l'organisation du run et en est toujours propriétaire. Le fondateur est le
  premier membre, dont l'adhésion n'est pas antérieure à la création de
  l'organisation ; une égalité ne fonde rien. Être propriétaire ne suffit pas :
  un admin invité comme propriétaire dans l'organisation d'un client n'y publie
  rien. Les projets d'une organisation sans tel fondateur ne portent plus aucun
  badge de vitrine, et `atoma_project_showcase` y répond 409.
- **Implémentation** : commit `52032614`. Deux rondes de relecture adverse
  ont relevé 12 points, tous appliqués ; 14 tests nouveaux échouent sans le
  changement.
- **Contrôle en production, lecture seule** (`atoma_organisations`) : l'admin
  plateforme est le seul membre et le propriétaire de son organisation, avec
  une adhésion datée de la milliseconde de sa création, et il n'est membre
  d'aucune organisation cliente. La règle ne retire donc aucun run de la vitrine
  actuelle, et aucun run d'une organisation cliente n'a pu y figurer. Les
  organisations clientes cessent de voir le badge « Eligible ».

### Corrections

Un commit par point, sur `acd25df0`, sans relecture adverse séparée à la
demande du propriétaire. Chaque test de non-régression échoue sans sa
correction.

| Points | Commit | Correction |
|---|---|---|
| 1.1 | `294fe4e6` | Les processus du run sont drainés avant le scellement d'une frontière de pause. |
| 1.5 | `71fe2dbe` | Le semis copie les liens relatifs tels quels. |
| 1.6, 2.5 | `939b8983` | La frontière de question dégrade comme `afterPhase` et atterrit sur une échéance. |
| 1.4 | `a6952987` | Un refus d'acteur racine rend la source dans son état et clôt le successeur. |
| 1.2 | `96925739` | Une livraison non déclarée est déduite de ce que la passe a fait. |
| 1.3 | `c46489de` | Les commits publiés par Atoma depuis le départ d'un run avancent sa base de sync. |
| 1.7 | `8e5a114c` | Les refus drainés après l'interruption ont leur propre borne. |
| 1.8 | `fe3b4a1c` | Le plafond de serveurs escalade en SIGKILL et confirme la sortie. |
| 1.9 | `79c76be5` | La preview recopie les liens relatifs internes. |
| 1.10 | `d618dabe` | Chaque test a son store produit temporaire. |
| 2.2 | `b5d909ee` | Acceptation, réponse et confirmation de contexte exigent une personne. |
| 2.3 | `d4169186` | Le refus de publication est rédigé comme celui du démarrage. |
| 2.15 | `abd65a29` | `tasks/get` ne reparse la trace qu'une fois par fenêtre de 30 s. |
| 2.20 | `74e7db87` | Un titre payé laisse un reçu et n'est plus repayé. |
| 2.23 | `89128304` | Texte de reprise d'un partial aligné sur le serveur. |
| 2.1 | `ee9a5dcf` | Un replay hérité qui n'établit rien le dit et force la revue. |
| 2.4 | `a23030fb` | La taille de l'historique des réponses est vérifiée avant la question. |
| 2.6 | `8cf0f2c8` | Une sous-tâche qui déclare des fichiers n'est plus en mode raisonnement. |
| 2.7 | `4f3b1d16` | L'historique des runs précédents n'est plus envoyé deux fois. |
| 2.8 | `b1fd5811` | Une tissue écrite est enregistrée sans outils hôte. |
| 2.9 | `4d9322fc` | Partiel : le verrou couvre un parcours au lieu de deux. |
| 2.10 | `cf83040d`, `fd56cb2d` | Plafond de copie propre au terminal ; constantes dans le contrat du launcher. |
| 2.11 | `58fad441` | Un terminal arrêté n'est plus annoncé disponible. |
| 2.12 | `54d8ec78` | Le digest échoue fermé sur un chemin calculé ; textes modèles alignés. |
| 2.13 | `bc73d6f5` | Une substitution shell ne démarre plus de serveur sous `record_probe`. |
| 2.14 | `1a58eb31` | `{"port":N}` ne vaut signal de prêt qu'avec des `args`. |
| 2.21 | `2e4a9776` | Un changement du seul `cacheWrite` est proposé. |
| 2.22 | `9b232f1b` | Un score Jev hors échelle vaut absence de réponse. |
| 2.16 | `980dfd65` | La réponse publique de la vitrine est rédigée. |
| 2.17 | `cc164b33` | Les réponses de la vitrine sont en cache avec la liste. |
| 2.18 | `5841ef09` | Plafond quotidien des écritures de conversation par MCP. |
| 2.19 | `662445ff` | L'assistant retrouve le nom d'un projet hors de la première page. |
| 2.24 | `581c957a` | Le mémo anti-redispatch compare la sortie. |
| 2.25 | `3694b0ae` | Fichier scratch unique par dispatch. |
| 2.26 | `1f6cde34` | Repli vers les blobs quand l'archive dépasse ses bornes ; doc GitHub à jour. |
| 2.28 | `0042c386` | Clé `settings.keyRemove` ajoutée ; test des clés du client. |
| 2.29 | `d88acf44` | Messages de la visionneuse sans pluriel impossible. |
| 2.30 | `06893dfd` | Le clone du mender réaligne un ancien `origin`. |

Non corrigés : 1.11 attend DP3 ; 2.27 était déjà corrigé par `6e898713` ;
2.31 demanderait de changer le format de trace, décision propriétaire ; la
purge du journal de conversation (2.18) contredirait la doc, décision
propriétaire. DP2 reste ouverte. Les constats D1 à D15 ne sont pas traités.
Vérification sur la branche : les deux typechecks, `eslint .`, `docs:check`
et la suite complète (6 165 réussis, aucun échec) sont verts.
