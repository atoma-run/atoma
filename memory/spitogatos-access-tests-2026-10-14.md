---
name: spitogatos-access-tests-2026-10-14
description: "Full log of the 2026-10-14 Spitogatos access tests for the Attica collector (CloudFront 403, NordVPN, reverse SOCKS, hCaptcha); summary in spitogatos-vpn-probe"
metadata:
  type: project
---

# Spitogatos — état des essais d’accès au 14 octobre 2026

Compte rendu interne des essais réalisés pour le projet **Attica property
flipping collector**. Toutes les heures ci-dessous sont en **UTC**.

## État actuel

Une annonce a été affichée et capturée dans le navigateur local du Mac.
Son import hors ligne fonctionne dans le dépôt du collecteur. En revanche,
aucune des configurations testées sur `atoma.run` n’a récupéré cette annonce :
les réponses observées restent des **403 CloudFront**, y compris avec
Puppeteer derrière une sortie NordVPN grecque.

L’isolation du VPN a été vérifiée : seul le conteneur de test utilise NordVPN.
L’adresse IP, la route par défaut et la configuration DNS de l’hôte sont restées
identiques pendant les mesures. Aucun VPN permanent ni cron Spitogatos n’est
actuellement activé par ces essais.

## Cible et périmètre

- Fiche de référence : <https://www.spitogatos.gr/en/property/1120870232>.
- Page d’accueil testée séparément : <https://www.spitogatos.gr/en>.
- Découverte envisagée : `/robots.txt` et `/sitemap.xml`.
- Fiche observée localement : appartement de 55 m² à 130 000 €, à Exarcheia,
  Athens–Center. L’identifiant affiché sur la page est `20870232` ; celui de
  l’URL est `1120870232`.
- Objectif : récupérer au moins une fiche depuis **Puppeteer sur atoma.run**,
  puis seulement envisager une collecte régulière. Le navigateur local sert
  de témoin de fonctionnement, pas de solution d’hébergement retenue.

## Essais du 13 octobre 2026

### Navigateur local : une fiche réellement accessible

Entre **10:25:18 et 10:26:02**, le navigateur local a affiché la fiche avec son
prix, sa surface, ses caractéristiques et une plage d’adresses publiée par
l’annonceur. Aucun login Spitogatos, proxy, import de cookies ou traitement de
CAPTCHA n’a été utilisé pour cet essai.

Une sélection du DOM rendu a été conservée. Il ne s’agit ni du corps HTTP
complet ni d’une archive complète de la page. Le statut HTTP n’étant pas
exposé par l’outil de contrôle utilisé, il est enregistré comme **inconnu**,
et non comme un 200 supposé.

L’import de cette capture produit une annonce dans des exports dédiés, sans
modifier les 27 annonces xe.gr déjà conservées. Il prouve le fonctionnement
de l’extraction et de l’import, pas celui d’une acquisition automatique depuis
le serveur.

### Collecte HTTP dans Atoma

Le run `2c628a5b-ec3b-4c7a-bb36-f0776312b666` s’est terminé naturellement en
état `partial`, sans annonce Spitogatos récupérée. La tentative conservée sur
`https://www.spitogatos.gr/robots.txt`, à **10:28:57**, renvoie un **403** et
un document CloudFront de **919 octets**. Les 390 événements du run ont été
parcourus jusqu’à la fin lors de l’analyse.

### curl local, sans imitation de navigateur

Avec curl 8.7.1 sur macOS, la fiche et `/sitemap.xml` renvoient un **405** avec
une page « Pardon Our Interruption ». Le nouvel essai de la fiche à
**10:42:25** reproduit cette réponse.

Le contenu d’un sitemap XML n’a donc pas été obtenu. Son existence et son
utilité pour découvrir des liens ne sont pas établies par ces essais.
Même accessible, un sitemap ne démontrerait pas que les fiches sont lisibles.

### curl depuis l’hôte atoma.run

À **10:44:22**, curl 8.14.1 sous Linux, exécuté directement par SSH hors du
runtime Atoma, reçoit un **403 CloudFront**, de **919 octets**.
Le refus est ainsi reproductible sans passer par les outils ni le sandbox
du moteur Atoma.

### User-Agent de navigateur

En utilisant un User-Agent Chrome 130 sur macOS :

- **Local, 10:47:15 :** HTTP **200**, mais toujours une page de protection
  de **2 752 octets**, sans les données de l’annonce.
- **Serveur, 10:47:16 :** HTTP **403 CloudFront**, de **919 octets**.

Un statut 200 ne constitue donc pas à lui seul un succès de collecte.

### En-têtes de navigateur plus complets

À **10:49:31**, un essai local ajoute notamment `Accept`, `Accept-Language`,
`Sec-Fetch-*`, `sec-ch-ua*`, `Priority` et `Upgrade-Insecure-Requests`, avec
HTTP/2 et compression.

Résultat : **200**, mais la même page de protection de **2 752 octets**.
Son SHA-256 est
`2574176670f10605147ae86671c8ca92b00632c40fe9232cfb47a6a72102d4a2`.

### Empreinte TLS/HTTP2 Chrome avec curl_cffi

Un unique test local explicitement autorisé a utilisé `curl_cffi 0.16.3`,
avec `impersonate="chrome"`, à **10:52:04**. Aucun proxy, cookie importé ou
traitement de CAPTCHA n’a été ajouté.

Résultat : **200**, même taille et même SHA-256 que la page de protection
précédente. Reproduire ces caractéristiques du client HTTP n’a pas suffi à
récupérer la fiche. Ce test n’a pas été réalisé sur le serveur.

### Puppeteer headless sur atoma.run

À **10:56:36**, Chrome **152.0.7977.82**, piloté par Puppeteer avec un profil
neuf, ouvre la fiche : **403 CloudFront**.

Preuves sur le serveur : `/tmp/spitogatos-browser-probe-FL6hjc/`.

### Puppeteer avec affichage virtuel Xvfb

Le navigateur est ensuite lancé avec `headless: false`, sous un serveur
Xvfb temporaire authentifié, sans écoute TCP :

- **11:03:04 :** ouverture directe de la fiche, **403 CloudFront**.
- **11:04:18 :** ouverture préalable de la page d’accueil, **403 CloudFront**.
  L’essai s’arrête à l’accueil sans poursuivre vers la fiche.

Preuves respectives sur le serveur :
`/tmp/spitogatos-headed-probe-hx8owmts/` et
`/tmp/spitogatos-headed-probe-n__znxjp/`.

Ces essais n’utilisent ni plugin stealth ni proxy. Les navigateurs, profils
temporaires et processus Xvfb ont été nettoyés. La préparation a installé
`x11-xkb-utils` et ses dépendances système ; les autres composants Xvfb ont
été extraits dans un répertoire temporaire.

## Essai NordVPN isolé du 14 octobre 2026

### Montage testé

Un conteneur Gluetun se connecte à NordVPN en OpenVPN UDP, avec sélection
de serveurs en Grèce. Un conteneur Puppeteer distinct partage son espace
réseau. Les identifiants de service NordVPN sont montés dans Gluetun seulement.
Aucun port n’est publié et aucun routage VPN global n’est installé sur l’hôte.

Le navigateur réutilise une image worker existante, avec Chromium
**154.0.8037.92** : utilisateur non privilégié, système de fichiers racine en
lecture seule, capacités supprimées et ressources bornées. Chromium est lancé
avec `--no-sandbox` à l’intérieur de ce conteneur ; ce paramètre fait partie
des conditions de cet essai et diffère des premiers essais sur l’hôte.

### Résultat de l’accès

À **03:38:50**, le navigateur mesure son IP de sortie avant de demander la
fiche : **186.247.46.153**. La sonde HTTPS vers une adresse IP directe confirme
aussi cette sortie VPN.

La fiche renvoie malgré cela **HTTP 403**, avec le titre
`ERROR: The request could not be satisfied` et le titre principal
`403 ERROR`. Aucune donnée d’annonce n’est récupérée.

Identifiant de réponse CloudFront conservé :
`r6zB10QAx9sFNl7I516fbaYg951U2qLENvTONJ-x182pqcI50oy-0A==`.

### Vérification de l’isolation et de la panne

Avant, pendant, pendant la simulation de panne et après le test :

- IP publique de l’hôte : **46.225.4.14**.
- Route par défaut : `default via 172.31.1.1 dev eth0 proto dhcp src 46.225.4.14 metric 1002`.
- SHA-256 de `/etc/resolv.conf` :
  `f28c60667714934a691cebbee49061663e813402e68066e2db4afe42008f66fd`.

La simulation consiste à figer uniquement le conteneur VPN avec
`docker pause`. Une nouvelle sonde dans son espace réseau échoue alors en DNS
(`EAI_AGAIN`), et une requête HTTPS vers `1.1.1.1`, qui fonctionnait avant,
expire. L’hôte conserve sa connectivité normale.

Cela établit l’absence de repli direct observé dans **cette simulation bornée**.
Ce n’est pas une validation exhaustive de toutes les pannes possibles, des
fuites DNS ou de l’isolation de tous les services applicatifs.

### Nettoyage et incident de la sonde

Le test se termine à **03:39:08**. Tous ses conteneurs et son réseau Compose
sont supprimés ; leur absence est vérifiée. La configuration, les scripts,
l’image Gluetun et les fichiers privés d’identifiants restent sur le serveur.

Deux tentatives préparatoires avaient connecté le VPN mais s’étaient arrêtées
avant toute requête Spitogatos : la sonde Node appelait `Response.status`
comme une méthode au lieu de lire sa propriété. Cette erreur a été corrigée.
Ces deux arrêts ne sont pas comptés comme des refus supplémentaires du site.

## Essais locaux du 14 octobre 2026 : deux couches de protection

Tous les essais ci-dessous tournent sur le Mac, donc sur l’IP résidentielle
qui avait affiché la fiche le 13 octobre, avec le Puppeteer du dépôt
(Chrome for Testing 152) et un profil neuf. Le script de sonde est
temporaire et n’a pas été conservé dans le dépôt.

- **robots.txt (curl, UA Chrome) : 200.** Les fiches ne sont pas interdites
  aux agents génériques ; seules la recherche par carte, `mySpitogatos` et
  les rapports annuels le sont. Un index sitemap est déclaré :
  `https://www.spitogatos.gr/xml_sitemap/index/sitemapIndex_gr.xml`.
  Sa lecture avec curl renvoie **200 mais la page de protection de 2 752
  octets**, identique à celle de la fiche.
- **Puppeteer headless, UA par défaut (`HeadlessChrome/152`) : 403
  CloudFront**, en 329 ms, 923 octets, sans cookie. C’est la même réponse
  que sur le serveur, obtenue cette fois depuis l’IP résidentielle.
- **Puppeteer headless, UA réécrit en `Chrome/152` : 200.** CloudFront
  laisse passer ; la page renvoyée est la page de protection, le cookie
  `reese84` est posé, puis la page affiche un **CAPTCHA** (« After completing
  the CAPTCHA below, you will immediately regain access »).
- **Puppeteer fenêtré, UA par défaut (`Chrome/152`) : 200**, même page de
  protection et même CAPTCHA.

### Lecture

Le refus se fait en **deux couches distinctes** :

1. **CloudFront / WAF (403, 919–923 octets).** Déclenché par le User-Agent
   `HeadlessChrome` même depuis une IP résidentielle, et par l’IP d’hébergement
   du serveur même avec un User-Agent normal (curl 10:47:16 et Chrome fenêtré
   11:03:04 le 13 octobre). L’essai NordVPN du 14 octobre était headless ; son
   User-Agent n’a pas été enregistré dans les preuves, donc il n’isole pas la
   variable IP : le 403 observé peut venir du seul User-Agent.
2. **Imperva / Distil (« Pardon Our Interruption », script `reese84`).**
   Atteint seulement une fois la couche 1 passée. Il laisse passer le Chrome
   du Mac avec son profil habituel, mais classe comme bot un Chrome for
   Testing piloté par Puppeteer, fenêtré ou non, et exige un CAPTCHA.

Conséquence : changer d’IP ne suffit pas, et un proxy résidentiel seul ne
suffirait pas non plus. Les en-têtes seuls ne suffisent pas non plus, ce que
l’essai `curl_cffi` avait déjà montré pour la couche 2.

## Essai local du 14 octobre 2026 : hCaptcha résolu une fois, profil persistant

Un vrai Google Chrome **155.0.8059.40** est lancé sur le Mac avec un profil
neuf dédié et `--remote-debugging-port`, sans drapeau d’automatisation
(`navigator.webdriver` vaut `false`). Ouverte sans débogueur attaché, la fiche
affiche la page Imperva avec un **hCaptcha** « I am human ». Le cookie
`reese84` posé expire le **13 novembre 2026**, soit 30 jours.

Le propriétaire coche le hCaptcha une fois, à la main. Ensuite, Puppeteer
attaché par CDP à ce même Chrome obtient, à quelques secondes d’intervalle :

- la fiche : **200**, 1,4 Mo, titre « Sale, Apartment, 55m² Exarchia »,
  prix `130,000` présent ;
- l’index sitemap : **200**, 99 entrées `<loc>`, dont
  `sitemap/gr/sale/residential-apartment.xml` ;
- la liste « Homes for sale: Athens - Center » : **200**, 1,6 Mo.

Chrome est ensuite fermé puis relancé sur le même profil : la fiche revient
en **200** avec ses données, le cookie `reese84` est conservé.

### Lecture

L’accès automatisé fonctionne dès qu’un humain a résolu le challenge une
fois dans un profil persistant, ce que la page Imperva demande explicitement.
Les conditions mesurées sont : vrai Chrome (pas Chrome for Testing), profil
conservé, User-Agent non headless, IP résidentielle, cadence lente. Le
pilotage par CDP n’est pas détecté une fois le challenge résolu.

### Montage retenu pour atoma.run

1. Sortie résidentielle pour le seul navigateur collecteur : tunnel SOCKS
   inversé `ssh -N -R 1080 mgf@atoma.run` depuis le Mac, et Chrome lancé
   avec `--proxy-server=socks5://127.0.0.1:1080`. Aucun routage global.
2. Vrai Chrome, sous Xvfb, profil persistant hors de `/tmp`, sans UA
   headless ; au premier lancement le propriétaire résout le hCaptcha via
   un relais d’écran. Le jeton vaut 30 jours ; prévoir la re-résolution.
3. Vérifier chaque fiche sur la présence du prix et de la surface, jamais sur
   le seul statut HTTP ; cadence humaine.

Non testé : la même séquence sur le serveur à travers le tunnel. L’accès SSH
a été refusé à l’agent pendant cette session.

## Essai serveur du 14 octobre 2026 : la fiche récupérée depuis atoma.run

Montage réalisé sur `atoma.run`, dans `~/.config/atoma-spitogatos-collector/` :

- tunnel SOCKS inversé ouvert depuis le Mac (`ssh -N -R 1080 mgf@atoma.run`) ;
  `api.ipify.org` répond **46.225.4.14** en direct et **31.217.169.71**
  (l’IP du Mac) via le tunnel ;
- curl avec UA Chrome sur la fiche : **403 CloudFront en direct**, **200 page
  Imperva via le tunnel**. La couche CloudFront est donc bien l’IP du serveur ;
- vrai Google Chrome **152.0.7977.82** sous Xvfb (`xvfb` installé par le
  propriétaire), profil persistant `profile/`, `--proxy-server=socks5://127.0.0.1:1080`,
  CDP sur `127.0.0.1:9223` (`start-chrome.sh`) ; UA `Chrome/152` sans
  `Headless` ;
- hCaptcha résolu une fois par le propriétaire via `chrome://inspect` de son
  Chrome, derrière `ssh -L 9223:127.0.0.1:9223` ;
- `fetch.mjs` (puppeteer-core 25.9 attaché par CDP) obtient ensuite :
  la fiche **200**, 1,1 Mo, titre « Sale, Apartment, 55m² Exarchia », prix
  `130,000` présent ; l’index sitemap **200**, 99 entrées.

Rappel sur l’essai VPN : `browser.mjs` lançait `headless:true` sans
réécriture d’UA, donc son 403 est attribuable au seul User-Agent.

Persistance vérifiée sur le serveur : après arrêt du processus Chrome
(`kill`, port CDP fermé) et relance sur le même profil, la fiche revient en
**200** avec ses données, sans nouveau hCaptcha. Attention : un Ctrl-C sur la
session SSH ne tue pas Chrome, et une relance se contente de lui passer la
main (« Opening in existing browser session »). Non mesuré sur le serveur :
une page de liste. Ce montage est une
expérience opérateur : Chrome vit dans la session SSH du propriétaire, le
tunnel aussi. Une intégration produit doit passer par les contrats
launcher/worker, et prévoir la re-résolution mensuelle du hCaptcha.

## Essai NordVPN refait avec la seule variable IP, 14 octobre 2026 (soir)

Même requête que le curl via tunnel qui obtient 200 : `fetch` Node avec UA
`Chrome/152`, `Accept` et `Accept-Language`, sans navigateur, exécuté dans
l’espace réseau du conteneur Gluetun (sortie NordVPN Grèce
**186.247.178.171**, confirmée par `api.ipify.org`).

Résultat : fiche **403 CloudFront, 919 octets**. La sortie NordVPN est donc
refusée au niveau CloudFront pour l’IP elle-même, indépendamment du
navigateur. NordVPN ne peut pas remplacer la sortie résidentielle. Le
conteneur a été supprimé après l’essai ; l’IP de l’hôte est inchangée.

## Conclusions et questions ouvertes

- **Acquis :** la fiche était accessible dans le navigateur local, et une
  capture réelle a été importée.
- **Acquis :** le refus serveur existe aussi hors du runtime Atoma.
- **Acquis :** les en-têtes HTTP seuls et l’essai local `curl_cffi` n’ont pas
  fourni l’annonce ; le mode avec affichage virtuel n’a pas résolu le 403
  serveur.
- **Acquis :** le VPN peut être limité au collecteur, mais la sortie grecque
  testée avec Puppeteer headless n’a pas permis d’accéder à la fiche.
- **Non établi :** la règle exacte du refus. L’IP, sa réputation, l’empreinte
  du navigateur, les cookies, un challenge JavaScript ou une combinaison de
  facteurs restent des hypothèses. Le document CloudFront seul ne tranche pas.
- **Non établi :** l’accès via sitemap, la pagination, le débit soutenable
  et la fiabilité d’un cron quotidien.
- **Établi le 14 octobre (soir) :** UA non headless derrière NordVPN → 403
  CloudFront. L’IP NordVPN est bloquée en tant que telle ; seule une sortie
  résidentielle (tunnel vers le Mac, mesuré) passe la couche CloudFront.
- **Établi le 14 octobre :** depuis l’IP résidentielle, un profil neuf reçoit
  un hCaptcha ; une fois résolu à la main, Puppeteer attaché par CDP lit la
  fiche, le sitemap et une liste, et l’accès survit au redémarrage de Chrome.

Une reprise doit conserver une fiche de référence, mesurer la sortie réseau,
et vérifier la présence de données d’annonce plutôt que le seul statut HTTP.
Il faut modifier une variable à la fois pour que le résultat soit interprétable.
Les scripts opérateur actuels sont une expérience ; toute intégration produit
doit respecter les contrats launcher/worker existants.

## Preuves et emplacements

Le dépôt du collecteur est
[`mgtf/atoma-attica-property-flipping`](https://github.com/mgtf/atoma-attica-property-flipping),
commit de l’import vérifié
[`0fe38ba695222ddaaf86fde58fff42bde278ff63`](https://github.com/mgtf/atoma-attica-property-flipping/commit/0fe38ba695222ddaaf86fde58fff42bde278ff63).
Il contient la capture sélectionnée et son manifeste sous
`evidence/spitogatos/`, ainsi que les exports sous `data/spitogatos-browser/`.
SHA-256 de la capture :
`5933b107fa92e80d86077c001ed12bd8fcb8b45efa785c4cb28a75ab85616d38`.

Le run partiel appartient au projet Atoma
`07864f7c-d8f2-4023-9fca-afd8a7a51e52` et conserve notamment
`evidence/spitogatos-access.json` et `spitogatos-responses.jsonl`.

Pour le test VPN final :

- Serveur : `/tmp/spitogatos-vpn-probe-nrfzt9w1/summary.json` et
  `browser/result.json`, `browser/page.html`, `browser/page.png`.
- Copie locale non secrète : `/tmp/atoma-spitogatos-vpn-evidence/`.
- Configuration opérateur sur le serveur :
  `~/.config/atoma-spitogatos-vpn/compose.json`, `run.py`, `browser.mjs`.
- Image Gluetun épinglée :
  `qmcgaw/gluetun@sha256:2733bb22b27e3efa7a9f2cef9057ec12791b8b225793fcd3dbfd0508404dfc25`.
- Image worker utilisée :
  `sha256:2145d8548bc600ee95b8a3111844df890bf48ea3cb2d3013688312e49d9d78b8`.

Les chemins `/tmp/` sont temporaires et ne constituent pas une archive
durable. Ce document conserve la synthèse des mesures ; les preuves brutes
temporaires devront être archivées si leur conservation à long terme est
nécessaire. Aucun identifiant NordVPN n’est inclus ici.
