# Slax — document de conception (v1)

Date : 2026-10-30. Auteur du besoin : yechpa. Statut : brouillon soumis à relecture.

## 1. Intention et pourquoi

Slax est un clone de Slack. Ce n'est pas le produit qui compte, c'est la **preuve** : démontrer la capacité à **concevoir, déployer et exploiter** une application complexe, de bout en bout, avec un niveau de finition professionnel.

Contexte : yechpa termine une mission en blue team chez Integrity et prépare la suite. Le public visé est volontairement large (clients, recruteurs, pairs, investisseurs) car la direction n'est pas encore arrêtée. La vitrine doit donc se comprendre en trente secondes et résister à un examen technique approfondi.

Critères de réussite, par ordre d'importance :
1. **Aucun bug visible** sur le périmètre promis.
2. **Beau et cohérent** : une identité visuelle forte et assumée.
3. **Architecture solide et lisible** : un lecteur du dépôt comprend les choix et leurs raisons.
4. **Exploité pour de vrai** : en ligne en permanence sur `slax.yechpa.com`, supervisé, avec trois environnements et un déploiement automatisé.
5. **Complet mais léger** : mieux vaut peu de fonctions irréprochables que beaucoup de fonctions fragiles.

## 2. Objectifs, non-objectifs, anti-objectifs

### Objectifs (v1)
- **Canaux** : publics et privés ; messages en temps réel ; fils de discussion ; mentions ; réactions emoji ; édition et suppression de ses messages.
- **Messages privés** : à deux et en petit groupe, avec les mêmes capacités que les canaux. *(hypothèse de l'auteur, non contredite)*
- **Fichiers** : envoi par glisser-déposer, aperçu des images et des PDF, stockage objet, analyse antivirus à l'envoi.
- **Présence** : en ligne, absent, « en train d'écrire ».
- **Trois langues** : anglais, hébreu (droite à gauche), français.
- **Deux thèmes** avec bascule en un clic.
- **Connexion publique par Google uniquement** (OpenID Connect), sans mot de passe propre à Slax, protégée (voir §6), et **données de démo** réinitialisées automatiquement.
- **Trois environnements** (poste, dev, prod) avec chaîne de livraison automatisée (voir §7).

### Non-objectifs (v1)
- **Appels audio/vidéo et partage d'écran** : repoussés à la v2 (décision de yechpa). L'architecture ne doit pas les empêcher (voir §8).
- Recherche plein texte avancée, bots et intégrations tierces, workflows, applications mobiles natives, notifications push, SSO d'entreprise (SAML, OIDC générique), connexion par mot de passe local, connexion GitHub, courrier sortant, plusieurs espaces de travail actifs, facturation.

### Anti-objectifs (échec même si « ça marche »)
- Un bug visible dans le périmètre v1.
- Une interface générique qui ressemble à tous les clones de Slack.
- Une infrastructure lourde ou coûteuse pour ce qu'elle sert.
- Un secret, une clé ou un jeton dans le dépôt public.
- Une traduction hébraïque « plaquée » (mise en page cassée, texte mixte illisible).

## 3. Contraintes

- **Budget : le strict minimum.** Une seule machine AWS dédiée à Slax, à dimensionner au plus juste. Crédits AWS d'environ 100 $ disponibles. Les services annexes payants sont exclus sauf nécessité démontrée.
- **Dépôt GitHub public.** Aucun secret dans le code ni dans l'historique. Analyse des secrets et protection à l'envoi activées. Les secrets d'exécution vivent hors du dépôt (secrets GitHub Actions, secrets Kubernetes).
- **Tout est conteneurisé** (Docker). Kubernetes (k3s) pour dev et prod.
- **Architectures** : le serveur de dev est **amd64** ; la prod AWS est **ARM64** (famille Graviton). Toutes les images doivent exister pour les deux.
- **Pas d'ouverture de ports d'administration sur Internet.** L'administration passe par Tailscale (déjà utilisé par yechpa). Seuls 80/443 sont exposés en prod.
- **Ne pas toucher à l'instance EC2 `wa-bot`** (Francfort, t4g.small) qui héberge une autre application de yechpa.
- La machine de dev locale est dédiée : i7-6500U (2 cœurs/4 threads), 16 Go de RAM, NVMe 500 Go, Ubuntu Server 24.04 LTS, installée par yechpa.
- Domaine : `slax.yechpa.com` (sous-domaine de `yechpa.com`, que possède yechpa).

## 4. Choix techniques décidés par yechpa

- **Langages mis en avant** : PHP (cœur), Python, JavaScript, CSS « à la pointe ».
- **Docker partout, Kubernetes visé**.
- **Dépôt public sur GitHub**, passage obligatoire par GitHub pour livrer.
- **Dev sur un serveur local amd64 dédié, prod sur AWS**.
- **Thème sombre** : la « Console » (fond quasi noir, vert phosphore, monospace). **Thème clair** : le « papier listing » (bandes vert pâle des imprimantes à listing continu). Bascule en un clic. L'esprit général est celui des moniteurs d'antan.
- **Langues** : anglais, hébreu, français.
- **Appels en v2**.
- **Authentification : Google uniquement**, aucun mot de passe propre à Slax (décision de yechpa, 2026-10-30). Les autres modes de connexion sont hors v1.

## 5. Choix de l'auteur du document (à valider, pas décidés par yechpa)

- **Cœur applicatif en PHP avec Laravel** : API, comptes, canaux, permissions, journal d'audit. Temps réel avec Laravel Reverb (WebSocket).
- **Données** : PostgreSQL ; Redis pour la présence, les files d'attente et la diffusion temps réel.
- **Python** : service séparé, hors du noyau de la v1, servant de vitrine multi-services (par exemple l'analyse antivirus des fichiers et la détection d'abus). Le choix exact est laissé au bâtisseur (voir §9).
- **Interface** : application monopage en TypeScript ; CSS moderne sans framework lourd (propriétés logiques, `@layer`, variables, requêtes de conteneur).
- **Hébreu/RTL par propriétés logiques CSS** et gestion du texte bidirectionnel dans les messages (isolation `bdi`/`dir=auto` par message). Police monospace couvrant l'hébreu exigée (la plupart n'en ont pas ; en choisir une qui l'a, ou associer une police de repli visuellement cohérente).
- **Langue par utilisateur**, détectée depuis le navigateur au départ, modifiable.
- **Un seul espace de travail actif en v1**, mais le modèle de données porte déjà un identifiant d'espace pour une extension future.
- **Stockage des fichiers** : stockage compatible S3. Choix du fournisseur laissé au bâtisseur sous contrainte de budget (voir §9).
- **Supervision visible dans l'application** : état des services et journal d'audit consultables par un administrateur.
- **Chaîne de livraison** : voir §7.

## 5 bis. Arbitrages après relecture (choix de l'auteur, à vérifier)

- **Pas de courrier sortant en v1** : Google garantit l'adresse e-mail (seuls les comptes dont l'adresse est vérifiée par Google sont acceptés), donc ni SES, ni SPF/DKIM, ni vérification par lien. Les administrateurs sont désignés par une liste d'adresses Google dans la configuration (`ADMIN_EMAILS`). **Action de yechpa** : créer un client OAuth « application Web » dans Google Cloud Console (écran de consentement en production, portées `openid email profile` seulement, ce qui n'exige pas de revue de Google), avec les URI de redirection de dev et de prod ; le secret du client vit dans les secrets Kubernetes, jamais dans le dépôt.
- **Espace de démo** : tout nouvel utilisateur rejoint automatiquement l'espace unique et ses canaux publics. Les comptes inscrits par des visiteurs sont conservés 7 jours d'inactivité ; la réinitialisation nocturne ne touche que les données de démonstration et les comptes expirés. Un rôle administrateur (yechpa) dispose d'outils de modération : bannir, supprimer un message ou un fichier, verrouiller un canal.
- **Messages privés de groupe** : dans le périmètre, plafonnés à 8 personnes.
- **Identité visuelle** : conçue par le bâtisseur à partir des deux maquettes validées (Console sombre, papier listing clair) ; un point de validation par yechpa après le premier système de design et avant le développement du reste de l'interface.
- **Validation de la prod** : approbation d'un « environment » GitHub protégé. Les migrations de base suivent le schéma étendre puis contracter (toujours compatibles avec la version précédente), de sorte que le retour arrière consiste à redéployer l'image précédente sans défaire la migration.
- **Dev joignable depuis GitHub** : le workflow rejoint le réseau Tailscale avec une identité éphémère limitée par étiquette, uniquement sur la branche principale. Pas de runner auto-hébergé : sur un dépôt public, les pull requests de tiers pourraient y exécuter du code. Le dev a une URL privée en HTTPS (certificat par défi DNS), non exposée à Internet.
- **Fichiers** : 10 Mo par fichier, 100 Mo par compte, quelques Go au total, stockage S3 sur les crédits AWS avec expiration automatique des fichiers de démo. L'analyse antivirus (ClamAV, gourmande en mémoire) n'est gardée que si l'instance retenue le permet ; sinon le service Python fait la validation de contenu (type réel par signature, taille, hachage) et l'antivirus est reporté. Cet arbitrage dépend du plafond de coût (voir ci-dessous).
- **Hébreu** : couvre aussi noms d'utilisateur, noms de fichiers et dates ; les blocs de code restent de gauche à droite. Traductions faites par le bâtisseur puis relues par un humain (à confirmer qui).
- **Budget** : yechpa n'a pas fixé de plafond dur (« soyons économes et on verra »). Cible de l'auteur : environ 15 à 20 $ par mois pour la prod, une seule instance ARM dimensionnée au plus juste. Un dépassement probable est remonté à yechpa avant d'être engagé.
- **Priorité en cas de tension** (choix de l'auteur) : d'abord le noyau fonctionnel irréprochable, puis une exploitation sobre mais réelle (sauvegardes restaurées pour de vrai, retour arrière, alertes simples). Ce qui cède en premier : outils d'observation avancés, puis antivirus ClamAV (remplacé par la validation de contenu du service Python).

## Réponses de yechpa aux questions de relecture

- Plafond de coût : aucun fixé, rester économe (voir ci-dessus).
- DNS de `yechpa.com` : yechpa en a le contrôle (enregistrements A/CNAME du site seulement, plus de SPF/DKIM).
- Relecture des traductions hébraïques : yechpa lui-même.

## 6. Sécurité et protection de la démo publique

L'inscription est ouverte à tous ; la vitrine doit donc être sûre. Exigences minimales :
- Connexion Google uniquement (flux OIDC avec `state` et `nonce` vérifiés, adresse `email_verified` exigée) ; aucun mot de passe stocké ; limitation de débit sur la connexion et l'envoi de messages ; protection anti-robots discrète (Cloudflare Turnstile ou équivalent gratuit) avant de lancer le flux Google.
- Permissions vérifiées côté serveur sur chaque canal, message privé et fichier (aucune confiance dans le client).
- Fichiers : taille et types limités, analyse antivirus, jamais servis sous le même domaine d'exécution que l'application sans en-têtes de protection.
- Journal d'audit des actions sensibles.
- En-têtes de sécurité (CSP stricte, HSTS), HTTPS partout.
- Les données de démo (comptes d'essai, contenus) sont purgées/réinitialisées automatiquement ; un quota par compte limite le stockage.
- Aucune donnée personnelle réelle de yechpa ou d'Integrity dans le jeu de données.

## 7. Environnements et livraison

| Environnement | Où | Architecture | Rôle |
|---|---|---|---|
| Poste | Docker Compose, machine de yechpa | amd64 | développement quotidien, une commande pour tout lancer |
| Dev | serveur local dédié, k3s | amd64 | intégration automatique de ce qui est fusionné |
| Prod | une instance AWS dédiée, k3s, `slax.yechpa.com` | ARM64 | la vitrine publique |

Chaîne de livraison :
1. Toute modification passe par une pull request sur GitHub.
2. GitHub Actions exécute : formatage et analyse statique, tests, analyse des dépendances et des secrets, construction des images **en natif pour chaque architecture** (runners ARM de GitHub, gratuits pour un dépôt public) et publication sur GHCR (images publiques).
3. La fusion sur la branche principale **déploie automatiquement sur le dev**.
4. Une **étiquette de version** déclenche la prod après validation manuelle de yechpa, avec **retour arrière en une commande**.
5. Les manifestes sont les mêmes (Helm) avec des valeurs différentes par environnement. Les déploiements passent par Tailscale.
6. Pas de GitOps lourd (Argo CD) en v1.

Exploitation : sauvegardes automatiques de la base et vérification de restauration ; métriques et alertes légères (à définir par le bâtisseur dans le respect du budget) ; la documentation d'exploitation (runbook) fait partie des livrables.

## 8. Ce que l'architecture doit permettre plus tard (sans le construire)

- Les appels de la v2 : prévoir l'emplacement d'un serveur média et d'un serveur TURN, et l'état « en appel » dans le modèle de présence.
- Plusieurs espaces de travail.
- Un service de bots/intégrations en Python.

## 9. Laissé au bâtisseur

Découpage en services et en modules, schéma de données, protocole temps réel exact, bibliothèque de composants, outil de tests, taille exacte de l'instance AWS, fournisseur du stockage de fichiers (sous contrainte de budget minimal), choix de la police monospace compatible hébreu, stratégie de métriques, jeu de données de démo, nom des canaux de démonstration, et le rôle précis du service Python dans la v1.

## 10. Comment on saura que c'est fini

- Un parcours complet fonctionne sans erreur sur `slax.yechpa.com` dans les trois langues et les deux thèmes : connexion Google, rejoindre un canal, écrire, répondre en fil, réagir, envoyer un fichier, envoyer un message privé, voir la présence.
- L'hébreu s'affiche correctement de droite à gauche, y compris avec des mots anglais dans une phrase.
- Une modification fusionnée arrive en dev sans intervention ; une version étiquetée arrive en prod après validation ; un retour arrière est démontré.
- Les tests automatiques passent dans la chaîne de livraison ; aucun secret dans le dépôt.
- Une documentation d'architecture et d'exploitation accompagne le dépôt.

## 11. Notes

- Ce document n'est pas versionné : `/home/yechpa/Documents/slax` n'est pas encore un dépôt Git. Il le deviendra au moment de créer le dépôt GitHub public.
