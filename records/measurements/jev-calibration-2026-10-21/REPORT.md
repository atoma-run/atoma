# Jev calibration — production reading, 2026-10-21

Lecture effectuée via le MCP de production `https://atoma.run/mcp`, avec
`atoma_jev_calibrate`. Fenêtre des débuts de runs :
**2026-10-12 16:00:00 UTC → 2026-10-21 08:02:05 UTC**, borne supérieure exclusive.
Cela reprend la dernière lecture documentée du 12 octobre. Aucun nouveau run,
changement de seuil, changement de holdout ou déploiement.

## Conclusion

La validation des plans reste la principale source d'économie estimée.
Le préfiltre raccourcit le chemin de nombreux choix mais ne montre pas
d'économie monétaire nette dans le sous-ensemble où une référence est disponible.
La validation des résultats coûte presque toujours une lecture Jev supplémentaire
avant le modèle et présente toujours des désaccords sur la complétude des preuves.
Le sweep ne justifie pas de reprendre sans réserve la proposition antérieure
`pickConfidence=0.7, fit=0.5` : elle produit désormais 9 désaccords pour 41 accords
sur les choix d'agent différés.

Le holdout d'effort atteint son plancher de lecture, mais son verdict
préenregistré reste **inconclusive**. Tous les réglages restent inchangés.

## Méthode et couverture

1. Lecture gratuite avec `auditsOnly:true`, avant toute interrogation TypeSafe.
2. Fixation de `since`, `until` et `includeJevRuns:true`.
3. Quatre appels de calibration avec `limit:400`, `sweep:true`, offsets
   **0 → 400 → 800 → 1200 → null**. Les quatre réponses recensent le même
   corpus de 1 562 décisions.
4. Relecture gratuite des quatre `resultIds` ensemble pour obtenir les
   statistiques globales et le sweep, sans réinterroger TypeSafe.
5. Pagination de tous les détails par lots de 50 : **989 lignes uniques**,
   dont 962 réponses et 27 refus préventifs « too many independent requirements ».
   Ce sont des cas volontairement renvoyés au modèle, pas 27 pannes réseau.
6. `auditsOnly` ne renvoie que les 25 derniers `outcomes`. Neuf fenêtres
   disjointes plus courtes ont donc été lues : **104/104 outcomes** conservés,
   sans doublon ni troncature.
7. Les quatre traces des désaccords de validation décrits plus bas ont été
   lues jusqu'au bout en résumé ; les événements concernés ont été lus
   intégralement avec pagination de texte et empreinte `snapshot`.

Six organisations sont couvertes. Le lecteur signale quatre fichiers de trace
illisibles dans le scan du corpus ; leur appartenance à la fenêtre ne peut
pas être établie par cette réponse. Les 104 runs sont ceux lisibles et retenus.
La borne porte sur le début des runs, pas sur la date individuelle des événements.

Les 1 562 décisions se répartissent en 989 enregistrements de calibration,
235 résultats inéligibles, 313 revues de délégation exclues, 24 résultats sous
suite parentale exclus et une décision non parsée. Aucune recette rejouée
ne manque de ses détails d'ouverture. Les limites de politique sont conservées.

Avec `includeJevRuns`, le rejeu porte sur les décisions que Jev a laissées
au modèle. Ses taux de reprise ne sont **pas** les taux de décision en production.
Le modèle est la référence de comparaison, pas une vérité terrain indépendante.
Les audits en production sont analysés séparément et ne sont pas additionnés
aux faux accords du rejeu.

## Audits des approbations en production

**Plans : 1 désaccord sur 27 audits jugés (3,7 %).** Les plans sont audités
sur échantillon ; les 27 audits ne représentent pas les 248 courts-circuits
de validation observés.

- Run `2c628a5b-ec3b-4c7a-bb36-f0776312b666`, Methane.
- Approbation Jev `15ce08eb-1b6a-4eb6-8f1f-e63e633b36ba` ;
  audit `3c7bdf59-a4d9-4875-a24d-0fd8b96ee9ca`.
- Le plan autorise un diagnostic honnête à zéro annonce en cas de blocage
  Spitogatos ; le critère d'acceptation exige une annonce fraîche avec ses champs.
  Le modèle reproche de ne pas cibler et vérifier explicitement ces champs.
  C'est un conflit entre le résultat conditionnel prévu et le critère,
  pas la preuve qu'un collecteur est techniquement cassé.
- Score minimal de couverture Jev **0,96**, drapeaux 0,10/0,11.
  Relever simplement la couverture à 0,9 ne retirerait pas cette approbation.
- Jev : 352 ms, 0,000395136 $. Audit : 8 444 ms, 0,0063808 $.

**Résultats : 1 désaccord sur 1 audit jugé.** Un seul cas ne permet pas
d'estimer un taux d'erreur généralisable. Le taux d'audit des approbations
de résultat est de 100 % dans le contrat actuel.

- Run `e457d2c8-74f1-49e3-b1b7-4d4df1deba31`, Ammonia.
- Approbation Jev `6593497c-76d4-442c-97ee-465ff1e3333f` ;
  audit `02500b38-a77e-44e9-9404-e7af67f0be4a`.
- Les échecs de tests sont conservés, mais l'inventaire des empreintes omet
  des sources et données effectivement lues : `collect-listings.js`,
  `collectors/spitogatos.js`, `data/listings.csv` et
  `data/raw-listings.jsonl`. Le refus porte sur l'exhaustivité de la preuve.
- Scores « shown_done » **0,97 et 0,93** ; `reports_incomplete=0.14`.
  Un seuil de résultat à 0,8 ou 0,9 laisserait aussi passer ce cas.
- Jev : 368 ms, 0,000746172 $. Audit : 10 769 ms, 0,00964448 $.
  L'audit est un autre appel modèle : le court-circuit réduit le chemin
  synchrone mais n'économise pas cet appel.

## Rejeu aux seuils actuels

- **Plans :** 262 décisions renseignées, dont 55 refus du modèle. Jev approuve
  10 cas : 9 accords et **1 désaccord**. Il reprend donc 9/207 approbations
  du modèle (4,3 %) dans cette bande déjà différée.
- **Résultats :** 335 décisions, dont 159 refus du modèle. Jev approuve
  3 cas : 2 accords et **1 désaccord**, soit 2/176 reprises correctes (1,1 %).
- **Agents L2 :** 254 choix, 5 accords, aucun désaccord et 249 renvois au modèle.
- **Recettes L2 :** 111 choix, 11 accords, 1 désaccord et 99 renvois au modèle.

Le désaccord de plan est l'événement `7a9dcacc-b55d-4494-b63e-7c386b2e9378`
du run `ade448fc-7cb2-47ec-a538-437bcd077d69`. Le modèle exige que le plan
nomme le timeout/nettoyage du processus enfant et la séquence de reprise sur
le même serveur avec refus d'une admission concurrente. Jev considère que les
formulations générales couvrent les exigences (minimum 0,85).

Le désaccord de résultat est `2b6f2987-ef1e-4caf-ae90-a65e6163557a`,
run `b04565ec-aa95-4748-8702-ea34bb4c266d`. La cartographie annoncée des
modules/routes n'est pas entièrement corroborée par les extraits observés :
exports, signatures, méthodes, statuts et JSON littéraux manquent de preuve.
Les deux scores Jev sont 0,70/0,71 et `reports_incomplete=0.27`.

Le désaccord de recette est `0405998e-ab38-4725-bbf3-c500e5ff4f59`,
run `b4c281b5-6022-4ccd-a1eb-d69c5c0165ce` :
le modèle choisit `audit-protected-source-integrity`, Jev choisit
`none_of_these`. Le fit de cette recette est **0,49**, juste sous le
plancher de 0,5. C'est un désaccord de sélection/abstention, pas une approbation
erronée de travail livré.

Les deux désaccords du rejeu de validation portent à nouveau sur une couverture
affirmée trop largement par rapport aux détails explicitement démontrés.

## Sweep : lectures hypothétiques, sans appliquer de seuil

Pour les plans, avec `flag=0.3` :

- Couverture 0,8 actuelle : **9 accords / 1 désaccord**.
- Couverture 0,7 : **26 / 2**.
- Couverture 0,6 : **53 / 11**.
- Couverture 0,9 : **2 / 0**.

À couverture 0,8, porter `flag` de 0,3 à 0,4 donnerait 27 accords et
1 désaccord ; à 0,5, 33 accords et 3 désaccords. Ce sont des lectures d'une
bande de déférés, soumises à la dérive du modèle, sans validation prospective.
L'absence de désaccord au seuil 0,9 dans ce rejeu ne couvre pas l'audit réel
de plan à 0,96 décrit plus haut.

Pour les résultats, avec `flag=0.3` :

- Couverture 0,7 actuelle : **2 accords / 1 désaccord**.
- Couverture 0,6 : **6 / 1**.
- Couverture 0,8 : **0 / 0** : ce réglage retire également tous les accords.
- Couverture 0,7 et `flag=0.2` : **1 / 0**.

Pour les agents :

- `pickConfidence=0.5, fit=0.7` actuels : **5 accords / 0 désaccord**.
- Ancien candidat `pickConfidence=0.7, fit=0.5` : **41 / 9**
  (18 % de désaccords parmi les décisions prises).
- `pickConfidence=0.5, fit=0.5` : **63 / 14**.

Le faible nombre de reprises à réglages actuels coexiste avec une activité
réelle importante : Jev a déjà pris les choix faciles en amont. Les causes
dominantes des déférés d'agents sont la confiance (129) et le fit (113).
Il n'y a aucun désaccord d'agent au réglage actuel ; cette observation seule
ne permet pas d'attribuer causalement le résultat au regroupement des quasi-jumeaux.

Le jeu de questions historique « legacy » produit **22** faux accords de
plan contre **1** avec les questions actuelles, et 137 désaccords d'agent.
Ces résultats ne décrivent pas le comportement live actuel.

## Coûts et latences

La **calibration coûte 0,90683 $**, questions actuelles et comparaison legacy
comprises. Ce montant est distinct des coûts déjà engagés par les runs.
Les relectures `resultIds` et `auditsOnly` n'ajoutent aucune interrogation TypeSafe.
Le modèle servi est `jev-1.13.0`.

Latence des requêtes documentées du rejeu : **médiane 313 ms, p95 560 ms,
maximum 10 427 ms**. Cela ne mesure ni la durée d'un run ni une économie
de temps de bout en bout. La latence legacy n'est pas incluse dans cette
distribution ; son coût est inclus dans le coût de calibration.

Sur les 104 runs, les lectures Jev déjà effectuées coûtent **1,329902 $**,
et les audits modèle **0,135711 $**. Les appels modèle de repli associés
coûtent 22,225330 $ ; ce montant est un coût observé, pas une économie.

- **Préfiltre :** 1 097 lectures, 416 courts-circuits (37,9 %), coût Jev
  0,801626 $. Économie nette estimée **−0,057594 $** dans les runs avec
  référence ; 11 runs n'ont pas de référence, pour 0,020359 $ de coût Jev
  supplémentaire dont le bénéfice reste inconnu.
- **Plans :** 531 lectures, 248 courts-circuits (46,7 %), coût Jev
  0,197576 $, audits 0,126067 $. Économie nette estimée **+7,036933 $**
  dans les runs avec référence ; 5 runs restent sans référence.
- **Résultats :** 342 lectures, 1 court-circuit (0,29 %), coût Jev
  0,282717 $, audit 0,009644 $. Économie nette estimée **−0,282128 $**.
  Le seul court-circuit déclenche lui-même un audit : aucun appel modèle
  effectivement supprimé au total sur cette approbation.
- **Effort :** 661 lectures, coût Jev 0,043590 $. Le rapport n'estime pas
  une économie de modèle pour ce rôle.
- **Compilation :** 20 lectures, coût Jev 0,004392 $. Aucun cas de compilation
  supplémentaire n'a été soumis ; aucun script généré ou exécuté pour cette lecture.

Ces économies sont le proxy fourni par le lecteur : médianes de coûts modèle
du même run, moins Jev et les audits. Elles ne viennent pas d'un essai contrôlé.
Le sous-total connu vaut +6,697211 $, sans attribuer de bénéfice aux références
inconnues ni au rôle d'effort ou de compilation.

Les latences live disponibles par rôle sont des médianes par run. La médiane
de ces médianes est 395,25 ms pour le préfiltre, 338 ms pour les plans,
388,5 ms pour les résultats, 254 ms pour l'effort et 311 ms pour la compilation.
Ce ne sont pas des médianes regroupant tous les appels ni des p95 live.
Les audits contestés ont pris respectivement 8,444 s et 10,769 s en arrière-plan.

## Holdout d'effort : première lecture à effectif suffisant

Le corpus contient 661 lectures : 533 indécises, 67 appliquées et 61 retenues
en contrôle. Toutes les décisions tranchées sont `high` ; aucune n'est `low`.

La population primaire compte **63 premières tentatives dans 33 runs** :
28 `high/applied` et 35 `high/held-out`. Les provenances de ces 33 runs ont
été lues en production ; leur L1 est `own:openai:gpt-5.6-luna`.
Les 22 révisions descendent de `5bf1f231`. La seule modification ultérieure
des trois fichiers du mécanisme est le déplacement de liens documentaires
dans `624ebec9` : questions, seuils et chemin d'effort restent comparables.
Les 65 autres décisions tranchées sont des tentatives ultérieures, exclues
de cette analyse primaire.

- **Appliqué :** 28 résultats connus, 10 approbations et 18 refus,
  soit **64,3 %** de refus ; durée médiane 142 963 ms ; sortie médiane
  17 891 tokens.
- **Contrôle :** 35 lignes, 19 approbations, 13 refus et 3 résultats inconnus,
  soit **40,6 %** de refus parmi les 32 connus ; durée médiane 94 129 ms ;
  sortie médiane 7 617 tokens.
- Écart de refus : **+23,66 points** avec `high`. Ratio de durée : **1,519**.
  Aucun écart entre le bras déclaré et l'effort effectivement demandé.

Le plancher de 20 résultats connus par bras est franchi. Pourtant la règle
« keep high » ne passe pas, car le bras appliqué ne réduit pas les refus.
La règle « withdraw high » exige un écart absolu de refus inférieur à 20 points,
ce qui ne passe pas non plus. Le verdict prescrit est donc **inconclusive**,
même si les chiffres descriptifs ne sont pas favorables à `high`.
La lecture suivante prévue par le protocole est à 40 résultats connus par bras.
Les durées incluent les outils ; les trois résultats inconnus du contrôle
restent visibles. Aucun réglage ni protocole n'est modifié.

## Fichiers et reproduction

- [Réponses paginées, sweep et 989 détails](calibration-pages.json).
- [Rapport global retourné par le MCP](calibration-summary.json).
- [Audits et outcomes complets des 104 runs](audits.json).
- [Événements et traces des désaccords](disagreement-evidence.json).
- [63 lignes primaires d'effort](effort-primary-rows.json) et
  [provenances de production](effort-primary-provenance.json).
- [Agrégation dérivée](analysis.json), recalculable hors ligne avec
  `node records/measurements/jev-calibration-2026-10-21/analyze.mjs`.

Résultats conservés en mémoire serveur, réutilisables gratuitement tant
qu'ils existent, sans changer les réglages de production :
`3206611a-00fb-49c3-9f37-ec846d714ae8`,
`9223eb27-de22-4bbe-ad12-09ea8f8a5ff6`,
`35d60c20-16c1-4a77-a555-4dc20924e0c5`,
`67875a81-c282-4730-b76e-12f00fba32ee`.

La copie locale des scores, rapports et événements conserve la lecture
même après un redémarrage du serveur.

## Follow-up: why incomplete proof receives high scores

Analyse demandée après cette calibration, le même jour. **Proposition seulement** :
aucune question du runtime, aucun seuil, aucun holdout et aucun run ne sont modifiés.
Une lecture MCP gratuite a reconfirmé l'événement Jev du résultat audité.
Les quatre cas déjà archivés ont ensuite été reconstruits avec les fonctions
pures du produit, sans appel TypeSafe, sans exécution des commandes des traces.

### Ce qui est établi, et ce qui reste une hypothèse

Les requêtes d'approbation complètes ne sont pas enregistrées dans les événements
Jev : ils conservent les réponses, pas le state envoyé. Les états reconstruits
ici ne sont donc pas des captures réseau. Le nombre de questions reconstruit
correspond toutefois exactement aux neuf et deux exigences des deux audits
réels. Le builder des questions est inchangé sur cette période, hors liens
documentaires. Le routage, les coupes et les définitions des options sont
vérifiables ; le mécanisme cognitif interne de Jev ne l'est pas.

**1. L'option “preuve partielle” est mal définie.**

Dans `RESULT_REQUIREMENT_CRITERIA`, `shown_done` commence par une observation
qui démontre l'exigence ; `not_shown` décrit “No observation bears on this
requirement”. Pourtant l'instruction exige déjà que chaque condition soit
observée. Les options ne décrivent pas explicitement le cas intermédiaire :
une observation pertinente existe, mais une partie du contrat n'est pas prouvée.
L'instruction demande une couverture universelle, tandis que la description de
l'option d'abstention évoque une absence totale. C'est une ambiguïté réelle.
Que Jev résolve cette ambiguïté par reconnaissance du thème plutôt que par
comparaison exhaustive est l'hypothèse principale, pas une pensée observée.

Le cas des empreintes réunit sorties enregistrées, commande sha256 réussie,
liste assez longue de fichiers et note relue. Ces observations démontrent
beaucoup de travail pertinent ; elles ne démontrent pas automatiquement que
l'ensemble demandé est couvert. Le 0,97 porte sur la reproduction des échecs,
effectivement établie ; c'est le **0,93 de la seconde exigence** qui surestime
la complétude des enregistrements et empreintes.

**2. Une phrase n'est pas une exigence atomique.**

La seconde exigence de ce cas agrège séparation des sorties, préservation de
l'état initial, empreintes des deux suites et de leurs archives/fixtures.
Le cas de cartographie des routes concentre modules, exports, signatures,
routes, méthodes, statuts, corps JSON, authentification et injections dans une
seule question. Une question “par phrase” reste un jugement complexe à plusieurs
conditions. Modifier seulement l'adjectif “complete” ne rend pas ce travail atomique.
Le découpage existant par ponctuation reconnaît lui-même cette limite.

**3. Les deux évaluateurs ne reçoivent pas tout à fait la même information.**

- Dans le plan Spitogatos, la description autorise explicitement un diagnostic
  à zéro ligne en cas de blocage. Ses neuf segments sont les neuf questions
  visibles dans l'événement Jev. Le critère c1 exigeant une annonce fraîche
  n'est pas une dixième question. Au L2, le champ `criteria` de `jevApproval`
  existe mais cet appel ne le renseigne pas.
- Le contexte rendu par le validateur contient ce c1 après les longs inputs :
  il commence à l'offset **41 961** du JSON de contexte reconstruit, qui compte
  42 335 caractères. `buildApproval` coupe ce champ à **20 000** caractères.
  Le c1 de phase disparaît. Un ancien refus cité dans les inputs peut encore
  évoquer c1 : cela ne remplace pas sa transmission comme exigence actuelle.
  Le score de couverture 0,96 n'est donc pas la mesure d'un contrôle explicite
  de ce critère.
- Dans le résultat des empreintes, le bloc indépendant contient **24 246**
  caractères ; Jev en garde les 4 000 premiers et les 4 000 derniers, plus le
  marqueur de coupe. Le milieu supprimé contient `protectedFiles` et
  `protectedFiles.map(checksum)` de la suite : précisément la relation entre
  les données CSV/JSONL lues et leur contrôle d'intégrité. Les noms de chemins
  restent parfois ailleurs, dans une configuration ; ce n'est pas la même
  preuve de lecture.
- Dans la cartographie de routes, la sélection Jev réduit les 17 lignes de
  preuve du modèle à 13 observations plus un avis d'omission. Le nombre de
  lignes n'établit pas à lui seul quelles conditions sont perdues, mais il
  interdit de supposer une entrée identique.

Ces coupes n'établissent pas que Jev aurait répondu correctement sans elles.
Elles établissent qu'une simple réécriture ne peut restituer une information
qu'il n'a pas reçue.

**4. Deux signaux sont faciles à surinterpréter.**

`reports_incomplete` demande si le résultat avoue un travail inachevé.
Un résultat assuré mais incomplet peut légitimement répondre non à cette
question. Le 0,14 ne mesure donc pas la probabilité de preuves incomplètes.
Je propose de conserver cette question étroite, pas d'en faire un second
jugement global de complétude.

`acceptable` est le minimum des scores d'exigence et des inverses de drapeaux.
Le résultat audité vaut **0,86** sur cet indicateur, malgré des exigences à
0,97/0,93. Ce nombre ne signifie pas 86 % de probabilité indépendante que
toute la tâche est correcte. Ni les distributions de choix ni leur minimum
ne constituent ici une calibration empirique de l'exhaustivité des preuves.

### Correction proposée

Les formulations exactes, en anglais et avec les mêmes types et clés de
réponse, sont dans [question-proposal.json](question-proposal.json).
Les seuils, les problem flags et le lecteur de réponses sont conservés.

Pour RESULT, rendre les trois options exhaustives :

- `shown_done` : **toutes** les conditions exigées sont étayées par des
  observations applicables ou du contenu demandé directement vérifiable.
  Une liste exhaustive doit couvrir l'ensemble requis, pas quelques membres.
- `shown_broken` : une observation établit qu'au moins une condition est fausse.
  Un échec demandé pour reproduction n'est pas une violation.
- `not_shown` : **au moins une condition reste inconnue**, même si d'autres
  sont prouvées. Inclure explicitement preuves partielles, couverture non
  établie et extrait utile tronqué. Une omission n'affirme pas que le travail
  n'a jamais été fait.

Pour PLAN, remplacer “names or plainly includes it” par un engagement sur
chaque condition explicitement demandée, avec équivalents non ambigus admis.
Remplacer l'absence totale de mention de `omitted` par **au moins une partie
obligatoire non engagée**. “Je lancerai les tests” ne supplée pas un timeout,
une séquence de reprise ou un cas concurrent expressément imposés. Cela ne
demande ni code de test détaillé ni preuve exécutée avant l'exécution.

Deux prérequis de données accompagnent ces questions :

- Transmettre les critères déjà typés et effectivement obligatoires pour
  l'enfant dans `JevApprovalRequest.criteria`, hors des inputs historiques
  plafonnés. Réutiliser la même sélection de portée que le validateur ;
  ne pas créer une deuxième définition de “binding”, importer tout le
  checklist racine, ni analyser les critères à coups de regex dans la prose.
- Pour les demandes exhaustives, rapprocher le périmètre requis et les
  observations qui le couvrent avec leurs références host. Ne déclarer un
  inventaire complet que si les contrats typés ou le contenu effectivement
  inspecté l'établissent. Si cette relation manque, le verdict de couverture
  reste inconnu et revient au modèle. Une liste des seuls fichiers observés
  ne devient pas l'ensemble requis. Il ne suffit pas d'augmenter les budgets
  ou de renommer une affirmation de l'agent en “preuve”.

Les éléments déjà typés permettent des questions plus petites ; aucune
nouvelle extraction LLM ni heuristique de découpage des virgules n'est proposée.
La prose de la tâche entière reste présente pour ne pas oublier les conditions
que des items structurés omettraient.

Cette orientation suit les limites documentées de Jev : lecture littérale,
conditions multiples, indirection et instructions/options discordantes.
[Documentation TypeSafe](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[questions atomiques](https://docs.typesafe.ai/introduction).

### Limites de la référence et revue contradictoire de la proposition

Le refus Spitogatos est un désaccord de contrat, pas une preuve indépendante
que le plan est techniquement mauvais. Un diagnostic à zéro ligne autorisé
peut être un résultat honnête ; il ne remplit pas pour autant un critère
imposant une annonce. La correction doit préserver ce diagnostic et son
arrêt sur blocage, sans promettre l'accès ni forcer un contournement.

Le refus des empreintes cite aussi des fichiers source, alors que la tâche
nomme suites et archives/fixtures. Ne pas transformer cette liste de refus
en nouvelle obligation “hacher toutes les sources”. Les fichiers de données
réellement lus pour intégrité relèvent du contrôle de périmètre ; l'extension
à chaque import source doit être justifiée séparément par le contrat applicable.
Une référence modèle reste contestable.

Les contrôles négatifs à conserver avant toute adoption :

- Une erreur correctement reproduite doit pouvoir être approuvée même si
  le processus retourne 1.
- Un contenu de fichier peut prouver une propriété statique ; ne pas exiger
  un navigateur ou une nouvelle exécution pour toute affirmation.
- Une observation valable et encore applicable ne devient pas invalide
  parce que le résumé ne la répète pas ; des preuves composées peuvent
  couvrir ensemble une condition.
- Une note relue confirme ses mots, pas la vérité des essais qu'elle raconte.
- Un contrôle partiel doit devenir `not_shown`, pas `shown_broken`.
- Un plan suffisamment précis, avec un engagement équivalent et sans preuve
  déjà exécutée, doit rester `covered`.
- Les critères des autres phases restent contextuels. Une recette active
  n'ajoute pas à elle seule de nouvelles exigences au client.
- Une couverture exhaustive introuvable ne doit pas être inventée à partir
  d'une liste de chemins ou d'un nom de test.

### Validation encore nécessaire

La reconstruction hors ligne prouve les écarts de contrat et de sélection,
**pas** un gain de jugement des nouvelles questions. Aucun score Jev des
formulations proposées n'a été mesuré dans cette étape.

Avant adoption, comparer quatre lectures des mêmes états archivés :
questions actuelles/état actuel, questions proposées/état actuel, questions
actuelles/état corrigé, questions proposées/état corrigé. Cela sépare l'effet
de formulation de celui des informations retrouvées. Garder modèle et seuils
constants ; inclure les accords précédents et les incidents historiques,
pas seulement ces quatre désaccords. Conserver coûts, latences, déférés et
distributions, et vérifier la sensibilité à l'ordre des options et aux
répétitions, sans révéler les labels à Jev.

Le MCP actuel ne propose pas de remplacement arbitraire des questions
d'approbation : `resultIds` relit des réponses existantes et `sweep`
relit des seuils. Aucun des deux ne mesure cette proposition. Un rejeu
de calibration sur les entrées archivées, sans run d'exécution, reste donc
à instrumenter pour cette comparaison. Aucun gain de coût ou de latence
n'est promis avant cette mesure.

[Diagnostic reconstruit](question-diagnosis.json), reproductible sans quota :
`node --import tsx records/measurements/jev-calibration-2026-10-21/diagnose-questions.mjs`.

## Replay preparation after owner approval to test

The owner then requested testing the proposal. Automatic approval review initially
refused copying twenty control events into a local file, then refused the
safer on-host replay because it requires explicit authorization for sending
these derived production states to TypeSafe and incurring its cost. No attempt
was made to route the rejected operation through another tool.

An allowed preflight on the host completed with 24 cases, zero external
requests and no credential read. Trace text remained on the host; only hashes,
counts and identifiers were returned. One selected archived run was absent;
the next distinct run in archived order replaced it before any new model
answer was observed. The availability exclusion is recorded.

The preregistered experiment contains four disagreement cases and twenty
positive model references: six previously agreed plans, two previously agreed
results, six deferred plans approved by the model and six deferred results
approved by the model. Four arms separate original/proposed questions and
original/restored bounded state. Three identical-order repetitions plus an
additional reversed-option reading on twelve cases total **336 requests**.
There is no change to model, thresholds, deployed prompts, trust or holdout.

Preflight confirms that restored packets change 22 of 24 states: seventeen
receive binding phase criteria, nine balance their evidence excerpts, seven
restore bounded readbacks of task-named sources. This is an experimental
packet design, not an implemented production correction. The model references
are never included in request states or questions.

The worker uses the existing compiled `jevAsk` and `readApproval`, bounds
concurrency to four, limits the batch to eight minutes, and stops starting
requests when recorded spending reaches one dollar. Up to four in-flight
requests can finish after that stop; failed requests have unknown billed cost.
The expected charge is a few tens of cents, based on the preceding calibration.
Only numeric answers, identifiers, request hashes, token counts, costs and
latencies leave the host.

- [Frozen protocol and case identifiers](replay-preregistration.json).
- [Completed no-network preflight](replay-preflight.ndjson).
- [Worker source](replay-worker-template.mjs) and
  [result aggregation](analyze-replay.mjs).

The owner subsequently explicitly authorized sending the derived states of
these 24 cases to TypeSafe for 336 Jev readings at an estimated cost below
one dollar, without an execution run or threshold change. The prepared worker
was then executed unchanged; its SHA-256 matches the frozen protocol.

## Measured replay result — do not adopt this question revision

**336/336 readings completed, zero failures, 0.188814654 USD.**
All responses name `jev-1.13.0`. The batch took 25.111 seconds at concurrency
four. The release was `d0c30f6a9a9b90ba6a7d7037ea04901352528fe1`.
Thresholds remained byte-equivalent to the preregistration; no execution run,
deployed question change, trust change or holdout change occurred.

The proposed wording eliminates approvals against the model's refusals on
this sample **by eliminating every approval**, including the positive
controls. It therefore fails the intended tradeoff. Do not ship it or lower
thresholds to compensate for it.

### Primary readings: three repetitions per case

There are 72 primary readings per arm: 4 refusal-reference cases × 3 and
20 approval-reference controls × 3. These are repeated observations on
**24 cases**, not 72 independent tasks. References are model verdicts, not
independent ground-truth correctness judgments.

- **Original questions, original reconstructed state:** 7/12 approvals
  against refusal references, 13/60 approvals on positive controls.
  Median latency 287 ms; p95 371 ms.
- **Proposed questions, same state:** 0/12 against refusals, **0/60** on
  positive controls. Median 302 ms; p95 383 ms.
- **Original questions, restored bounded state:** 9/12 against refusals,
  11/60 on positive controls. Median 282 ms; p95 349 ms.
- **Proposed questions and restored state:** 0/12 against refusals,
  **0/60** on positive controls. Median 297 ms; p95 367 ms.

All thirteen primary positive-control approvals made by the original
questions came from the eight “previous agreement” cases (13/24 readings).
The twelve controls previously deferred by Jev remained deferred with the
original questions (0/36 approvals), as expected. The proposed wording loses
the thirteen approvals still taken by the present baseline; the loss is
not merely a failure to recover already deferred work.

Including the separate option-order diagnostic, each arm contains 84
readings. Costs are 0.044142714 USD original, 0.049253778 USD questions only,
0.044767170 USD state only, and 0.050650992 USD both. Questions alone cost
about 11.6% more on these equal-sized arms and add 15 ms to the primary
median. These are request-level measurements, not end-to-end run savings.

### What happened on the four diagnostic cases

- **Spitogatos plan, event `3c7bdf59…`:** the original questions approve
  3/3 times with score 0.89–0.90. Adding the phase criterion still approves
  3/3 at 0.88–0.89; its newly explicit requirement scores 0.99 in the first
  reading. Proposed wording defers 3/3, but drops the weakest score broadly
  to 0.22–0.29 rather than isolating only the criterion.
- **Hash inventory, `02500b38…`:** original questions approve 3/3 at
  0.85–0.86. The restored source packet also approves 3/3 at 0.85–0.86.
  Questions alone defer 3/3 at 0.46–0.49; both defer 3/3 at 0.48–0.50.
- **Recovery test plan, `7a9dcacc…`:** the original questions now defer
  3/3 at 0.63–0.68. The earlier calibration's approval is not consistently
  reproduced. Restoring state approves 1/3; the proposed questions defer
  3/3 in either state.
- **Route inventory, `2b6f2987…`:** original questions approve 1/3
  at scores 0.67–0.73, versus 2/3 after state restoration. Proposed wording
  defers 3/3 in either state at 0.01–0.02.

The originally diagnosed input omissions are real, but the tested restoration
does **not** establish a fix. It does not remove either audited approval,
and its aggregate approvals against refusals increase from seven to nine.
The experiment combines binding-criterion restoration and a bounded evidence
packet design; it does not identify the separate causal effect of every
packet operation.

For the wording, the recorded distributions show a broad move toward
`omitted`/`not_shown` or insufficient positive probability, rather than a
selective correction of incomplete proof. We cannot infer Jev's internal
reasoning or attribute that move to one sentence of the multi-part revision.
The minimal definitions of “partial support” and “missing condition” remain
plausible hypotheses, but this combined rewrite is not validated.

### Repetition and option order

Forty-eight additional readings reverse Choice option order on the four
diagnostic cases and eight previous-agreement controls. Their results are
kept outside the primary counts.

With original questions, five of twelve reordered readings differ from
their case's three-reading majority; the state-restored arm also has five
of twelve. Both proposed-wording arms still defer every reordered case.
There are five cases per original-question arm whose three identical-order
readings already disagree. These observations flag order sensitivity and/or
sampling variation; the fourth reading alone cannot disentangle them.
Always deferring is not evidence that the new questions are more accurate
or better calibrated.

### Verification and disposition

The offline verifier recomputed all 336 decisions from raw answers using the
product's existing `readApproval` and frozen thresholds, matched every
recorded approval and score, checked 336 unique job IDs, 96 stable primary
case/arm request hashes, 48 reordered readings, the served model, and the
exact cost sum. No trace prompts or source contents from the new controls
were copied locally; only numeric results and identifiers were exported.

The draft [question-proposal.json](question-proposal.json) is preserved
byte-for-byte as the experiment input. Its original draft-status string
predates this measurement; the current disposition is **tested and rejected
for adoption**, as recorded here and in
[question-proposal-status.json](question-proposal-status.json).

A narrower future candidate would change only the partial-evidence and
partial-omission option definitions first, retaining the short original
instructions. That is a new hypothesis requiring its own frozen comparison,
not a conclusion established by these 336 readings. No additional paid
readings were started.

Measured artifacts:

- [All 336 numeric readings](replay-readings.ndjson).
- [Per-arm and per-case analysis](replay-analysis.json).
- [Frozen protocol](replay-preregistration.json).

Reproduce the aggregation without quota:
`node records/measurements/jev-calibration-2026-10-21/analyze-replay.mjs`.
