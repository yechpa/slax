# Slax — module « Listes de tâches » : document de conception

Date : 2026-11-08. Auteur du besoin : yechpa. Statut : brouillon soumis à relecture.

Les décisions de yechpa sont dites telles quelles. Tout ce qui est marqué **(mon choix)** vient de
l'auteur du document : à vérifier, pas décidé par yechpa.

## 1. Intention et pourquoi

Slack n'a pas de tâches. Dans Slax, on veut pouvoir noter ce qu'on a à faire, voir ce que les
autres ont à faire, et confier une tâche à quelqu'un, sans quitter l'application de discussion.

C'est un module de plus à côté des canaux et des messages privés, pas un gestionnaire de projet.
Il doit tenir les mêmes critères que le reste de Slax (spec v1, §1) : aucun bug visible, beau et
cohérent avec les deux thèmes, trois langues dont l'hébreu de droite à gauche, finition de démo
publique.

## 2. Ce que fait le module (décidé par yechpa)

- **Plusieurs listes par personne.** Chaque personne crée des listes nommées (« Courses »,
  « Boulot »…) et y range ses tâches.
- **Public ou privé, tâche par tâche.** À la création d'une tâche, on choisit public ou privé.
  - Une tâche **publique** est visible de tout le monde dans le workspace. On peut consulter les
    tâches d'un collègue.
  - Une tâche **privée** n'est visible que de son auteur.
- **Assigner à quelqu'un d'autre.** Une tâche assignée à un collègue arrive chez lui. Si elle est
  privée, seuls l'auteur et la personne assignée la voient. La personne assignée peut la cocher
  comme terminée.
- **Déplacer entre listes.** On peut déplacer une tâche d'une liste à une autre. En particulier,
  une tâche reçue (vue « Assignées à moi ») peut ensuite être rangée dans une de ses propres listes.

## 3. Non-objectifs et anti-objectifs

Non-objectifs (v1 du module) : dates d'échéance, rappels, tâches récurrentes, sous-tâches,
commentaires sur une tâche, étiquettes, assignation à plusieurs personnes, partage d'une liste
entre plusieurs personnes, recherche, glisser-déposer, création d'une tâche depuis un message,
vue des tâches privées par un administrateur.

Anti-objectifs (échec même si « ça marche ») :
- Une tâche privée qui apparaît, même en partie (titre, nombre, nom de liste, notification,
  charge utile temps réel), chez quelqu'un qui n'est ni son auteur ni la personne assignée.
- Un titre de tâche dans une notification push (règle existante : jamais le texte, voir
  `docs/known-limitations.md`, « Push notifications »).
- Une tâche qui atterrit dans la liste de quelqu'un d'autre que la personne assignée.
- Un bug visible, un écran cassé en hébreu ou en thème clair.

## 4. Contraintes

- On s'appuie sur ce qui existe : Laravel (contrôleurs, politiques, ressources JSON, tests
  Pest), PostgreSQL, Reverb pour le temps réel, notifications Web Push existantes, frontend
  Preact (signals) avec ses stores, son routeur et ses styles par jetons, i18n `en`, `he`, `fr`.
- Même rigueur d'accès que les canaux : une tâche qu'on n'a pas le droit de voir répond **404**,
  jamais 403, pour ne pas révéler son existence (`ChannelPolicy`).
- La réinitialisation nocturne de la démo (`slax:demo-reset`) doit couvrir les tâches (voir §8).
- Les environnements dev et prod ne changent pas. La livraison en prod reste faite par yechpa ;
  la migration passe par le job de migration existant.

## 5. Modèle (mon choix)

Deux tables, avec `workspace_id` comme les autres, dans une nouvelle migration.

**`task_lists`** : `id`, `workspace_id`, `user_id` (propriétaire), `name` (≤ 60), `position`,
horodatages. Une liste est personnelle : seule la personne propriétaire la renomme, la réordonne
ou la supprime.

**`tasks`** : `id`, `workspace_id`, `creator_id`, `assignee_id`, `list_id` (nullable), `title`
(≤ 200 caractères, sans notes ni description), `visibility` (`public` | `private`),
`completed_at` (nullable), `position`, horodatages.

Règles qui tiennent le modèle :
- Une tâche créée pour soi a `assignee_id = creator_id`.
- `list_id`, s'il est renseigné, désigne **toujours une liste de la personne assignée**. Changer
  de personne assignée remet `list_id` à vide.
- **« Assignées à moi »** = les tâches dont je suis la personne assignée et qui n'ont pas de liste.
  C'est la boîte de réception : une tâche reçue y arrive, et la ranger dans une de mes listes
  l'en retire. Si une tâche est réassignée à son auteur, elle revient aussi dans cette vue.
- **« Assignées par moi »** = les tâches que j'ai créées et qui sont assignées à quelqu'un d'autre.
  Sans cette vue, l'auteur perdrait de vue ce qu'il a confié.
- Plafonds : 50 listes par personne, 500 tâches par liste (erreur claire au-delà).

## 6. Qui voit et qui peut faire quoi (mon choix)

| Action | Qui peut |
|---|---|
| Voir une tâche publique | tout membre non banni du workspace |
| Voir une tâche privée | son auteur et la personne assignée |
| Créer une tâche pour soi | tout le monde (dans une de ses listes) |
| Créer une tâche pour un collègue | tout le monde ; la tâche arrive dans « Assignées à moi » du collègue |
| Modifier le titre, la visibilité, réassigner, supprimer | l'auteur |
| Cocher / décocher | l'auteur et la personne assignée |
| Déplacer entre listes (ou remettre dans « Assignées à moi ») | la personne assignée, vers ses propres listes |
| Créer, renommer, réordonner, supprimer une liste | sa propriétaire |

Supprimer une liste supprime-t-elle ses tâches ? **Non, sauf celles dont la propriétaire est
aussi l'auteur** ; les tâches reçues d'un autre retournent dans « Assignées à moi » plutôt que de
disparaître sous les pieds de leur auteur. (mon choix)

Consulter les tâches d'un collègue : sa page montre, groupées par liste, les tâches dont il est la
personne assignée **et que je peux voir** (publiques, plus les privées que j'ai créées pour lui).
Une liste sans aucune tâche visible pour moi n'apparaît pas. Le nom d'une liste est donc visible
dès qu'elle contient une tâche publique.

Les administrateurs n'ont pas d'accès particulier aux tâches privées.

## 7. Interface (mon choix, à affiner au plan)

- Une rubrique « Tâches » dans la barre latérale, sous les canaux : « Assignées à moi » (avec le
  nombre de tâches à ranger), « Assignées par moi », mes listes, un bouton « Nouvelle liste », et
  un lien « Tâches des autres » qui ouvre le sélecteur de personnes existant.
- Routes du frontend : `/tasks/inbox`, `/tasks/by-me`, `/tasks/l/:id`, `/tasks/u/:userId`.
- À la création d'une tâche : titre, choix **public / privé** (obligatoire et visible ; valeur de
  départ **privé**, plus sûre en cas de clic distrait), personne assignée (moi par défaut).
- Une tâche s'ouvre sur un menu : renommer, changer la visibilité, assigner à…, déplacer vers…,
  supprimer, selon les droits du §6. Le déplacement et l'assignation passent par ce menu (pas de
  glisser-déposer), ce qui marche au doigt, au clavier et en hébreu.
- Les trois langues, de droite à gauche en hébreu (propriétés logiques CSS), les deux thèmes,
  l'écran étroit (tiroir existant).

## 8. Temps réel, notifications, démo, droits

- **Temps réel.** Quand une tâche change, un événement `task.changed` part sur le canal privé
  `App.Models.User.{id}` de l'auteur et de la personne assignée, avec les seuls identifiants
  (même schéma que `ChannelAdded`) ; le client recharge par REST, où l'autorisation s'applique.
  Les pages de collègues se rechargent à l'ouverture et à la reprise de l'onglet, comme la liste
  des canaux.
- **Notification push.** Une assignation à quelqu'un d'autre (création ou réassignation) déclenche
  un push du nouveau type `task`, avec le nom de l'auteur et une ligne générique, jamais le titre
  (`PushPayload`, `lang/{en,he,fr}/push.php`). Rien pour une tâche qu'on s'assigne à soi-même.
- **Démo.** `slax:demo-reset` supprime les listes et les tâches créées par les comptes de démo ;
  une tâche d'un compte `member` ou `seed` assignée à un compte de démo supprimé revient à son
  auteur, dans « Assignées à moi ». Même règle à la suppression ou à l'effacement d'un compte :
  ses tâches créées partent, celles qu'on lui avait confiées retournent à leur auteur. Le
  `DemoSeeder` ajoute quelques listes et tâches d'exemple (publiques et privées) pour que la
  démo ne soit pas vide.
- **Débit.** Limitation de débit sur les écritures, dans le style des autres (`throttle:messages`).
- **Journal d'audit.** Pas d'entrée pour les tâches.

## 9. Tests et documentation (mon choix)

- Tests Pest : la matrice complète du §6 (en particulier les 404 sur le privé, les plafonds, le
  rangement d'une tâche reçue, la réassignation, la suppression de liste), les charges utiles
  temps réel et push sans titre, la réinitialisation de la démo.
- Tests Vitest pour les stores et les composants ; un parcours Playwright (créer, assigner,
  ranger, vue d'un collègue) et une vérification en hébreu.
- Mise à jour de la documentation : README (liste des fonctions), architecture, guide de la
  famille, recette, limites connues.

## 10. Précisions après relecture (mon choix)

Un relecteur indépendant a posé ces questions ; je les ai tranchées moi-même, sans changer ce que
tu as décidé. À vérifier.

- **Tâches sans liste sur la page d'un collègue.** Elles apparaissent dans un groupe « Sans liste »,
  avec la même règle de visibilité que les autres : publiques pour tout le monde, privées pour
  l'auteur et la personne assignée seulement.
- **Personne sans liste.** À la première utilisation, une liste « Mes tâches » est créée
  automatiquement (renommable, supprimable). Une tâche créée pour soi est toujours dans une liste.
- **Refuser une tâche reçue.** La personne assignée peut **la rendre à son auteur** : elle revient
  à l'auteur, dans « Assignées à moi » de celui-ci, et l'auteur est prévenu comme pour une
  assignation. L'auteur reste libre de modifier, rendre publique ou supprimer une tâche, même
  rangée dans la liste de l'autre. « Assignées à moi » plafonne à 200 tâches sans liste ; au-delà,
  on ne peut plus en assigner à cette personne (erreur claire). Le débit des assignations suit la
  limite d'écriture existante.
- **Tâches terminées.** Elles restent dans leur liste, en bas, barrées, sous un repli « Terminées ».
  Elles comptent dans le plafond de 500. Une tâche terminée sans liste sort du compteur « à ranger »
  mais reste dans « Assignées à moi ». Elles s'affichent aussi sur la page d'un collègue (si
  visibles) et dans « Assignées par moi ».
- **Comptes bannis.** Un compte banni n'est pas proposé dans le sélecteur d'assignation, sa page
  de tâches n'est plus consultable, et aucun push ne lui est envoyé. Le bannissement ne modifie
  aucune donnée : ses tâches et celles qu'on lui a confiées reviennent telles quelles si le ban est levé.
- **Réinitialisation de la démo.** Elle supprime toutes les listes appartenant à un compte de démo
  (même s'il survit) et toutes les tâches créées par un compte de démo, même assignées à un compte
  `member` ou `seed` : c'est du contenu de visiteur, comme ses messages. Une tâche créée par un
  `member` ou un `seed` qui se trouvait dans une liste de démo supprimée revient à son auteur, dans
  « Assignées à moi ». Même règle pour une liste supprimée à la main (§6) : seules les tâches dont
  la propriétaire est l'auteur disparaissent avec elle. Les tâches d'exemple du `DemoSeeder` sont
  recréées sans doublon (idempotent).
- **Divers.** Une page `/tasks/l/:id` qui n'est pas la tienne répond 404. En cas de réassignation,
  l'ancienne personne assignée reçoit aussi `task.changed`. Le push `task` ouvre
  `/tasks/inbox`. Les tâches s'ordonnent par `position` (pas d'action pour les réordonner en v1,
  seules les listes se réordonnent).

## 11. Laissé au bâtisseur

L'ordre des écrans, l'apparence exacte des listes et des cases à cocher dans les deux thèmes, le
nom précis des routes d'API (dans le style de `/api/v1`), la forme des tests, le découpage en
étapes livrables.
