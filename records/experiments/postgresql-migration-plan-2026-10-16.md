# Migration SQLite → PostgreSQL : faisabilité et plan d'action — 2026-10-16

> **STATUT : analyse pour décision du propriétaire, pas un contrat
> d'implémentation accepté. Révision examinée : `6e64837e`. Production
> mesurée le 2026-10-16 sur `atoma.run`.**
>
> Cette note reprend l'[analyse du 2 septembre](postgresql-migration-analysis-2026-09-02.md)
> six semaines plus tard, après la [décision du gate 0](../../docs/saas-architecture.md#decision-gate-0--hardened-sqlite-or-postgresql)
> (2026-09-18 : SQLite durci, pas de migration) et la décision
> [« a run is a run »](../../docs/decisions/platform-trust-2026-09-15.md)
> (2026-09-15 : un registre, une confiance, pas de partition par organisation).
> Elle mesure ce que la migration coûterait **aujourd'hui**, dit si les
> conditions de réouverture du gate 0 sont remplies, et donne le plan à
> exécuter si le propriétaire décide d'y aller quand même.

## 1. Verdict

**Faisable, mais ce n'est pas un changement de pilote : c'est la réécriture
de la couche de persistance.** Tous les stores sont synchrones
(`better-sqlite3`) ; PostgreSQL impose un pilote asynchrone. La migration
colore donc en `async` 11 627 lignes de stores, 525 sites de requêtes
préparées dans 43 fichiers source, 93 transactions (86 en `.immediate()`),
22 triggers `RAISE`, et leurs appelants : le gate d'authentification, toutes
les routes HTTP, la boucle de supervision, les CLI, et 272 ouvertures de
store en mémoire dans 470 fichiers de test.

**Les conditions de réouverture du gate 0 ne sont pas remplies.** Le gate
rouvre PostgreSQL sur deux preuves : un second hôte partageant le store, ou
un `SQLITE_BUSY` mesuré après le `busy_timeout` avec tous les écrivains en
`.immediate()`. Mesuré en production ce jour : un hôte, zéro `SQLITE_BUSY`
dans le journal systemd depuis le 2026-09-18, un store de 143 Mo et
25 621 lignes. Le seul dépassement documenté depuis (scellement d'une
frontière de checkpoint tenant le verrou 10,8 s, revue du 2026-10-09 §2.9)
a été corrigé à la source par `4d9322fc`.

**Recommandation : ne pas migrer maintenant.** Instrumenter le critère de
réouverture pour qu'il soit observé et non deviné (§7, piste A), garder ce
document comme plan exécutable, et ne lancer la phase 1 (la plus coûteuse,
§7 piste B) que sur une décision ferme : son travail ne vaut rien si la
migration ne va pas au bout.

Ordre de grandeur si la décision est prise : **25 à 40 jours de travail
concentré**, avec un gel des modifications concurrentes sur les stores
pendant toute la durée, et un découpage en PR comportementalement neutres
parce que chaque push sur `main` déploie en production.

## 2. Ce qui a changé depuis le 2 septembre

| Mesure | 2026-09-02 (`bcfc6d6`) | 2026-10-16 (`6e64837e`) |
|---|---:|---:|
| Fichiers source important `better-sqlite3` | 18 | 43 (+1 `node:sqlite`) |
| Tables du store produit | ≈30 | 73 déclarées, 69 présentes en production |
| Fichiers de test important `better-sqlite3` | 24 | 67 |
| Ouvertures `openDb(':memory:')` dans les tests | non compté | 257 (+15 `new Database(':memory:')`) |
| Sites `.prepare(` | non compté | 525 |
| Transactions / `.immediate()` | non compté | 93 / 86 |
| Triggers `RAISE(ABORT)` | mentionnés | 22 |

La surface a plus que doublé. Les stores arrivés depuis : checkpoints de run
(`run_checkpoint_*`, la plus grosse table en production), conversations de
projet, hébergement des applications, OAuth du MCP, file d'apprentissage,
lancements de retrieval, cache d'embeddings, versions de contexte, réglages
plateforme, questions au client, réception d'apprentissage.

Deux décisions ont réduit le périmètre en même temps :

- **« A run is a run » (2026-09-15)** retire la section 8 de l'analyse de
  septembre : plus de séparation corps/confiance, plus de confiance par
  organisation, plus de RLS sur la confiance. Le modèle de données migre tel
  quel ; la RLS reste une option de défense en profondeur sur les tables
  déjà scopées par organisation, pas une condition.
- **Gate 0 (2026-09-18)** a durci SQLite : verrou d'écriture pris avant la
  lecture partout (W4a, mesuré sur quatre processus concurrents), un seul
  `busy_timeout` (`STORE_BUSY_TIMEOUT_MS`), compteurs en une instruction
  dans la transaction qui écrit leur événement de cycle de vie. Le résultat
  est que **chaque invariant transactionnel est aujourd'hui explicite** dans
  le code, ce qui est exactement l'inventaire que la §7 de septembre
  demandait de constituer avant de choisir CAS, verrou de ligne ou verrou
  consultatif.

## 3. Inventaire mesuré

### 3.1 Production (`atoma.run`, 2026-10-16)

| Fait | Valeur |
|---|---|
| Store | `/home/atoma/state/atoma.db`, 143 Mo (34 978 pages × 4 Ko), WAL 35 Mo |
| Lignes | 25 621 dans 69 tables |
| Plus grosses tables | `run_checkpoint_actions` 12 458 · `platform_events` 2 824 · `project_embedding_cache` 2 710 · `lifecycle_events` 2 090 · `run_checkpoint_files` 1 536 · `project_run_payers` 1 032 |
| `SQLITE_BUSY` / « database is locked » dans `journalctl -u 'atoma*'` depuis le 2026-09-18 | 0 |
| Hôte | 4 vCPU, 7,6 Go RAM dont 3,1 Go disponibles, 12 Go disque libres |
| PostgreSQL installé | non |
| Services | `atoma.service` (control plane + viz + MCP), `atoma-mender.service` (checkout séparé, son propre `ATOMA_DB_PATH`), `atoma-hosting-launcher.service` (état opérationnel seul, jamais le store) |

Un store de 143 Mo à 25 000 lignes est négligeable pour les deux moteurs.
Le volume n'est un argument ni pour ni contre.

### 3.2 Topologie des processus sur le store

Écrivains, tous sur une machine :

1. le serveur viz (`atoma.service`) : HTTP, MCP, sentinelle, analyste,
   gate d'authentification ;
2. l'enfant de run, un par run, qui reçoit `ATOMA_DB_PATH` du coordinateur
   (`src/projects/coordinator.ts:849`) ;
3. le worker d'apprentissage, détaché (`src/run/learningProcess.ts`) ;
4. le mender, service systemd sur un checkout séparé ;
5. l'assayer (`src/supervisor/assayer.ts:239`) ;
6. les CLI opérateur et les outils MCP d'écriture de niveau plateforme.

Lecteurs en lecture seule à `timeout: 0` (« attendre est une mauvaise réponse,
pas une réponse lente ») : l'autorité de retrieval de l'enfant de run
(`src/projects/retrievalLaunch.ts`), `runAuthority.ts`, le lancement Haystack.
Lecteurs hors Node : `scripts/restore-drill.py` (module Python `sqlite3`),
plus six scripts `.mjs` qui ouvrent le store directement
(`learning-release-smoke`, `mcp-oauth-browser-smoke`, `packaged-stack-workload`,
`preview-demo`, `retrieval-project-smoke`, `repair-atom-prompts`).

Le worker Element ne voit jamais le store : `packaged-stack-workload.mjs`
le prouve en listant `ATOMA_DB_PATH` parmi les chemins refusés.

### 3.3 SQLite qui n'est PAS le store produit et qui reste SQLite

| Fichier | Usage | Pourquoi il ne migre pas |
|---|---|---|
| `~/.atoma/mcp-run-lock.db` (`src/mcp/runLock.ts`) | bail de run, délibérément global à la machine | raisonne sur des PID et des groupes de processus locaux |
| `<stateRoot>/lock.db` (`src/launcher/volumes.ts`, `node:sqlite`) | une transaction `EXCLUSIVE` comme mutex libéré par l'OS à la mort du processus | c'est un mutex, pas une base |
| `.atoma-codex-home-lease.sqlite` et slots (`src/core/codexHomeLease.ts`) | bail inter-processus du HOME Codex, `timeout: 0` | même raison |

L'analyse de septembre l'avait déjà posé pour le bail MCP ; les deux autres
sont arrivés depuis et obéissent au même principe.

### 3.4 Dialecte SQLite à traduire

| Construction | Fichiers / sites | Cible PostgreSQL |
|---|---:|---|
| `CREATE TRIGGER … RAISE(ABORT)` | 5 / 22 | fonctions trigger PL/pgSQL ou contraintes `CHECK` / mises à jour conditionnelles |
| `sqlite_master`, `PRAGMA table_info` (migrations de convergence à l'ouverture) | 14 + 10 / 50 | migrations versionnées ; `information_schema` seulement pour le diagnostic |
| `datetime('now')`, `strftime` | 11 / 21 | `now()`, `timestamptz`, un seul sérialiseur ISO côté API |
| `json_extract`, `json_valid`, `json_array` | 4 / 20 | `jsonb` et opérateurs `->>` ; le pilote renvoie des objets, les mappers font `JSON.parse` aujourd'hui |
| `rowid`, `AUTOINCREMENT`, `lastInsertRowid` | 6 / 24 | colonnes `GENERATED … AS IDENTITY`, `RETURNING` |
| `INSERT OR IGNORE` / `OR REPLACE` | 5 / 9 | `ON CONFLICT DO NOTHING` / `DO UPDATE` explicite |
| `GLOB`, `instr(` | 5 + 2 / 16 | `LIKE`/`SIMILAR TO`, `position(` |
| `ON CONFLICT` (déjà portable) | 24 | inchangé |
| `.backup()` (sauvegarde en ligne) | 4 | `pg_dump` ou archivage WAL |

### 3.5 Tests et CI

- `vitest run`, 4 workers, 15 s par test ; 470 fichiers ; 272 ouvertures en
  mémoire. La règle « les tests du registre utilisent SQLite en mémoire »
  (AGENTS.md) tombe.
- CI : matrice sur deux lignes Node, `ubuntu-latest`, aucun service
  container. Le job `Hermetic checks` exige `release:check:static` et
  `npm test` verts côte à côte.
- `scripts/sqlite-release-smoke.mjs` prouve la durée de vie des handles
  natifs compilés ; il disparaît avec le pilote.

## 4. Les obstacles, par coût décroissant

### 4.1 Le synchronisme (≈ la moitié du coût)

`src/auth/store.ts` (2 202 lignes), `src/projects/store.ts` (2 844),
`src/registry/atomRegistry.ts` (1 501), `src/github/store.ts`,
`src/preview/store.ts`, `src/core/ledger.ts`, `src/platform/events.ts`,
`src/atoms/prefilterCache.ts`, `src/skills/metaStore.ts`,
`src/skills/learningQueue.ts` : **zéro `async`**. Il n'existe pas de pilote
PostgreSQL synchrone pour Node ; les contournements (`deasync`, worker
synchrone via `Atomics.wait`) sont rejetés d'avance : ils bloquent la boucle
d'événements du serveur viz.

Propagation : 60 fichiers source importent `auth/store`, 57 `projects/store`,
49 `preview/store`, 49 `github/store`, 38 `core/stores`, 19 `atomRegistry`
(et 101 fichiers de test), 18 `skills/registry`. Les 93 callbacks
`db.transaction(() => …)` sont synchrones par contrat de `better-sqlite3` ;
en PostgreSQL une transaction est une séquence d'`await` sur un client
réservé. Le chemin chaud : le cache du préfiltre (`src/atoms/cost.ts`) est
consulté à chaque décision, et les compteurs de confiance sont modifiés dans
la boucle de supervision sous `.immediate()` (16 sites dans `atomRegistry`).

### 4.2 Les invariants transactionnels (86 `.immediate()`)

Chacun doit être réexprimé avec la primitive la plus étroite (§7 de
septembre, toujours valable) : mise à jour conditionnelle avec `RETURNING`
pour les consommations à usage unique (invitations, états OAuth, codes et
refresh du MCP OAuth, livraisons webhook), verrou consultatif par
espace de noms pour l'allocation de noms et d'ordinaux du registre,
`successes = successes + $1` dans la même transaction que l'événement de
cycle de vie. Nouveaux depuis septembre : la réclamation d'un job
d'apprentissage, les quotas journaliers de conversation, le scellement
d'une frontière de checkpoint (un seul parcours sous verrou depuis
`4d9322fc` ; en PostgreSQL ce verrou devient explicite et les 170 actions
par run moyennes doivent être insérées par lot), les déploiements hébergés.

### 4.3 La latence par instruction

SQLite en processus répond en microsecondes ; PostgreSQL sur socket Unix
local en 100 à 300 µs par aller-retour. Avec 525 sites dont certains dans
des boucles (actions de checkpoint par appel d'outil, événements plateforme,
cache du préfiltre), l'effet sur la durée d'un run est mesurable et doit
être mesuré en phase 3, pas supposé nul.

### 4.4 L'exploitation sur un VPS déjà chargé

L'hôte a 3,1 Go disponibles ; un PostgreSQL modeste (`shared_buffers`
256 Mo, 20 connexions) en prend 400 à 600 Mo avec ses backends. Le pool
total se calcule sur **tous** les processus : serveur viz, un enfant par run
admis (10 par défaut), workers d'apprentissage, mender, assayer, CLI.
S'ajoutent : rôles (migrateur / runtime), TLS, sauvegardes (`pg_dump` plus
archivage WAL si PITR), supervision, un service `postgres` épinglé par
digest dans `deploy/compose.yaml`, l'ordre des unités systemd, le mender sur
son checkout séparé qui doit recevoir `ATOMA_DATABASE_URL` et un rôle.

### 4.5 La périphérie

`npm run backup` (sauvegarde en ligne SQLite + archives), `restore-drill.py`,
`deploy-preflight` (lit le store en lecture seule pour attendre les runs en
cours), `doctor`, les six scripts qui ouvrent le store, les lecteurs en
lecture seule du viz et du MCP, les CLI `registry`, `ledger`, `skills`,
`curriculum`, `projects-maintenance`.

### 4.6 Le déploiement continu

Chaque push sur `main` déploie. Une branche de 25 à 40 jours divergerait
de tout ce qui touche les stores entre-temps (25 fichiers y sont entrés en
six semaines). Le programme doit donc **atterrir par PR neutres**, ce qui
impose la double implémentation transitoire décrite en §7 : l'analyse de
septembre refusait un « wrapper SQL plus petit dénominateur commun », pas
des dépôts de domaine à deux implémentations sous une suite de contrat
partagée, qu'elle nommait comme le prix du mode hors ligne.

## 5. Ce que PostgreSQL apporterait, et à qui

| Objectif réel | PostgreSQL l'apporte ? | Réponse moins chère |
|---|---|---|
| Sécurité de la concurrence sur un hôte | déjà obtenue (W4a, zéro `SQLITE_BUSY` en 4 semaines) | instrumenter le critère de réouverture (§7 A1) |
| Un second hôte partageant le store | oui, c'est le cas d'usage | aucune ; c'est le déclencheur légitime |
| Sauvegarde continue / PITR | oui | réplication continue du fichier (Litestream vers un stockage distant), sans changer le code |
| Croissance des données | sans objet à 143 Mo | rétention sur `run_checkpoint_actions` et `platform_events` |
| Crédibilité SaaS multi-tenant | non (§2.2 de septembre) ; « a run is a run » assume le commun | — |
| Requêtes analytiques, outillage SQL externe | partiellement | le store SQLite est déjà lisible par Python et `sqlite3` |

## 6. Critères de décision

Lancer la migration si **l'une** de ces conditions est vraie :

1. un second hôte doit partager le store dans les six mois (séparer le
   control plane de l'exécution des runs, ou une seconde région) ;
2. le compteur de §7 A1 enregistre un `SQLITE_BUSY` après `busy_timeout`,
   ou des attentes de verrou > 1 s récurrentes, avec tous les écrivains en
   `.immediate()` ;
3. une exigence de sauvegarde avec RPO inférieur à la cadence de
   `npm run backup` que la réplication de fichier ne satisfait pas ;
4. un écrivain que l'on ne sait plus énumérer (le critère « Fit » du
   tableau du gate 0).

Sinon : non, et ce document reste le plan.

## 7. Plan d'action

### Piste A — maintenant, quelle que soit la décision

| # | Action | Coût | Livre |
|---|---|---|---|
| A1 | Compter les `SqliteError` de code `SQLITE_BUSY` et les transactions > 1 s dans les métriques du serveur viz et une règle de sentinelle ; les exposer dans `atoma_mcp_health` | 0,5 j | le critère de réouverture devient une mesure |
| A2 | Rétention sur `run_checkpoint_actions` (12 458 lignes pour 72 checkpoints) et `platform_events`, alignée sur la rétention des projets | 0,5 j | la seule table qui croît avec chaque appel d'outil |
| A3 | Décider si la réplication continue du fichier (Litestream, vers un stockage hors machine) remplace la cadence manuelle de `npm run backup` ; si oui, l'installer comme unité systemd et l'ajouter au `restore-drill` | 1 j + décision | un RPO en secondes sans toucher au code |
| A4 | Fermer les sept scripts et lecteurs qui ouvrent le store hors des dépôts : passer par `openStoreHandle` ou un lecteur typé ; règle « aucun nouveau site SQLite direct » dans les `AGENTS.md` concernés | 1 j | la migration, si elle vient, n'a qu'une frontière à déplacer |

### Piste B — si le propriétaire décide la migration

Chaque phase atterrit sur `main` en PR vertes et neutres ; SQLite reste le
moteur par défaut jusqu'à la bascule (phase 6). Ne pas commencer la phase 1
sans la phase 0 signée.

**Phase 0 — décision (le propriétaire).** Réponses écrites à : topologie
cible et nombre maximal d'hôtes et d'écrivains ; PostgreSQL sur le VPS ou
géré ; le mode hors ligne / développeur local (PostgreSQL obligatoire,
PGlite, ou implémentation SQLite conservée) ; RPO, RTO, fenêtre de
maintenance ; propriétaire de la bascule et point de non-retour ; gel des
travaux concurrents sur les stores. Les questions 1 à 4, 6 et 8 de §15 de
septembre restent posées ; 5 et 7 sont closes par « a run is a run ».

**Phase 1 — dépôts asynchrones sur SQLite (≈ 8 à 12 j).** Définir un dépôt
par domaine exposant des **opérations de domaine** qui renvoient des
promesses (`consumeInvitation`, `allocateAtomName`, `sealCheckpointBoundary`),
jamais une transaction générique. L'implémentation SQLite enveloppe le code
synchrone existant ; les 93 transactions restent synchrones à l'intérieur.
Convertir les appelants domaine par domaine, en commençant par les feuilles
(`platform/settings`, `viz/push`, `github`, `preview`, `auth/mcpOAuthStore`,
`projects/hostingStore`), puis `auth` (le gate de chaque requête), puis
`projects`, `conversationStore`, `run/checkpoint`, `clientQuestions`,
`retrieval*`, et en dernier `registry`, `core/ledger`, `skills/metaStore`,
`learningQueue`, `prefilterCache` (la boucle de supervision). Cette phase
porte le risque de coloration et doit être couverte par les tests de chemin
de production existants ; elle est inutile si la migration s'arrête là.

**Phase 2 — fondation PostgreSQL (≈ 3 à 5 j).** `ATOMA_DATABASE_URL`, un
pool borné par processus, délais (connexion, instruction, verrou, idle in
transaction), traduction des SQLSTATE en erreurs de domaine typées (`23505`,
`23503`, `40001`, `40P01`), retries bornés avec jitter sur les seules
transactions déclarées rejouables, migrations versionnées avec table
`schema_migrations` et verrou consultatif, vérification de version au
démarrage sans mutation, politique `jsonb` / `timestamptz` / ISO. CI : service
container `postgres` épinglé, une base par worker vitest, migrations avant
les fixtures ; `doctor` vérifie le backend configuré.

**Phase 3 — implémentations PostgreSQL par domaine (≈ 8 à 12 j).** Dans le
même ordre que la phase 1. La suite de contrat de chaque dépôt tourne sur
les deux implémentations (`describe.each`). Les régressions de concurrence
de §12.2 de septembre se jouent avec deux connexions ou processus réels :
allocation de noms, consommation à usage unique, transitions CAS des runs
et publications, compteur + événement atomiques, bail de la sentinelle avec
jeton et génération de clôture, réclamation d'un job d'apprentissage,
scellement d'un checkpoint. Mesurer la latence d'un run complet sur les
deux moteurs avant de continuer.

**Phase 4 — périphérie (≈ 3 à 5 j).** Lecteurs du viz et du MCP, CLI
opérateur, `deploy-preflight`, `doctor`, `backup` (`pg_dump` + archives, le
manifeste nomme le backend), `restore-drill.py` (`psql`), les six scripts,
le mender et l'assayer, `compose.yaml` et les unités systemd.

**Phase 5 — exploitation (≈ 2 à 3 j).** Installation sur le VPS ou service
géré, rôles migrateur / runtime, TLS si réseau, sauvegardes et archivage
WAL, supervision du pool et des verrous, répétition de restauration dans un
environnement isolé.

**Phase 6 — importeur et bascule (≈ 3 à 5 j).** Importeur idempotent et
versionné depuis une sauvegarde en ligne SQLite (§10.1 de septembre),
répété sur des instantanés de production ; vérification par comptage de
lignes par table, contraintes, hachages des corps immuables, projection du
ledger contre les compteurs. Bascule sous gel d'écriture : `deploy-preflight`
attend déjà la fin des runs en cours ; sauvegarde finale conservée
immuable ; import ; vérification ; smoke compilé ; point de non-retour
déclaré. Retour arrière possible uniquement avant la première écriture
acceptée par PostgreSQL.

**Phase 7 — retrait.** Supprimer les implémentations SQLite des dépôts
produit, ou les conserver pour le mode hors ligne selon la phase 0 ; les
trois SQLite locaux de §3.3 restent. Mettre à jour `AGENTS.md`,
`src/core/AGENTS.md`, le README et `docs:facts`.

Total : 27 à 42 jours hors phase 0, tests compris dans chaque phase. Les
phases 1 et 3 dominent ; rien ne les raccourcit sans réduire la surface
(§2).

## 8. Ce qui ne doit pas arriver pendant le programme

- Aucun appel de modèle, de GitHub, de conteneur ou d'attente utilisateur
  dans une transaction PostgreSQL.
- Aucun nouveau site SQLite direct ; tout passe par les dépôts de la phase 1.
- Aucune double écriture applicative : gel d'écriture et import vérifié.
- Aucune édition de `src/` pendant un lot de burn-in ; les agents parallèles
  travaillent dans des worktrees séparés avec leur propre
  `ATOMA_DATABASE_URL`.
- Aucune phase ne modifie le comportement observable d'un run ; les
  benchmarks contrôlés se rejouent sur les deux moteurs le même jour.

## 9. Risques propres à cette révision

| Risque | Pourquoi ici | Mitigation |
|---|---|---|
| Coloration `async` de la boucle de supervision | compteurs de confiance et préfiltre sur le chemin chaud, 16 `.immediate()` dans `atomRegistry` | phase 1 domaine par domaine, registre en dernier, tests de chemin de production |
| Dérive de `main` pendant le programme | déploiement à chaque push, 25 fichiers de stores ajoutés en six semaines | gel des stores signé en phase 0 ; PR neutres ; double implémentation |
| Mémoire du VPS | 3,1 Go disponibles | dimensionner et mesurer avant la phase 5, ou service géré |
| Latence par instruction sur les boucles | checkpoint, événements, préfiltre | insertion par lot, mesure en phase 3 avec seuil d'acceptation écrit |
| `timeout: 0` des lecteurs d'autorité | « attendre est une mauvaise réponse » | `lock_timeout` et `NOWAIT` explicites, même sémantique testée |
| Outillage hors Node | `restore-drill.py`, scripts de smoke | phase 4 avant toute bascule |
| Perte du critère de réouverture | la décision resterait une intuition | piste A1 avant tout |

## 10. Sources

- [Analyse PostgreSQL du 2026-09-02](postgresql-migration-analysis-2026-09-02.md) : frontière cible, sémantique transactionnelle, importeur, acceptation (toujours normatifs hors §8).
- [Gate 0 et journal des décisions](../../docs/saas-architecture.md#decision-gate-0--hardened-sqlite-or-postgresql).
- [« A run is a run »](../../docs/decisions/platform-trust-2026-09-15.md).
- [Revue de code 2026-10-09, §2.9](../reviews/code-review-2026-10-09.md) et le correctif `4d9322fc`.
- Mesures de production de ce jour : `systemctl`, `journalctl -u 'atoma*' --since 2026-09-18`, comptage par table via `better-sqlite3` en lecture seule sur `/home/atoma/state/atoma.db`.
